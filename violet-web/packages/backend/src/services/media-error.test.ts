import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaError, httpMediaError, ehPageError, checkImageLimitUrl, publicMediaError, preferMediaError } from './media-error.js';
import { createEhMpvService } from './eh-mpv.js';
import { resolveGallery } from './gallery-resolver.js';

test('empty galleries and missing galleries return different codes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/gg.js')) return new Response(
      "var gg = { b: 'cdn/', m: function(g) { var o = 0; return o; } };");
    return new Response('var galleryinfo = {"files":[]};');
  };
  try {
    await assert.rejects(resolveGallery(300001), { code: 'NO_IMAGES' });
    globalThis.fetch = async () => new Response('', { status: 404 });
    await assert.rejects(resolveGallery(300002, { ehash: 'token', files: 1, thumbnail: null }),
      { code: 'UNAVAILABLE' });
  } finally { globalThis.fetch = originalFetch; }
});

test('HTTP errors distinguish login, bandwidth, rate limits and unavailable content', () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [509, 'BANDWIDTH_LIMIT'],
    [429, 'RATE_LIMITED'], [403, 'UNAVAILABLE'], [404, 'UNAVAILABLE'],
    [410, 'UNAVAILABLE'], [503, 'UPSTREAM_ERROR']] as const) {
    assert.equal(httpMediaError(status).code, code);
  }
});

test('HTML error detection is conservative; arbitrary pages are not login or deletion', () => {
  assert.equal(ehPageError('You have exceeded your image viewing limits').code, 'BANDWIDTH_LIMIT');
  assert.equal(ehPageError('This gallery has been expunged').code, 'UNAVAILABLE');
  assert.equal(ehPageError('You must be logged in').code, 'AUTH_REQUIRED');
  assert.equal(ehPageError('<html>maintenance</html>').code, 'UPSTREAM_ERROR');
  assert.equal(ehPageError('').code, 'UPSTREAM_ERROR');
});

test('509 placeholder URLs are rejected only on recognized source hosts', () => {
  assert.throws(() => checkImageLimitUrl('https://ehgt.org/g/509.gif'), { code: 'BANDWIDTH_LIMIT' });
  checkImageLimitUrl('https://example.test/509.gif');
  checkImageLimitUrl('https://ehgt.org/g/5090.jpg');
});

test('public errors never leak upstream URLs or credentials; network errors stay distinct', () => {
  assert.deepEqual(publicMediaError(new Error('https://secret.test/token?cookie=secret')), {
    error: 'The image source returned an unexpected response.', code: 'UPSTREAM_ERROR',
  });
  assert.equal(publicMediaError(new TypeError('fetch failed')).code, 'NETWORK_ERROR');
  assert.equal(publicMediaError(new DOMException('timeout', 'TimeoutError')).code, 'NETWORK_ERROR');
  assert.equal(publicMediaError(new TypeError('programming bug')).code, 'UPSTREAM_ERROR');
  assert.equal(publicMediaError(new MediaError('NO_IMAGES')).code, 'NO_IMAGES');
});

test('fallback retains actionable failures instead of overwriting them with generic errors', () => {
  const limit = new MediaError('BANDWIDTH_LIMIT');
  assert.equal(preferMediaError(limit, new Error('parse failed')), limit);
  assert.equal(preferMediaError(new MediaError('UNAVAILABLE'), limit), limit);
});

for (const status of [509, 429, 404, 503]) {
  test(`MPV HTTP ${status} does not trigger cookie refresh`, async () => {
    let refreshes = 0;
    const service = createEhMpvService({
      getCookie: () => 'test-cookie',
      refreshCookie: async () => { refreshes++; return false; },
      fetchFn: async () => new Response('', { status }),
    });
    await assert.rejects(service.resolveGalleryPages(123, 'token'), { code: httpMediaError(status).code });
    assert.equal(refreshes, 0);
  });
}

test('MPV explicit authentication failure still refreshes cookies once', async () => {
  let refreshes = 0;
  const service = createEhMpvService({
    getCookie: () => 'test-cookie',
    refreshCookie: async () => { refreshes++; return true; },
    fetchFn: async () => new Response('', { status: 401 }),
  });
  await assert.rejects(service.resolveGalleryPages(123, 'token'), { code: 'AUTH_REQUIRED' });
  assert.equal(refreshes, 1);
});
