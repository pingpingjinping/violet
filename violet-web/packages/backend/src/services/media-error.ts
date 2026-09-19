export type MediaErrorCode = 'AUTH_REQUIRED' | 'BANDWIDTH_LIMIT' | 'RATE_LIMITED'
  | 'UNAVAILABLE' | 'NO_IMAGES' | 'NETWORK_ERROR' | 'UPSTREAM_ERROR';

const messages: Record<MediaErrorCode, string> = {
  AUTH_REQUIRED: 'Upstream login is required.',
  BANDWIDTH_LIMIT: 'Upstream image bandwidth limit reached.',
  RATE_LIMITED: 'Upstream request limit reached.',
  UNAVAILABLE: 'Content is missing or inaccessible.',
  NO_IMAGES: 'No images were returned.',
  NETWORK_ERROR: 'Unable to connect to the image source.',
  UPSTREAM_ERROR: 'The image source returned an unexpected response.',
};

export class MediaError extends Error {
  constructor(readonly code: MediaErrorCode) { super(messages[code]); }
}

export function httpMediaError(status: number): MediaError {
  return new MediaError(status === 509 ? 'BANDWIDTH_LIMIT'
    : status === 429 ? 'RATE_LIMITED'
    : status === 401 ? 'AUTH_REQUIRED'
    : [403, 404, 410].includes(status) ? 'UNAVAILABLE' : 'UPSTREAM_ERROR');
}

// Only inspect error pages, never normal gallery text (which includes user titles/tags).
export function ehPageError(html: string): MediaError {
  if (/exceeded your image (?:viewing )?limits|bandwidth limit exceeded/i.test(html)) {
    return new MediaError('BANDWIDTH_LIMIT');
  }
  if (/this gallery has been (?:removed|expunged)|gallery not available|gallery is not available/i.test(html)) {
    return new MediaError('UNAVAILABLE');
  }
  if (/you (?:must|need to) (?:be logged in|log in)|please (?:log in|login)|name=["']UserName["']/i.test(html)) {
    return new MediaError('AUTH_REQUIRED');
  }
  return new MediaError('UPSTREAM_ERROR');
}

export function checkImageLimitUrl(url: string): void {
  const parsed = new URL(url);
  if (/(^|\.)(?:e-hentai\.org|exhentai\.org|ehgt\.org)$/.test(parsed.hostname)
    && /\/509\.(?:gif|png|jpe?g)$/.test(parsed.pathname)) {
    throw new MediaError('BANDWIDTH_LIMIT');
  }
}

export function publicMediaError(error: unknown) {
  let code: MediaErrorCode = 'UPSTREAM_ERROR';
  if (error instanceof MediaError) code = error.code;
  else if (error instanceof Error && (['TimeoutError', 'AbortError'].includes(error.name)
    || (error instanceof TypeError && /fetch failed|network/i.test(error.message)))) code = 'NETWORK_ERROR';
  return { error: messages[code], code };
}

// Keep actionable failures if a later fallback returns only a generic error.
export function preferMediaError(previous: unknown, next: unknown): unknown {
  const priority = (error: unknown) => error instanceof MediaError
    ? ({ BANDWIDTH_LIMIT: 5, RATE_LIMITED: 4, AUTH_REQUIRED: 3, UNAVAILABLE: 2,
      NETWORK_ERROR: 1, NO_IMAGES: 1, UPSTREAM_ERROR: 0 }[error.code]) : 0;
  return priority(previous) > priority(next) ? previous : next;
}
