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

test('uses MPV imagelist to build ExHentai page URLs before legacy gallery scraping', async () => {
  const originalFetch = globalThis.fetch;
  const oldCookiePath = process.env.EXHENTAI_COOKIE_PATH;
  const oldCookie = process.env.EXHENTAI_COOKIE;
  const galleryId = 987654321;
  const ehash = 'gallery-token';
  const mpvUrl = `https://exhentai.org/mpv/${galleryId}/${ehash}/`;
  const counts = new Map<string, number>();

  process.env.EXHENTAI_COOKIE_PATH = `/tmp/violet-gallery-resolver-test-${process.pid}`;
  process.env.EXHENTAI_COOKIE = 'ipb_member_id=1; ipb_pass_hash=x; igneous=y';

  globalThis.fetch = async (input) => {
    const url = String(input);
    counts.set(url, (counts.get(url) ?? 0) + 1);

    if (url.includes(`/galleries/${galleryId}.js`)) {
      return new Response('not found', { status: 404 });
    }
    if (url === mpvUrl) {
      return new Response(
        '<script>var mpvkey = "mpv-key"; var imagelist = [{"k":"img-a"},{"k":"img-b"}];</script>',
      );
    }
    if (url.includes('/g/')) {
      throw new Error('legacy /g/ scraper must not run when MPV succeeds');
    }
    if (url.endsWith('/gg.js')) {
      return new Response("var gg = { b: 'cdn/', m: function(g) { var o = 0; return o; } };");
    }

    throw new Error(`Unexpected test URL: ${url}`);
  };

  try {
    const result = await resolveGallery(galleryId, {
      ehash,
      files: 2,
      thumbnail: 'https://example.test/thumb.jpg',
    });

    assert.deepEqual(result.urls, [
      `https://exhentai.org/s/img-a/${galleryId}-1`,
      `https://exhentai.org/s/img-b/${galleryId}-2`,
    ]);
    assert.deepEqual(result.bigThumbnails, ['https://example.test/thumb.jpg']);
    assert.equal(counts.get(mpvUrl), 1);
    assert.equal(
      [...counts.keys()].some((url) => url.includes('/g/') && url !== mpvUrl),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (oldCookiePath === undefined) delete process.env.EXHENTAI_COOKIE_PATH;
    else process.env.EXHENTAI_COOKIE_PATH = oldCookiePath;
    if (oldCookie === undefined) delete process.env.EXHENTAI_COOKIE;
    else process.env.EXHENTAI_COOKIE = oldCookie;
  }
});

test('keeps the last good gg.js routing when refreshes fail', async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const routedHash = `${'0'.repeat(61)}123`;
  let now = originalDateNow() + 24 * 60 * 60 * 1000;
  let phase: 'prime' | 'http-error' | 'malformed' = 'prime';
  let ggRequests = 0;

  Date.now = () => now;
  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.endsWith('/gg.js')) {
      ggRequests += 1;
      if (phase === 'http-error') return new Response('unavailable', { status: 503 });
      if (phase === 'malformed') return new Response('<html>not routing data</html>');
      return new Response(
        "var gg = { b: 'stale/', m: function(g) { var o = 0; switch(g) { case 786: o = 1; } return o; } };",
      );
    }

    if (url.includes('/galleries/')) {
      return new Response(`var galleryinfo = {"files":[{"hash":"${routedHash}"}]};`);
    }

    throw new Error(`Unexpected test URL: ${url}`);
  };

  try {
    const primed = await resolveGallery(2001);
    assert.deepEqual(primed.urls, [
      `https://w2.gold-usergeneratedcontent.net/stale/786/${routedHash}.webp`,
    ]);

    now += 31 * 60 * 1000;
    phase = 'http-error';
    const afterHttpError = await resolveGallery(2002);
    assert.deepEqual(afterHttpError.urls, primed.urls);

    now += 2 * 60 * 1000;
    phase = 'malformed';
    const afterMalformedResponse = await resolveGallery(2003);
    assert.deepEqual(afterMalformedResponse.urls, primed.urls);
    assert.equal(ggRequests, 3);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  }
});
