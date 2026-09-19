import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEhMpvResolver, createEhMpvService } from './eh-mpv.js';

test('MPV gallery pages and image dispatch share cached metadata and use only the normal image URL', async () => {
  const mpvUrl = 'https://exhentai.org/mpv/123/gallery-token/';
  let mpvRequests = 0;
  const apiBodies: Array<Record<string, unknown>> = [];

  const service = createEhMpvService({
    getCookie: () => 'ipb_member_id=1; ipb_pass_hash=x',
    getEhash: () => 'gallery-token',
    refreshCookie: async () => false,
    now: () => 1234,
    fetchFn: async (input, init) => {
      const url = String(input);
      if (url === mpvUrl) {
        mpvRequests++;
        return new Response(
          '<script>var mpvkey = "mpv-key"; var imagelist = [{"k":"img-1"},{"k":"img-2"}];</script>',
        );
      }

      assert.equal(url, 'https://s.exhentai.org/api.php');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      apiBodies.push(body);
      const page = Number(body.page);
      return new Response(JSON.stringify({
        i: `https://node.hath.network/page-${page}.webp`,
        lf: `fullimg/123/${page}/original.png`,
      }), { headers: { 'Content-Type': 'application/json' } });
    },
  });

  const gallery = await service.resolveGalleryPages(123, 'gallery-token');
  assert.deepEqual(gallery, {
    referer: mpvUrl,
    urls: [
      'https://exhentai.org/s/img-1/123-1',
      'https://exhentai.org/s/img-2/123-2',
    ],
  });

  const first = await service.resolveImage('https://exhentai.org/s/img-1/123-1');
  const second = await service.resolveImage('https://exhentai.org/s/img-2/123-2');

  assert.deepEqual(first, {
    url: 'https://node.hath.network/page-1.webp',
    referer: mpvUrl,
  });
  assert.deepEqual(second, {
    url: 'https://node.hath.network/page-2.webp',
    referer: mpvUrl,
  });
  assert.equal(mpvRequests, 1, 'gallery listing and image dispatch must share one MPV metadata request');
  assert.deepEqual(apiBodies, [
    { method: 'imagedispatch', gid: 123, page: 1, imgkey: 'img-1', mpvkey: 'mpv-key' },
    { method: 'imagedispatch', gid: 123, page: 2, imgkey: 'img-2', mpvkey: 'mpv-key' },
  ]);
  assert.equal(first?.url.includes('fullimg'), false, 'original image path must never be selected');
});

test('MPV resolver is skipped when no ExHentai cookie is configured', async () => {
  let fetches = 0;
  const resolver = createEhMpvResolver({
    getCookie: () => null,
    getEhash: () => 'gallery-token',
    refreshCookie: async () => false,
    fetchFn: async () => {
      fetches++;
      return new Response();
    },
  });

  assert.equal(await resolver('https://exhentai.org/s/a/123-1'), null);
  assert.equal(fetches, 0);
});
