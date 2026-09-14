import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { getEhCookie } from './eh-cookie-store.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EH_PAGE_CACHE_TTL = 60 * 60 * 1000;
const ehPageCache = new Map<string, { url: string; timestamp: number }>();

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
  if (!source) throw new Error('E-Hentai image page did not contain an image URL');
  return new URL(decodeHtmlAttribute(source), 'https://exhentai.org/').toString();
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

export async function resolveImageSource(
  url: string,
  referer?: string,
  signal?: AbortSignal,
): Promise<ResolvedImageSource> {
  const rewritten = url.replace(
    /^(https?:\/\/)([a-z]+)\.hitomi\.la\//,
    (_, proto, sub) => `${proto}${sub}.gold-usergeneratedcontent.net/`,
  );
  const parsed = new URL(rewritten);

  if (isEhGalleryHost(parsed.hostname) && parsed.pathname.startsWith('/s/')) {
    const cached = ehPageCache.get(rewritten);
    if (cached && Date.now() - cached.timestamp < EH_PAGE_CACHE_TTL) {
      return { url: cached.url, headers: imageHeaders(cached.url, rewritten) };
    }

    const response = await fetch(rewritten, {
      headers: imageHeaders(rewritten, rewritten),
      redirect: 'manual',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`E-Hentai image page returned ${response.status}`);
    }
    const imageUrl = extractEhImageUrl(await response.text());
    ehPageCache.set(rewritten, { url: imageUrl, timestamp: Date.now() });
    if (ehPageCache.size > 2000) {
      const oldest = [...ehPageCache.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp)
        .slice(0, ehPageCache.size - 2000);
      oldest.forEach(([key]) => ehPageCache.delete(key));
    }
    return { url: imageUrl, headers: imageHeaders(imageUrl, rewritten) };
  }

  return { url: rewritten, headers: imageHeaders(rewritten, referer) };
}

/**
 * Proxy an image from a remote URL, setting appropriate headers (Referer, etc.)
 * to bypass CORS and hotlink protection.
 */
export async function proxyImage(
  url: string,
  referer: string | undefined,
  res: Response,
): Promise<void> {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.once('close', onClose);
  try {
    const source = await resolveImageSource(url, referer, controller.signal);
    const upstream = await fetch(source.url, {
      headers: source.headers,
      signal: controller.signal,
    });

    if (!upstream.ok) {
      await upstream.body?.cancel();
      res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
      return;
    }

    const contentType = upstream.headers.get('content-type');
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
