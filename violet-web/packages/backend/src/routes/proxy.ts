import { Router } from 'express';
import { proxyImage } from '../services/image-proxy.js';
import { resolveGallery } from '../services/gallery-resolver.js';
import { MediaError, publicMediaError } from '../services/media-error.js';
import type { ErrorRequestHandler } from 'express';

export const proxyRouter = Router();

// Cache thumbnails for 30 minutes
const thumbnailCache = new Map<number, { url: string; timestamp: number }>();
const THUMBNAIL_CACHE_TTL = 30 * 60 * 1000;
const thumbnailPending = new Map<number, Promise<string | undefined>>();
let thumbnailActive = 0;
const thumbnailWaiters: Array<() => void> = [];

async function resolveThumbnail(id: number): Promise<string | undefined> {
  const existing = thumbnailPending.get(id);
  if (existing) return existing;
  const task = (async () => {
    if (thumbnailActive >= 4) {
      await new Promise<void>((resolve) => thumbnailWaiters.push(resolve));
    } else {
      thumbnailActive++;
    }
    try {
      return (await resolveGallery(id)).bigThumbnails?.[0];
    } finally {
      const next = thumbnailWaiters.shift();
      if (next) next();
      else thumbnailActive--;
    }
  })();
  thumbnailPending.set(id, task);
  try {
    return await task;
  } finally {
    thumbnailPending.delete(id);
  }
}

proxyRouter.get('/image', async (req, res, next) => {
  try {
    const url = req.query.url as string;
    const referer = req.query.referer as string | undefined;

    if (!url) {
      res.status(400).json({ error: 'url parameter required' });
      return;
    }

    await proxyImage(url, referer, res);
  } catch (err) {
    next(err);
  }
});
proxyRouter.get('/gallery/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid gallery id' });
      return;
    }

    const result = await resolveGallery(id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

proxyRouter.get('/thumbnail/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid gallery id' });
      return;
    }

    // Check cache first
    const cached = thumbnailCache.get(id);
    if (cached && Date.now() - cached.timestamp < THUMBNAIL_CACHE_TTL) {
      res.json({ url: cached.url });
      return;
    }

    // Resolve gallery and extract first big thumbnail
    const thumbnailUrl = await resolveThumbnail(id);

    if (!thumbnailUrl) {
      throw new MediaError('NO_IMAGES');
    }


    // Cache the result
    thumbnailCache.set(id, { url: thumbnailUrl, timestamp: Date.now() });

    // Cleanup old cache entries (keep last 1000)
    if (thumbnailCache.size > 1000) {
      const entries = Array.from(thumbnailCache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, entries.length - 1000);
      toDelete.forEach(([key]) => thumbnailCache.delete(key));
    }

    res.json({ url: thumbnailUrl });
  } catch (err) {
    next(err);
  }
});

const mediaErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent || res.destroyed) { next(error); return; }
  const payload = publicMediaError(error);
  // These are upstream failures, not authentication failures of the Violet API.
  res.setHeader('Cache-Control', 'no-store');
  res.status(502).json(payload);
};
proxyRouter.use(mediaErrorHandler);
