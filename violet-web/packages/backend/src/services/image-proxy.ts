import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { getEhCookie } from './eh-cookie-store.js';
import { refreshEhCookieAfterAuthFailure } from './eh-auto-login.js';
import { MediaError, httpMediaError, ehPageError, checkImageLimitUrl, preferMediaError } from './media-error.js';
import {
  resolveEhMpvImage,
  type ResolvedEhMpvImage,
} from './eh-mpv.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EH_PAGE_CACHE_TTL = 60 * 60 * 1000;
const ehPageCache = new Map<string, { url: string; referer: string; timestamp: number }>();

type EhMpvResolver = (
  url: string,
  signal?: AbortSignal,
) => Promise<ResolvedEhMpvImage | null>;

export interface ResolvedImageSource {
  url: string;
  headers: Record<string, string>;
}

function isEhGalleryHost(hostname: string): boolean {
  return hostname === 'e-hentai.org' || hostname === 'exhentai.org';
}

function isEhResourceHost(hostname: string): boolean {
  return isEhGalleryHost(hostname)
    || hostname.endsWith('.e-hentai.org')
    || hostname.endsWith('.exhentai.org')
    || hostname === 'ehgt.org'
    || hostname.endsWith('.ehgt.org');
}

function decodeHtmlAttribute(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

function extractEhImageUrl(html: string): string {
  const tag = html.match(/<img\b[^>]*\bid=["']img["'][^>]*>/i)?.[0];
  const source = tag?.match(/\bsrc=["']([^"']+)["']/i)?.[1];
  if (!source) throw ehPageError(html);
  const url = new URL(decodeHtmlAttribute(source), 'https://exhentai.org/').toString();
  checkImageLimitUrl(url);
  return url;
}

function imageHeaders(url: string, referer?: string): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  const parsed = new URL(url);
  const isEhResource = isEhResourceHost(parsed.hostname);
  if (isEhResource) {
    const cookie = getEhCookie();
    if (cookie) headers.Cookie = cookie;
    headers.Referer = referer && isEhGalleryHost(new URL(referer).hostname)
      ? referer
      : 'https://exhentai.org/';
  } else if (referer) {
    headers.Referer = referer;
  }
  return headers;
}

function cacheEhImage(pageUrl: string, imageUrl: string, referer: string) {
  ehPageCache.set(pageUrl, { url: imageUrl, referer, timestamp: Date.now() });
  if (ehPageCache.size <= 2000) return;

  const oldest = [...ehPageCache.entries()]
    .sort((a, b) => a[1].timestamp - b[1].timestamp)
    .slice(0, ehPageCache.size - 2000);
  oldest.forEach(([key]) => ehPageCache.delete(key));
}

async function fetchEhImagePage(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      headers: imageHeaders(url, url),
      redirect: 'manual',
      signal,
    });
    let error: MediaError;
    if (!response.ok) {
      await response.body?.cancel();
      error = response.status >= 300 && response.status < 400
        ? new MediaError('AUTH_REQUIRED') : httpMediaError(response.status);
    } else {
      const html = await response.text();
      if (/<img\b[^>]*\bid=["']img["']/i.test(html)) return html;
      error = ehPageError(html);
    }
    if (error.code !== 'AUTH_REQUIRED' || attempt > 0
      || !(await refreshEhCookieAfterAuthFailure())) throw error;
  }
  throw new MediaError('UPSTREAM_ERROR');
}

export async function resolveImageSource(
  url: string,
  referer?: string,
  signal?: AbortSignal,
  mpvResolver: EhMpvResolver = resolveEhMpvImage,
): Promise<ResolvedImageSource> {
  const rewritten = url.replace(
    /^(https?:\/\/)([a-z]+)\.hitomi\.la\//,
    (_, proto, sub) => `${proto}${sub}.gold-usergeneratedcontent.net/`,
  );
  const parsed = new URL(rewritten);

  if (isEhGalleryHost(parsed.hostname) && parsed.pathname.startsWith('/s/')) {
    const cached = ehPageCache.get(rewritten);
    if (cached && Date.now() - cached.timestamp < EH_PAGE_CACHE_TTL) {
      return { url: cached.url, headers: imageHeaders(cached.url, cached.referer) };
    }

    let mpvError: unknown;
    try {
      const mpvSource = await mpvResolver(rewritten, signal);
      if (mpvSource) {
        cacheEhImage(rewritten, mpvSource.url, mpvSource.referer);
        return {
          url: mpvSource.url,
          headers: imageHeaders(mpvSource.url, mpvSource.referer),
        };
      }
    } catch (error) {
      mpvError = error;
      // MPV is an optimization only. Keep the existing /s/ page resolver as fallback.
    }

    try {
      const html = await fetchEhImagePage(rewritten, signal);
      const imageUrl = extractEhImageUrl(html);
      cacheEhImage(rewritten, imageUrl, rewritten);
      return { url: imageUrl, headers: imageHeaders(imageUrl, rewritten) };
    } catch (error) {
      throw preferMediaError(mpvError, error);
    }
  }

  return { url: rewritten, headers: imageHeaders(rewritten, referer) };
}

export async function proxyImage(
  url: string,
  referer: string | undefined,
  res: Response,
): Promise<void> {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.once('close', onClose);
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const source = await resolveImageSource(url, referer, signal);
    checkImageLimitUrl(source.url);
    const upstream = await fetch(source.url, {
      headers: source.headers,
      signal,
    });

    if (!upstream.ok) {
      await upstream.body?.cancel();
      throw httpMediaError(upstream.status);
    }

    const contentType = upstream.headers.get('content-type');
    if (contentType && /^(?:text\/|application\/(?:json|xhtml))/i.test(contentType)) {
      await upstream.body?.cancel();
      throw new MediaError('UPSTREAM_ERROR');
    }
    if (contentType) res.setHeader('Content-Type', contentType);

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
    } else {
      res.end();
    }
  } finally {
    res.off('close', onClose);
  }
}
