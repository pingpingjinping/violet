import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveGallery } from './gallery-resolver.js';

const routing = "var gg = { b: 'cdn/', m: function(g) { var o = 0; return o; } };";
const hitomiGallery = `var galleryinfo = {"files":[{"hash":"${'a'.repeat(64)}"}]};`;
const metadata = { ehash: 'token', files: 1, thumbnail: null };
let nextId = 800000;

async function fixture(cookie: boolean, action: (id: number, calls: string[]) => Promise<void>,
  respond: (url: string, id: number) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  const previousCookie = process.env.EXHENTAI_COOKIE;
  const previousPath = process.env.EXHENTAI_COOKIE_PATH;
  process.env.EXHENTAI_COOKIE_PATH = `/tmp/violet-fallback-nonexistent-${process.pid}`;
  process.env.EXHENTAI_COOKIE = cookie ? 'ipb_member_id=1; ipb_pass_hash=test' : '';
  const id = nextId++;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return respond(url, id);
  };
  try { await action(id, calls); }
  finally {
    globalThis.fetch = originalFetch;
    if (previousCookie === undefined) delete process.env.EXHENTAI_COOKIE;
    else process.env.EXHENTAI_COOKIE = previousCookie;
    if (previousPath === undefined) delete process.env.EXHENTAI_COOKIE_PATH;
    else process.env.EXHENTAI_COOKIE_PATH = previousPath;
  }
}

function galleryHtml(id: number, key = 'image') {
  return `<div id="gdt"><a href="/s/${key}/${id}-1">page</a></div>`;
}

test('cold-start gg.js failure still reaches EH without an ExH cookie', async () => {
  await fixture(false, async (id, calls) => {
    const result = await resolveGallery(id, metadata);
    assert.deepEqual(result.urls, [`https://e-hentai.org/s/image/${id}-1`]);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].endsWith('/gg.js'));
    assert.ok(calls[1].startsWith('https://e-hentai.org/g/'));
  }, (url, id) => url.endsWith('/gg.js') ? new Response('', { status: 503 })
    : new Response(galleryHtml(id)));
});

test('Hitomi success does not contact either fallback source', async () => {
  await fixture(true, async (id, calls) => {
    const result = await resolveGallery(id, metadata);
    assert.equal(result.urls.length, 1);
    assert.ok(calls.every((url) => url.includes('gold-usergeneratedcontent.net')));
  }, (url) => new Response(url.endsWith('/gg.js') ? routing : hitomiGallery));
});

for (const failure of ['404', '403', '503', 'network', 'timeout', 'invalid-json', 'invalid-files', 'empty']) {
  test(`Hitomi ${failure} follows ExH MPV -> ExH legacy -> EH`, async () => {
    await fixture(true, async (id, calls) => {
      const result = await resolveGallery(id, metadata);
      assert.deepEqual(result.urls, [`https://e-hentai.org/s/image/${id}-1`]);
      assert.deepEqual(calls.map((url) => new URL(url).pathname), [
        `/galleries/${id}.js`, `/mpv/${id}/token/`, `/g/${id}/token/`, `/g/${id}/token/`,
      ]);
      assert.deepEqual(calls.map((url) => new URL(url).hostname), [
        'ltn.gold-usergeneratedcontent.net', 'exhentai.org', 'exhentai.org', 'e-hentai.org',
      ]);
    }, (url, id) => {
      if (url.includes('/galleries/')) {
        if (failure === 'network') throw new TypeError('fetch failed');
        if (failure === 'timeout') throw new DOMException('timed out', 'TimeoutError');
        if (failure === 'invalid-json') return new Response('not-json');
        if (failure === 'invalid-files') return new Response('{"files":{}}');
        if (failure === 'empty') return new Response('{"files":[]}');
        return new Response('', { status: Number(failure) });
      }
      if (url.startsWith('https://exhentai.org/')) return new Response('', { status: 503 });
      return new Response(galleryHtml(id));
    });
  });
}

test('ExH MPV success stops before either legacy source', async () => {
  await fixture(true, async (id, calls) => {
    const result = await resolveGallery(id, metadata);
    assert.deepEqual(result.urls, [`https://exhentai.org/s/mpv/${id}-1`]);
    assert.equal(calls.length, 2);
  }, (url) => url.includes('/galleries/') ? new Response('', { status: 404 })
    : new Response('var mpvkey = "key"; var imagelist = [{"k":"mpv"}];'));
});

test('ExH legacy success stops before EH', async () => {
  await fixture(true, async (id, calls) => {
    const result = await resolveGallery(id, metadata);
    assert.deepEqual(result.urls, [`https://exhentai.org/s/image/${id}-1`]);
    assert.equal(calls.length, 3);
  }, (url, id) => url.includes('/g/') ? new Response(galleryHtml(id))
    : new Response('', { status: 404 }));
});

test('no cookie skips all ExH requests', async () => {
  await fixture(false, async (id, calls) => {
    await resolveGallery(id, metadata);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].startsWith('https://e-hentai.org/g/'));
  }, (url, id) => url.includes('/galleries/') ? new Response('', { status: 404 })
    : new Response(galleryHtml(id)));
});

test('no EHash preserves the Hitomi error and makes no fallback requests', async () => {
  await fixture(true, async (id, calls) => {
    await assert.rejects(resolveGallery(id, { ...metadata, ehash: '  ' }), { code: 'UNAVAILABLE' });
    assert.equal(calls.length, 1);
  }, () => new Response('', { status: 404 }));
});

test('explicitly absent metadata preserves a network error', async () => {
  await fixture(true, async (id, calls) => {
    await assert.rejects(resolveGallery(id, null), { code: 'NETWORK_ERROR' });
    assert.equal(calls.length, 1);
  }, () => { throw new TypeError('fetch failed'); });
});

test('all sources failing retain the actionable bandwidth error', async () => {
  await fixture(true, async (id) => {
    await assert.rejects(resolveGallery(id, metadata), { code: 'BANDWIDTH_LIMIT' });
  }, (url) => new Response('', { status: url.includes('/mpv/') ? 509 : 404 }));
});

test('incomplete ExH lists fall through to complete EH results; concurrent requests share work', async () => {
  await fixture(true, async (id, calls) => {
    const [a, b] = await Promise.all([
      resolveGallery(id, { ...metadata, files: 2 }), resolveGallery(id, { ...metadata, files: 2 }),
    ]);
    assert.equal(a.urls.length, 2);
    assert.ok(a.urls.every((url) => url.startsWith('https://e-hentai.org/')));
    assert.equal(calls.filter((url) => url.includes('/galleries/')).length, 1);
    a.urls.push('caller-only');
    assert.equal(b.urls.length, 2);
  }, (url, id) => {
    if (url.includes('/galleries/')) return new Response('', { status: 404 });
    if (url.includes('/mpv/')) return new Response('var mpvkey = "key"; var imagelist = [{"k":"partial"}];');
    if (url.startsWith('https://exhentai.org/')) return new Response(galleryHtml(id));
    return new Response(galleryHtml(id) + `<a href="/s/second/${id}-2">page</a>`);
  });
});
