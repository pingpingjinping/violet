import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { galleryErrorCode, mediaErrorCode, diagnoseImageError } from '../src/api/media-error.ts';

test('frontend maps only known codes, never raw server error text', () => {
  assert.equal(mediaErrorCode('BANDWIDTH_LIMIT'), 'BANDWIDTH_LIMIT');
  assert.equal(mediaErrorCode('private upstream URL'), 'UPSTREAM_ERROR');
  assert.equal(galleryErrorCode({ isAxiosError: true, response: { data: { code: 'AUTH_REQUIRED' } } }), 'AUTH_REQUIRED');
  assert.equal(galleryErrorCode({ isAxiosError: true }), 'NETWORK_ERROR');
  assert.equal(galleryErrorCode(new Error('unknown')), 'UPSTREAM_ERROR');
});

test('all four required languages include each error code and navigation actions', () => {
  for (const language of ['en', 'ko', 'ja', 'zh']) {
    const { viewer } = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${language}.json`, import.meta.url), 'utf8'));
    for (const code of ['AUTH_REQUIRED', 'BANDWIDTH_LIMIT', 'RATE_LIMITED', 'UNAVAILABLE', 'NO_IMAGES', 'NETWORK_ERROR', 'UPSTREAM_ERROR']) {
      assert.ok(viewer.errors[code], `${language}: ${code}`);
    }
    assert.ok(viewer.errorRetry);
    assert.ok(viewer.errorBack);
  }
});

test('image diagnosis reads typed errors and cancels successful image bodies', async () => {
  const originalFetch = globalThis.fetch;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { href: 'https://violet.test/viewer/1', origin: 'https://violet.test' },
  } });
  const signal = new AbortController().signal;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'BANDWIDTH_LIMIT' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(await diagnoseImageError('/api/proxy/image?url=x', signal), 'BANDWIDTH_LIMIT');
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    assert.equal(await diagnoseImageError('/api/proxy/image?url=x', signal), 'UPSTREAM_ERROR');
    assert.equal(cancelled, true);
    globalThis.fetch = async () => { throw new Error('network'); };
    assert.equal(await diagnoseImageError('/api/proxy/image?url=x', signal), 'NETWORK_ERROR');
    assert.equal(await diagnoseImageError('https://external.test/api/proxy/image', signal), 'UPSTREAM_ERROR');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
