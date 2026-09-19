import { useQuery } from '@tanstack/react-query';
import { resolveGallery } from '../api/proxy';
import { galleryErrorCode } from '../api/media-error';

export function useImageList(galleryId: number) {
  return useQuery({
    queryKey: ['imageList', galleryId],
    queryFn: () => resolveGallery(galleryId),
    enabled: galleryId > 0,
    staleTime: 30 * 60 * 1000,
    retry: (count, error) => count < 1
      && ['NETWORK_ERROR', 'UPSTREAM_ERROR'].includes(galleryErrorCode(error)),
  });
}
