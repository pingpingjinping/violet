import { useState, useEffect, type RefObject } from 'react';
import { useAppStore } from '../stores/app-store';
import { getCachedImage, putCachedImage } from '../services/image-cache';
import { getProxyImageUrl } from '../api/proxy';
import { runThumbnail } from '../services/thumbnail-queue';

const noop = () => {};

export function useCachedThumbnail(galleryId: number, visibilityRef?: RefObject<HTMLDivElement | null>): { src: string; onLoadSuccess: () => void } {
  const imageCacheEnabled = useAppStore((s) => s.imageCacheEnabled);
  const imageCacheMaxSizeMB = useAppStore((s) => s.imageCacheMaxSizeMB);
  const [local, setLocal] = useState<{ id: number; src: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    let objectUrl: string | null = null;
    let observer: IntersectionObserver | null = null;
    let started = false;
    setLocal(null);

    const load = async () => {
      if (started || galleryId <= 0 || signal.aborted) return;
      started = true;
      observer?.disconnect();
      try {
        let blob: Blob | null = null;
        if (imageCacheEnabled) blob = (await getCachedImage(galleryId, -1))?.blob ?? null;
        if (signal.aborted) return;
        if (!blob) {
          blob = await runThumbnail(signal, async () => {
            const timer = setTimeout(() => controller.abort(), 25000);
            try {
              const meta = await fetch(`/api/proxy/thumbnail/${galleryId}`, { signal });
              if (!meta.ok) throw new Error(`Thumbnail address HTTP ${meta.status}`);
              const { url } = await meta.json() as { url: string };
              const response = await fetch(getProxyImageUrl(url, `https://hitomi.la/reader/${galleryId}.html`), { signal });
              if (!response.ok) throw new Error(`Thumbnail image HTTP ${response.status}`);
              return await response.blob();
            } finally { clearTimeout(timer); }
          });
          if (signal.aborted) return;
          // Store the bytes we display, without another onLoad network request.
          if (imageCacheEnabled) void putCachedImage(galleryId, -1, blob, blob.type || 'image/jpeg', imageCacheMaxSizeMB * 1024 * 1024).catch(noop);
        }
        if (signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setLocal({ id: galleryId, src: objectUrl });
      } catch {
        // Keep the existing placeholder; do not bypass the request budget.
      }
    };

    const element = visibilityRef?.current;
    if (element && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) void load();
      }, { rootMargin: '100px' });
      observer.observe(element);
    } else { void load(); }

    return () => {
      controller.abort();
      observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [galleryId, visibilityRef, imageCacheEnabled, imageCacheMaxSizeMB]);

  return { src: local?.id === galleryId ? local.src : '', onLoadSuccess: noop };
}
