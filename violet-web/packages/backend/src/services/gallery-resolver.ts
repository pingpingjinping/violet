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

const BASE_DOMAIN = 'gold-usergeneratedcontent.net';
const GG_JS_URL = `https://ltn.${BASE_DOMAIN}/gg.js`;

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

class UpstreamHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`Failed to fetch ${url}: ${status}`);
  }
}

class EhAuthenticationError extends Error {}

let routingCache: GgRouting | null = null;
let latestUpdate = 0;
let routingRefresh: Promise<void> | null = null;
const pendingGalleries = new Map<number, Promise<ImageList>>();

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...headers },
  });
  if (!res.ok) throw new UpstreamHttpError(url, res.status);
  return res.text();
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
  if (!response.ok) throw new UpstreamHttpError(url, response.status);
  const html = await response.text();
  if (!html.includes('id="gdt"') && !html.includes("id='gdt'")) {
    throw new EhAuthenticationError(`E-Hentai gallery unavailable or authentication required: ${url}`);
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

async function resolveEhGallery(id: number, metadata: EhGalleryMetadata): Promise<ImageList> {
  const expected = metadata.files && metadata.files > 0 ? metadata.files : null;
  let lastError: unknown;

  if (getEhCookie()) {
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
      lastError = error;
    }
  }

  const candidates = getEhCookie()
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

      if (imagePages.length === 0) throw new Error(`No E-Hentai image pages found for ${id}`);
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
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to resolve E-Hentai gallery ${id}`);
}

async function tryRefreshV4(): Promise<boolean> {
  try {
    const ggText = await fetchText(GG_JS_URL);
    const b = ggText.match(/b:\s*'([^']+)'/)?.[1] ?? '';
    const mList = new Set([...ggText.matchAll(/case (\d+):/g)].map((m) => m[1]));
    const oMatches = [...ggText.matchAll(/o = (\d+)/g)].map((m) => Number(m[1]));

    routingCache = {
      b,
      mList,
      o1: oMatches[0] ?? 0,
      o2: oMatches[oMatches.length - 1] ?? 1,
    };
    latestUpdate = Date.now();
    return true;
  } catch {
    return false;
  }
}

async function ensureScript(): Promise<void> {
  if (routingCache && Date.now() - latestUpdate < 30 * 60 * 1000) return;

  if (!routingRefresh) {
    routingRefresh = (async () => {
      if (!(await tryRefreshV4())) {
        throw new Error('Failed to refresh Hitomi routing data');
      }
    })().finally(() => {
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

  return JSON.parse(json) as GalleryInfo;
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
  fallbackMetadata?: EhGalleryMetadata,
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
  fallbackMetadata?: EhGalleryMetadata,
): Promise<ImageList> {
  await ensureScript();
  if (!routingCache) throw new Error('Hitomi routing data not available');

  try {
    const galleryInfo = await getGalleryInfo(id);
    const files = galleryInfo.files ?? [];
    return {
      urls: buildImageUrls(files, routingCache),
      bigThumbnails: buildThumbnailUrls(files, routingCache, 'big'),
      smallThumbnails: buildThumbnailUrls(files, routingCache, 'small'),
    };
  } catch (error) {
    if (!(error instanceof UpstreamHttpError) || error.status !== 404) throw error;
    const metadata = fallbackMetadata ?? getEhMetadata(id);
    if (!metadata) throw error;
    return resolveEhGallery(id, metadata);
  }
}

export async function getGalleryHeaders(
  _id: string,
): Promise<Record<string, string>> {
  return getGalleryHeadersSync();
}
