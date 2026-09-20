import { create } from 'zustand';
import { api } from '../api/client';
import { resolveGallery } from '../api/proxy';
import { createGalleryZip } from '../services/pc-download-zip';

interface PcDownloadStore {
  galleryId: number | null;
  controller: AbortController | null;
  completed: number;
  total: number;
  result: 'ready' | 'error' | 'tooLarge' | null;
  start: (galleryId: number) => Promise<void>;
  cancel: () => void;
}

export const usePcDownloadStore = create<PcDownloadStore>((set, get) => ({
  galleryId: null, controller: null, completed: 0, total: 0, result: null,
  cancel: () => get().controller?.abort(),
  start: async (galleryId) => {
    if (get().controller) return;
    const controller = new AbortController();
    const { signal } = controller;
    set({ galleryId, controller, completed: 0, total: 0, result: null });
    try {
      const gallery = await resolveGallery(galleryId, signal);
      const blob = await createGalleryZip(gallery.urls, async (url, signal) => {
        const response = await api.get<ArrayBuffer>('/proxy/image', {
          params: { url, referer: `https://hitomi.la/reader/${galleryId}.html` },
          responseType: 'arraybuffer', timeout: 60_000, signal,
        });
        return new Uint8Array(response.data);
      }, signal, (completed, total) => set({ completed, total }));
      signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${galleryId}.zip`;
      document.body.appendChild(anchor);
      try { anchor.click(); } finally {
        anchor.remove();
        // Allow the browser to start consuming the Blob before releasing it.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      set({ result: 'ready' });
    } catch (error) {
      if (!signal.aborted) set({ result: error instanceof Error && error.message === 'tooLarge' ? 'tooLarge' : 'error' });
    } finally {
      set({ controller: null });
    }
  },
}));
