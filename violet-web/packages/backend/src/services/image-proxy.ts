import { lookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
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
const IMAGE_DOMAINS = [
  'hitomi.la', 'gold-usergeneratedcontent.net', 'e-hentai.org',
  'exhentai.org', 'ehgt.org', 'hath.network',
];
const IMAGE_REDIRECTS = [301, 302, 303, 307, 308];
const MAX_IMAGE_REDIRECTS = 4;

// Resolve for the actual connection so a second lookup cannot change the destination.
export const publicImageLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const publicAddresses = addresses.filter(({ address }) => {
      const ip = ipaddr.process(address);
      return ip.range() === 'unicast' &&
        (ip.kind() === 'ipv4' || (ip.toByteArray()[0] & 0xe0) === 0x20);
    });
    const first = publicAddresses[0];
    if (!first) {
      return callback(new Error('Image host has no public address'), '');
    }
    if (options.all) return callback(null, publicAddresses);
    callback(null, first.address, first.family);
  });
};

const imageDispatcher = new Agent({ connect: { lookup: publicImageLookup } });

function isDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function validatedImageUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  const isHath = isDomain(url.hostname, 'hath.network');
  if (url.protocol !== 'https:' || url.username || url.password
    || !IMAGE_DOMAINS.some((domain) => isDomain(url.hostname, domain))
    // Hentai@Home nodes can serve HTTPS images on a custom high port.
    || (url.port && (!isHath || Number(url.port) < 1024))) {
    throw new MediaError('UPSTREAM_ERROR');
  }
  return url;
}

function fetchImageHop(url: string, headers: Record<string, string>, signal?: AbortSignal) {
  const options = { headers, signal, redirect: 'manual' as const, dispatcher: imageDispatcher };
  return fetch(url, options);
}

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

function extractEhImageUrl(html: string, pageUrl: string): string {
  const tag = html.match(/<img\b[^>]*\bid=["']img["'][^>]*>/i)?.[0];
  const source = tag?.match(/\bsrc=["']([^"']+)["']/i)?.[1];
  if (!source) throw ehPageError(html);
  const url = validatedImageUrl(decodeHtmlAttribute(source), pageUrl).href;
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
    const response = await fetchImageHop(url, imageHeaders(url, url), signal);
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
    /^https?:\/\/([a-z]+)\.hitomi\.la\//i,
    (_, sub) => `https://${sub}.gold-usergeneratedcontent.net/`,
  );
  const parsed = validatedImageUrl(rewritten);

  if (isEhGalleryHost(parsed.hostname) && parsed.pathname.startsWith('/s/')) {
    const cached = ehPageCache.get(rewritten);
    if (cached && Date.now() - cached.timestamp < EH_PAGE_CACHE_TTL) {
      const imageUrl = validatedImageUrl(cached.url).href;
      return { url: imageUrl, headers: imageHeaders(imageUrl, cached.referer) };
    }

    let mpvError: unknown;
    try {
      // EH was selected only after ExH failed/skipped. Do not retry ExH MPV
      // for every page of an EH fallback gallery.
      const mpvSource = parsed.hostname === 'exhentai.org'
        ? await mpvResolver(rewritten, signal) : null;
      if (mpvSource) {
        const imageUrl = validatedImageUrl(mpvSource.url).href;
        cacheEhImage(rewritten, imageUrl, mpvSource.referer);
        return {
          url: imageUrl,
          headers: imageHeaders(imageUrl, mpvSource.referer),
        };
      }
    } catch (error) {
      mpvError = error;
      // MPV is an optimization only. Keep the existing /s/ page resolver as fallback.
    }

    try {
      const html = await fetchEhImagePage(rewritten, signal);
      const imageUrl = extractEhImageUrl(html, rewritten);
      cacheEhImage(rewritten, imageUrl, rewritten);
      return { url: imageUrl, headers: imageHeaders(imageUrl, rewritten) };
    } catch (error) {
      throw preferMediaError(mpvError, error);
    }
  }

  return { url: parsed.href, headers: imageHeaders(parsed.href, referer) };
}

async function fetchResolvedImage(source: ResolvedImageSource, signal: AbortSignal) {
  let url = validatedImageUrl(source.url);
  const headers = { ...source.headers };
  for (let redirects = 0; ; redirects++) {
    checkImageLimitUrl(url.href);
    const response = await fetchImageHop(url.href, headers, signal);
    if (!IMAGE_REDIRECTS.includes(response.status)) return response;

    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects >= MAX_IMAGE_REDIRECTS) {
      throw new MediaError('UPSTREAM_ERROR');
    }

    const next = validatedImageUrl(location, url.href);
    if (next.origin !== url.origin) delete headers.Cookie;
    url = next;
  }
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
    const upstream = await fetchResolvedImage(source, signal);

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
