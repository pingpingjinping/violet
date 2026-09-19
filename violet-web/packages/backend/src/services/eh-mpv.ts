import { getContentDb } from './content-db.js';
import { getEhCookie } from './eh-cookie-store.js';
import { refreshEhCookieAfterAuthFailure } from './eh-auto-login.js';
import { MediaError, httpMediaError, ehPageError, checkImageLimitUrl } from './media-error.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MPV_CACHE_TTL = 10 * 60 * 1000;
const MPV_REQUEST_TIMEOUT_MS = 15_000;
const MPV_CACHE_LIMIT = 256;
const EH_API_URL = 'https://s.exhentai.org/api.php';

interface MpvGalleryData {
  mpvkey: string;
  imgkeys: string[];
  referer: string;
  timestamp: number;
  ehash: string;
}

interface EhImagePage {
  gid: number;
  page: number;
}

interface EhMpvDependencies {
  fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  getCookie: () => string | null;
  getEhash: (gid: number) => string | null;
  refreshCookie: () => Promise<boolean>;
  now: () => number;
}

export interface ResolvedEhMpvImage {
  url: string;
  referer: string;
}

export interface ResolvedEhMpvGallery {
  urls: string[];
  referer: string;
}

export interface EhMpvService {
  resolveImage: (url: string, signal?: AbortSignal) => Promise<ResolvedEhMpvImage | null>;
  resolveGalleryPages: (gid: number, ehash: string) => Promise<ResolvedEhMpvGallery | null>;
}

class EhMpvAuthenticationError extends MediaError {
  constructor(_message: string) { super('AUTH_REQUIRED'); }
}

function getEhashFromDb(gid: number): string | null {
  const row = getContentDb()
    .prepare('SELECT EHash FROM HitomiColumnModel WHERE Id = ?')
    .get(gid) as { EHash?: string | null } | undefined;
  return row?.EHash?.trim() || null;
}

function parseEhImagePage(url: string): EhImagePage | null {
  const parsed = new URL(url);
  if (parsed.hostname !== 'e-hentai.org' && parsed.hostname !== 'exhentai.org') return null;
  const match = parsed.pathname.match(/^\/s\/[^/]+\/(\d+)-(\d+)$/);
  if (!match) return null;

  const gid = Number(match[1]);
  const page = Number(match[2]);
  if (!Number.isSafeInteger(gid) || gid <= 0 || !Number.isSafeInteger(page) || page <= 0) {
    return null;
  }
  return { gid, page };
}

function parseMpvHtml(html: string): { mpvkey: string; imgkeys: string[] } {
  const mpvkey = html.match(/var mpvkey\s*=\s*"([^"]+)"/)?.[1];
  const rawImagelist = html.match(/var imagelist\s*=\s*(\[[\s\S]*?\]);/)?.[1];
  if (!mpvkey || !rawImagelist) {
    const error = ehPageError(html);
    if (error.code === 'AUTH_REQUIRED') throw new EhMpvAuthenticationError(error.message);
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawImagelist);
  } catch {
    throw new Error('ExHentai MPV imagelist was invalid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('ExHentai MPV imagelist was not an array');

  const imgkeys = parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as { k?: unknown }).k !== 'string') {
      throw new Error('ExHentai MPV imagelist entry did not contain an imgkey');
    }
    return (entry as { k: string }).k;
  });
  if (imgkeys.length === 0) throw new Error('ExHentai MPV imagelist was empty');
  return { mpvkey, imgkeys };
}

export function createEhMpvService(
  overrides: Partial<EhMpvDependencies> = {},
): EhMpvService {
  const deps: EhMpvDependencies = {
    fetchFn: overrides.fetchFn ?? ((input, init) => globalThis.fetch(input, init)),
    getCookie: overrides.getCookie ?? getEhCookie,
    getEhash: overrides.getEhash ?? getEhashFromDb,
    refreshCookie: overrides.refreshCookie ?? refreshEhCookieAfterAuthFailure,
    now: overrides.now ?? (() => Date.now()),
  };
  const cache = new Map<number, MpvGalleryData>();
  const pending = new Map<string, Promise<MpvGalleryData>>();

  function pruneCache() {
    if (cache.size <= MPV_CACHE_LIMIT) return;
    const oldest = [...cache.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, cache.size - MPV_CACHE_LIMIT);
    oldest.forEach(([gid]) => cache.delete(gid));
  }

  async function fetchMpvOnce(gid: number, ehash: string, cookie: string): Promise<MpvGalleryData> {
    const referer = `https://exhentai.org/mpv/${gid}/${ehash}/`;
    const response = await deps.fetchFn(referer, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        Cookie: cookie,
        Referer: 'https://exhentai.org/',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(MPV_REQUEST_TIMEOUT_MS),
    });

    const redirected = response.status >= 300 && response.status < 400;
    if (!response.ok || redirected) {
      await response.body?.cancel();
      if (redirected || response.status === 401) throw new EhMpvAuthenticationError('Login required');
      throw httpMediaError(response.status);
    }

    const html = await response.text();
    const parsed = parseMpvHtml(html);
    return {
      ...parsed,
      referer,
      timestamp: deps.now(),
      ehash,
    };
  }

  async function loadMpv(gid: number, ehash: string): Promise<MpvGalleryData> {
    const cached = cache.get(gid);
    if (cached && cached.ehash === ehash && deps.now() - cached.timestamp < MPV_CACHE_TTL) {
      return cached;
    }

    const pendingKey = `${gid}:${ehash}`;
    const existing = pending.get(pendingKey);
    if (existing) return existing;

    const task = (async () => {
      let cookie = deps.getCookie();
      if (!cookie) throw new EhMpvAuthenticationError('ExHentai cookie is not configured');

      try {
        const value = await fetchMpvOnce(gid, ehash, cookie);
        cache.set(gid, value);
        pruneCache();
        return value;
      } catch (error) {
        if (!(error instanceof EhMpvAuthenticationError)) throw error;
        const refreshed = await deps.refreshCookie();
        if (!refreshed) throw error;
        cookie = deps.getCookie();
        if (!cookie) throw error;

        const value = await fetchMpvOnce(gid, ehash, cookie);
        cache.set(gid, value);
        pruneCache();
        return value;
      }
    })().finally(() => {
      pending.delete(pendingKey);
    });

    pending.set(pendingKey, task);
    return task;
  }

  async function dispatchImage(
    pageInfo: EhImagePage,
    data: MpvGalleryData,
    cookie: string,
    signal?: AbortSignal,
  ): Promise<ResolvedEhMpvImage> {
    const imgkey = data.imgkeys[pageInfo.page - 1];
    if (!imgkey) throw new Error(`ExHentai MPV page ${pageInfo.page} is outside imagelist`);

    const response = await deps.fetchFn(EH_API_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        Cookie: cookie,
        Referer: data.referer,
      },
      body: JSON.stringify({
        method: 'imagedispatch',
        gid: pageInfo.gid,
        page: pageInfo.page,
        imgkey,
        mpvkey: data.mpvkey,
      }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new EhMpvAuthenticationError('Login required');
      throw httpMediaError(response.status);
    }

    const payload = await response.json() as { i?: unknown; login?: unknown; error?: unknown };
    if (payload.login !== undefined) {
      throw new EhMpvAuthenticationError('ExHentai image dispatch requires login');
    }
    if (typeof payload.i !== 'string' || !payload.i.startsWith('http')) {
      throw ehPageError(typeof payload.error === 'string' ? payload.error : '');
    }

    checkImageLimitUrl(payload.i);

    return { url: payload.i, referer: data.referer };
  }

  async function resolveImage(
    url: string,
    signal?: AbortSignal,
  ): Promise<ResolvedEhMpvImage | null> {
    const pageInfo = parseEhImagePage(url);
    if (!pageInfo) return null;

    if (!deps.getCookie()) return null;
    const ehash = deps.getEhash(pageInfo.gid);
    if (!ehash) return null;

    const data = await loadMpv(pageInfo.gid, ehash);
    const cookie = deps.getCookie();
    if (!cookie) return null;

    try {
      return await dispatchImage(pageInfo, data, cookie, signal);
    } catch (error) {
      if (!(error instanceof EhMpvAuthenticationError)) throw error;
      const refreshed = await deps.refreshCookie();
      if (!refreshed) throw error;
      const refreshedCookie = deps.getCookie();
      if (!refreshedCookie) throw error;
      return dispatchImage(pageInfo, data, refreshedCookie, signal);
    }
  }

  async function resolveGalleryPages(
    gid: number,
    ehash: string,
  ): Promise<ResolvedEhMpvGallery | null> {
    if (!deps.getCookie()) return null;
    const data = await loadMpv(gid, ehash);
    return {
      referer: data.referer,
      urls: data.imgkeys.map(
        (imgkey, index) => `https://exhentai.org/s/${imgkey}/${gid}-${index + 1}`,
      ),
    };
  }

  return { resolveImage, resolveGalleryPages };
}

export function createEhMpvResolver(
  overrides: Partial<EhMpvDependencies> = {},
): (url: string, signal?: AbortSignal) => Promise<ResolvedEhMpvImage | null> {
  return createEhMpvService(overrides).resolveImage;
}

const defaultEhMpvService = createEhMpvService();

export const resolveEhMpvImage = defaultEhMpvService.resolveImage;
export const resolveEhMpvGalleryPages = defaultEhMpvService.resolveGalleryPages;
