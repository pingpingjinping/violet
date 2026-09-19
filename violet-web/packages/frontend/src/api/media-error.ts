import axios from 'axios';

const codes = ['AUTH_REQUIRED', 'BANDWIDTH_LIMIT', 'RATE_LIMITED', 'UNAVAILABLE',
  'NO_IMAGES', 'NETWORK_ERROR', 'UPSTREAM_ERROR'] as const;
export type MediaErrorCode = typeof codes[number];
export function mediaErrorCode(value: unknown): MediaErrorCode {
  return codes.includes(value as MediaErrorCode) ? value as MediaErrorCode : 'UPSTREAM_ERROR';
}
export function galleryErrorCode(error: unknown): MediaErrorCode {
  if (axios.isAxiosError(error)) {
    if (!error.response) return 'NETWORK_ERROR';
    return mediaErrorCode(error.response.data?.code);
  }
  return 'UPSTREAM_ERROR';
}

// <img> errors do not expose the response body. Diagnose only after its retries
// are exhausted, and cancel a successful response without downloading the image.
export async function diagnoseImageError(src: string, signal: AbortSignal): Promise<MediaErrorCode> {
  const url = new URL(src, window.location.href);
  if (url.origin !== window.location.origin || url.pathname !== '/api/proxy/image') return 'UPSTREAM_ERROR';
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: 'no-store',
    });
    if (!response.ok && response.headers.get('content-type')?.includes('application/json')) {
      return mediaErrorCode((await response.json()).code);
    }
    await response.body?.cancel();
    return 'UPSTREAM_ERROR';
  } catch {
    return 'NETWORK_ERROR';
  }
}
