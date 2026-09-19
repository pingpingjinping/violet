import type { ImageList } from '@violet-web/shared';
import { api } from './client';

export function getProxyImageUrl(url: string, referer?: string): string {
  const params = new URLSearchParams({ url });
  if (referer) params.set('referer', referer);
  return `/api/proxy/image?${params.toString()}`;
}

export async function resolveGallery(id: number): Promise<ImageList> {
  // Sequential Hitomi/ExH/EH attempts can exceed the default 30s API timeout.
  const { data } = await api.get<ImageList>(`/proxy/gallery/${id}`, { timeout: 120_000 });
  return data;
}

export async function getThumbnailUrl(galleryId: number): Promise<string> {
  const { data } = await api.get<{ url: string }>(`/proxy/thumbnail/${galleryId}`);
  return data.url;
}
