import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveGallery } from './gallery-resolver.js';
import { resolveImageSource } from './image-proxy.js';

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

test('falls back to ExHentai metadata and resolves image pages lazily', async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.EXHENTAI_COOKIE;
  process.env.EXHENTAI_COOKIE = 'ipb_member_id=1; ipb_pass_hash=test; igneous=test';
  const galleryUrl =
    'https://exhentai.org/g/456/abc123/?p=0&inline_set=ts_m';
  const firstPage = 'https://exhentai.org/s/token-a/456-1';
  const secondPage = 'https://exhentai.org/s/token-b/456-2';
  const imageUrl = 'https://exhentai.org/i/image-1.jpg';

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/galleries/456.js')) {
      return new Response('not found', { status: 404 });
    }
    if (url === galleryUrl) {
      const headers = new Headers(init?.headers);
      assert.match(headers.get('cookie') ?? '', /ipb_member_id=1/);
      assert.equal(init?.redirect, 'manual');
      return new Response(
        `<div id="gdt">
          <a href="${firstPage}"><img src="https://s.exhentai.org/t/a.jpg"></a>
          <a href="${secondPage}"><img src="https://s.exhentai.org/t/b.jpg"></a>
        </div>`,
      );
    }
    if (url === firstPage) {
      const headers = new Headers(init?.headers);
      assert.match(headers.get('cookie') ?? '', /ipb_member_id=1/);
      return new Response(`<div id="i3"><a><img id="img" src="${imageUrl}"></a></div>`);
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };

  try {
    const gallery = await resolveGallery(456, {
      ehash: 'abc123',
      files: 2,
      thumbnail: null,
    });
    assert.deepEqual(gallery.urls, [firstPage, secondPage]);
    assert.deepEqual(gallery.bigThumbnails, [
      'https://s.exhentai.org/t/a.jpg',
      'https://s.exhentai.org/t/b.jpg',
    ]);

    const source = await resolveImageSource(firstPage);
    assert.equal(source.url, imageUrl);
    assert.equal(source.headers.Referer, firstPage);
    assert.match(source.headers.Cookie ?? '', /ipb_pass_hash=test/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCookie === undefined) delete process.env.EXHENTAI_COOKIE;
    else process.env.EXHENTAI_COOKIE = originalCookie;
  }
});
