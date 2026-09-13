import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveGallery } from './gallery-resolver.js';

test('resolves Hitomi image URLs with current gg.js routing', async () => {
  const originalFetch = globalThis.fetch;
  const routedHash = `${'0'.repeat(61)}123`;
  const defaultHash = `${'0'.repeat(61)}456`;
  const counts = new Map<string, number>();

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    counts.set(url, (counts.get(url) ?? 0) + 1);

    if (url.endsWith('/gg.js')) {
      return new Response("var gg = { b: 'cdn/', m: function(g) { var o = 0; switch(g) { case 786: o = 1; } return o; } };");
    }

    if (url.includes('/galleries/')) {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('referer'), 'https://hitomi.la/');
      assert.ok(headers.get('user-agent'));
      return new Response(
        `var galleryinfo = {"files":[{"hash":"${routedHash}"},{"hash":"${defaultHash}"},{}]};`,
      );
    }

    throw new Error(`Unexpected test URL: ${url}`);
  };

  try {
    const [first, shared] = await Promise.all([
      resolveGallery(123),
      resolveGallery(123),
    ]);

    assert.equal(counts.get('https://ltn.gold-usergeneratedcontent.net/gg.js'), 1);
    assert.equal(
      counts.get('https://ltn.gold-usergeneratedcontent.net/galleries/123.js'),
      1,
    );
    assert.deepEqual(first.urls, [
      `https://w2.gold-usergeneratedcontent.net/cdn/786/${routedHash}.webp`,
      `https://w1.gold-usergeneratedcontent.net/cdn/1605/${defaultHash}.webp`,
    ]);
    assert.deepEqual(first.bigThumbnails, [
      `https://btn.gold-usergeneratedcontent.net/webpbigtn/3/12/${routedHash}.webp`,
      `https://atn.gold-usergeneratedcontent.net/webpbigtn/6/45/${defaultHash}.webp`,
    ]);
    assert.deepEqual(first.smallThumbnails, [
      `https://btn.gold-usergeneratedcontent.net/webpsmalltn/3/12/${routedHash}.webp`,
      `https://atn.gold-usergeneratedcontent.net/webpsmalltn/6/45/${defaultHash}.webp`,
    ]);

    first.urls.push('caller-only');
    assert.equal(shared.urls.includes('caller-only'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
