/**
 * Ported from violet/lib/script/script_manager.dart
 *
 * Resolves a hitomi gallery ID into image URLs by:
 * 1. Evaluating gg.js routing data
 * 2. Fetching gallery metadata
 * 3. Building image and thumbnail URLs
 */

import type { ImageList } from '@violet-web/shared';
import { getContentDb } from './content-db.js';
import { getEhCookie } from './eh-cookie-store.js';
import { refreshEhCookieAfterAuthFailure } from './eh-auto-login.js';
import { resolveEhMpvGalleryPages } from './eh-mpv.js';
import { MediaError, httpMediaError, ehPageError, preferMediaError, publicMediaError } from './media-error.js';

const BASE_DOMAIN = 'gold-usergeneratedcontent.net';
const GG_JS_URL = `https://ltn.${BASE_DOMAIN}/gg.js`;
const GG_CACHE_TTL_MS = 30 * 60 * 1000;
const GG_REFRESH_RETRY_MS = 60 * 1000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EH_REQUEST_TIMEOUT_MS = 15_000;

interface GalleryFile {
  hash?: string;
}

interface GalleryInfo {
  files?: GalleryFile[];
}

interface GgRouting {
  b: string;
  mList: Set<string>;
  o1: number;
  o2: number;
}

export interface EhGalleryMetadata {
  ehash: string;
  files: number | null;
  thumbnail: string | null;
}

class UpstreamHttpError extends MediaError {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(httpMediaError(status).code);
  }
}

class EhAuthenticationError extends MediaError {
  constructor(_message: string) { super('AUTH_REQUIRED'); }
}

let routingCache: GgRouting | null = null;
let latestUpdate = 0;
let latestRefreshAttempt = 0;
let routingRefresh: Promise<void> | null = null;
const pendingGalleries = new Map<number, Promise<ImageList>>();

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(EH_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new UpstreamHttpError(url, res.status);
    }
    return await res.text();
  } catch (error) {
    if (publicMediaError(error).code === 'NETWORK_ERROR') throw new MediaError('NETWORK_ERROR');
    throw error;
  }
}

function getEhMetadata(id: number): EhGalleryMetadata | null {
  const row = getContentDb()
    .prepare('SELECT EHash, Files, Thumbnail FROM HitomiColumnModel WHERE Id = ?')
    .get(id) as { EHash?: string | null; Files?: number | null; Thumbnail?: string | null } | undefined;
  const ehash = row?.EHash?.trim();
  if (!ehash) return null;
  return {
    ehash,
    files: row?.Files ?? null,
    thumbnail: row?.Thumbnail ?? null,
  };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function extractEhImagePages(html: string, id: number, origin: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const pattern = /href=["']((?:https?:\/\/(?:e-hentai|exhentai)\.org)?\/s\/[^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const url = new URL(decodeHtmlAttribute(match[1]), origin).toString();
    if (!new URL(url).pathname.match(new RegExp(`/${id}-\\d+$`)) || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function extractEhThumbnails(html: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const pattern = /https:\/\/(?:[^"'\s]+\.)?(?:exhentai|ehgt)\.org\/t\/[^"'\s<>)]+/gi;
  for (const match of html.matchAll(pattern)) {
    const url = decodeHtmlAttribute(match[0]);
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

async function fetchEhGalleryPageOnce(url: string, cookie: string | null): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml',
    Referer: new URL(url).origin + '/',
  };
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(EH_REQUEST_TIMEOUT_MS),
  });
  if (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
    throw new EhAuthenticationError(`E-Hentai redirected while loading ${url}`);
  }
  if (response.status === 401) throw new EhAuthenticationError('Login required');
  if (!response.ok) throw new UpstreamHttpError(url, response.status);
  const html = await response.text();
  if (!html.includes('id="gdt"') && !html.includes("id='gdt'")) {
    const error = ehPageError(html);
    if (error.code === 'AUTH_REQUIRED') throw new EhAuthenticationError(error.message);
    throw error;
  }
  return html;
}

async function fetchEhGalleryPage(url: string): Promise<string> {
  try {
    return await fetchEhGalleryPageOnce(url, getEhCookie());
  } catch (error) {
    if (!(error instanceof EhAuthenticationError)) throw error;
    const refreshed = await refreshEhCookieAfterAuthFailure();
    if (!refreshed) throw error;
    return fetchEhGalleryPageOnce(url, getEhCookie());
  }
}

async function resolveEhGallery(id: number, metadata: EhGalleryMetadata, initialError: unknown): Promise<ImageList> {
  const expected = metadata.files && metadata.files > 0 ? metadata.files : null;
  let lastError: unknown = initialError;
  // One source order per resolution: ExH MPV -> ExH legacy -> EH.
  const hasCookie = Boolean(getEhCookie());

  if (hasCookie) {
    try {
      const mpvGallery = await resolveEhMpvGalleryPages(id, metadata.ehash);
      if (mpvGallery && mpvGallery.urls.length > 0) {
        if (expected && mpvGallery.urls.length < expected) {
          throw new Error(
            `ExHentai MPV returned ${mpvGallery.urls.length}/${expected} pages for ${id}`,
          );
        }
        const urls = expected ? mpvGallery.urls.slice(0, expected) : mpvGallery.urls;
        const fallbackThumbs = metadata.thumbnail ? [metadata.thumbnail] : [];
        return {
          urls,
          bigThumbnails: fallbackThumbs,
          smallThumbnails: [...fallbackThumbs],
        };
      }
    } catch (error) {
      lastError = preferMediaError(lastError, error);
    }
  }

  const candidates = hasCookie
    ? ['https://exhentai.org', 'https://e-hentai.org']
    : ['https://e-hentai.org'];

  for (const origin of candidates) {
    try {
      const imagePages: string[] = [];
      const thumbnails: string[] = [];
      const maxPages = expected ? Math.ceil(expected / 20) + 2 : 100;

      for (let page = 0; page < maxPages; page++) {
        const url = `${origin}/g/${id}/${metadata.ehash}/?p=${page}&inline_set=ts_m`;
        const html = await fetchEhGalleryPage(url);
        const pageLinks = extractEhImagePages(html, id, origin);
        if (pageLinks.length === 0) break;

        const known = new Set(imagePages);
        const newLinks = pageLinks.filter((link) => !known.has(link));
        if (newLinks.length === 0) break;
        imagePages.push(...newLinks);
        thumbnails.push(...extractEhThumbnails(html));
        if (expected && imagePages.length >= expected) break;
      }

      if (imagePages.length === 0) throw new MediaError('NO_IMAGES');
      if (expected && imagePages.length < expected) throw new MediaError('UPSTREAM_ERROR');
      const urls = expected ? imagePages.slice(0, expected) : imagePages;
      const fallbackThumbs = thumbnails.length > 0
        ? thumbnails.slice(0, urls.length)
        : metadata.thumbnail ? [metadata.thumbnail] : [];
      return {
        urls,
        bigThumbnails: fallbackThumbs,
        smallThumbnails: [...fallbackThumbs],
      };
    } catch (error) {
      lastError = preferMediaError(lastError, error);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to resolve E-Hentai gallery ${id}`);
}

function parseGgRouting(ggText: string): GgRouting {
  const b = ggText.match(/b:\s*(['"])([^'"]+)\1/)?.[2];
  const oMatches = [...ggText.matchAll(/o\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  if (!b || oMatches.length === 0 || oMatches.some((value) => !Number.isFinite(value))) {
    throw new Error('Invalid Hitomi routing data');
  }

  return {
    b,
    mList: new Set([...ggText.matchAll(/case\s+(\d+):/g)].map((m) => m[1])),
    o1: oMatches[0],
    o2: oMatches[oMatches.length - 1],
  };
}

async function refreshRouting(): Promise<void> {
  try {
    const nextRouting = parseGgRouting(await fetchText(GG_JS_URL));
    routingCache = nextRouting;
    latestUpdate = Date.now();
  } catch (error) {
    if (routingCache) return; // Keep the last good routing data during an outage.
    throw error instanceof MediaError ? error : new MediaError('UPSTREAM_ERROR');
  }
}

async function ensureScript(): Promise<void> {
  const now = Date.now();
  if (routingCache && now - latestUpdate < GG_CACHE_TTL_MS) return;
  if (routingCache && now - latestRefreshAttempt < GG_REFRESH_RETRY_MS) return;

  if (!routingRefresh) {
    latestRefreshAttempt = now;
    routingRefresh = refreshRouting().finally(() => {
      routingRefresh = null;
    });
  }
  await routingRefresh;
}

async function getGalleryInfo(id: number): Promise<GalleryInfo> {
  const body = await fetchText(
    `https://ltn.${BASE_DOMAIN}/galleries/${id}.js`,
    getGalleryHeadersSync(),
  );
  const json = body
    .replace(/^var galleryinfo\s*=\s*/, '')
    .replace(/;\s*$/, '');

  let parsed: GalleryInfo;
  try { parsed = JSON.parse(json) as GalleryInfo; }
  catch { throw new MediaError('UPSTREAM_ERROR'); }
  if (!parsed || !Array.isArray(parsed.files)) throw new MediaError('UPSTREAM_ERROR');
  if (parsed.files.some((file) => !file || (file.hash !== undefined && typeof file.hash !== 'string'))) {
    throw new MediaError('UPSTREAM_ERROR');
  }
  return parsed;
}

function getHashShard(hash: string): string {
  const part = hash[hash.length - 1] + hash[hash.length - 3] + hash[hash.length - 2];
  return parseInt(part, 16).toString();
}

function getServerNum(hashShard: string, routing: GgRouting): number {
  const node = routing.mList.has(hashShard) ? routing.o2 : routing.o1;
  return node + 1;
}

function buildImageUrls(files: GalleryFile[], routing: GgRouting, useAvif = false): string[] {
  const domain = useAvif ? 'a' : 'w';
  const ext = useAvif ? 'avif' : 'webp';

  return files.flatMap((file) => {
    const hash = file.hash;
    if (!hash) return [];

    const shard = getHashShard(hash);
    const serverNum = getServerNum(shard, routing);
    return [`https://${domain}${serverNum}.${BASE_DOMAIN}/${routing.b}${shard}/${hash}.${ext}`];
  });
}

function buildThumbnailUrls(files: GalleryFile[], routing: GgRouting, size: 'big' | 'small', useAvif = false): string[] {
  const firstPath = useAvif
    ? size === 'big' ? 'avifbigtn' : 'avifsmallsmalltn'
    : size === 'big' ? 'webpbigtn' : 'webpsmalltn';
  const ext = useAvif ? 'avif' : 'webp';

  return files.flatMap((file) => {
    const hash = file.hash;
    if (!hash) return [];

    const shard = getHashShard(hash);
    const serverNum = getServerNum(shard, routing);
    const domain = serverNum === 1 ? 'atn' : 'btn';
    const secondPath = hash.substring(hash.length - 1);
    const thirdPath = hash.substring(hash.length - 3, hash.length - 1);

    return [`https://${domain}.${BASE_DOMAIN}/${firstPath}/${secondPath}/${thirdPath}/${hash}.${ext}`];
  });
}

function getGalleryHeadersSync(): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
    'Accept-Language': 'en-US',
    Referer: 'https://hitomi.la/',
    'Sec-Fetch-Dest': 'image',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
    Priority: 'u=4, i',
  };
}

export async function resolveGallery(
  id: number,
  fallbackMetadata?: EhGalleryMetadata | null,
): Promise<ImageList> {
  let pending = pendingGalleries.get(id);
  if (!pending) {
    pending = resolveGalleryUncached(id, fallbackMetadata).finally(() => {
      pendingGalleries.delete(id);
    });
    pendingGalleries.set(id, pending);
  }

  const result = await pending;
  return {
    urls: [...result.urls],
    bigThumbnails: [...result.bigThumbnails],
    smallThumbnails: [...result.smallThumbnails],
  };
}

async function resolveGalleryUncached(
  id: number,
  fallbackMetadata?: EhGalleryMetadata | null,
): Promise<ImageList> {
  try {
    await ensureScript();
    if (!routingCache) throw new MediaError('UPSTREAM_ERROR');
    const galleryInfo = await getGalleryInfo(id);
    const files = galleryInfo.files ?? [];
    if (!files.some((file) => file.hash)) throw new MediaError('NO_IMAGES');
    return {
      urls: buildImageUrls(files, routingCache),
      bigThumbnails: buildThumbnailUrls(files, routingCache, 'big'),
      smallThumbnails: buildThumbnailUrls(files, routingCache, 'small'),
    };
  } catch (error) {
    // Only source failures should trigger fallback, not arbitrary programming errors.
    if (!(error instanceof MediaError)) throw error;
    let metadata: EhGalleryMetadata | null;
    try { metadata = fallbackMetadata === undefined ? getEhMetadata(id) : fallbackMetadata; }
    catch { throw error; } // No usable DB means no trustworthy fallback URL.
    if (!metadata?.ehash.trim()) throw error;
    return resolveEhGallery(id, { ...metadata, ehash: metadata.ehash.trim() }, error);
  }
}

export async function getGalleryHeaders(
  _id: string,
): Promise<Record<string, string>> {
  return getGalleryHeadersSync();
}
