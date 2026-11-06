import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import type { Response as ExpressResponse } from 'express';
import { proxyImage, publicImageLookup, resolveImageSource } from './image-proxy.js';
import { MediaError } from './media-error.js';

test('proxy rejects internal and unapproved URLs before fetching', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(); };
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    for (const url of [
      'http://127.0.0.1:3001/private', 'https://[::1]/', 'https://2130706433/',
      'https://169.254.169.254/', 'https://localhost/',
      'https://ehgt.org.attacker.test/image.jpg', 'https://fakehath.network/image.jpg',
      'https://name:secret@ehgt.org/image.jpg', 'https://ehgt.org:8443/image.jpg',
    ]) {
      await assert.rejects(proxyImage(url, undefined, response as unknown as ExpressResponse));
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; response.destroy(); }
});

test('connection DNS lookup rejects non-public addresses, including mapped IPv4', async () => {
  const resolve = (hostname: string, all = false) => new Promise((done, fail) => {
    publicImageLookup(hostname, { all }, (error, address) => {
      if (error) fail(error);
      else done(address);
    });
  });
  for (const address of [
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.168.0.1',
    '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '64:ff9b::a00:1',
  ]) {
    await assert.rejects(resolve(address, true), /no public address/);
  }
  assert.equal(await resolve('1.1.1.1'), '1.1.1.1');
  assert.deepEqual(await resolve('2606:4700:4700::1111', true), [
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
});

test('validates each redirect before following and caps redirect chains', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let target = '/image.webp';
  globalThis.fetch = async (input, options) => {
    calls.push(String(input));
    assert.equal(options?.redirect, 'manual');
    assert.ok(options && 'dispatcher' in options);
    return new Response(null, { status: 302, headers: { Location: target } });
  };
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const source = 'https://w1.gold-usergeneratedcontent.net/image.webp';
  try {
    for (const unsafe of ['https://127.0.0.1/private', 'http://ehgt.org/image.jpg', '//not-hath.network/image.jpg']) {
      target = unsafe;
      await assert.rejects(proxyImage(source, undefined, response as unknown as ExpressResponse));
      assert.deepEqual(calls.splice(0), [source]);
    }
    target = '/image.webp';
    await assert.rejects(proxyImage(source, undefined, response as unknown as ExpressResponse));
    assert.deepEqual(calls, Array(5).fill(source));
  } finally { globalThis.fetch = originalFetch; response.destroy(); }
});

test('allows a public Hentai@Home redirect with a custom HTTPS port without forwarding cookies', async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.EXHENTAI_COOKIE;
  process.env.EXHENTAI_COOKIE = 'ipb_member_id=123; ipb_pass_hash=fixture';
  const headers: Headers[] = [];
  const target = 'https://node.hath.network:4433/image.webp';
  globalThis.fetch = async (input, options) => {
    headers.push(new Headers(options?.headers));
    return String(input) === target
      ? new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/webp' } })
      : new Response(null, { status: 302, headers: { Location: target } });
  };
  const response = Object.assign(new Writable({
    write(_chunk, _encoding, callback) { callback(); },
  }), { setHeader: () => {} });
  try {
    await proxyImage('https://ehgt.org/image.webp', undefined, response as unknown as ExpressResponse);
    assert.equal(headers.length, 2);
    assert.ok(headers[0].has('cookie'));
    assert.equal(headers[1].has('cookie'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCookie === undefined) delete process.env.EXHENTAI_COOKIE;
    else process.env.EXHENTAI_COOKIE = originalCookie;
    response.destroy();
  }
});

test('rejects non-provider targets extracted from EH pages or returned by MPV', async () => {
  const originalFetch = globalThis.fetch;
  const page = 'https://exhentai.org/s/test/900012-1';
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response('<img id="img" src="https://127.0.0.1/internal">');
  };
  try {
    await assert.rejects(resolveImageSource(page, undefined, undefined, async () => ({
      url: 'https://unapproved.test/image.jpg',
      referer: page,
    })));
    assert.deepEqual(calls, [page]);
    assert.equal(
      (await resolveImageSource('http://aa.hitomi.la/image.webp')).url,
      'https://aa.gold-usergeneratedcontent.net/image.webp',
    );
  } finally { globalThis.fetch = originalFetch; }
});

test('EH fallback image pages stay on EH without retrying ExH MPV', async () => {
  const originalFetch = globalThis.fetch;
  const url = 'https://e-hentai.org/s/test/900011-1';
  globalThis.fetch = async (input) => {
    assert.equal(String(input), url);
    return new Response('<img id="img" src="https://ehgt.org/image.jpg">');
  };
  try {
    const result = await resolveImageSource(url, undefined, undefined,
      async () => { assert.fail('EH must not retry ExH MPV'); });
    assert.equal(result.url, 'https://ehgt.org/image.jpg');
  } finally { globalThis.fetch = originalFetch; }
});

test('HTTP 509 from image upstream is a typed bandwidth error, never image bytes', async () => {
  const originalFetch = globalThis.fetch;
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  globalThis.fetch = async () => new Response('limit', { status: 509 });
  try {
    await assert.rejects(proxyImage('https://w1.gold-usergeneratedcontent.net/image.webp', undefined,
      response as unknown as ExpressResponse), { code: 'BANDWIDTH_LIMIT' });
  } finally { globalThis.fetch = originalFetch; response.destroy(); }
});

test('HTML returned instead of an image is not streamed or cached as a successful image', async () => {
  const originalFetch = globalThis.fetch;
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  globalThis.fetch = async () => new Response('<html>maintenance</html>', {
    headers: { 'Content-Type': 'text/html' },
  });
  try {
    await assert.rejects(proxyImage('https://w1.gold-usergeneratedcontent.net/image.webp', undefined,
      response as unknown as ExpressResponse), { code: 'UPSTREAM_ERROR' });
  } finally { globalThis.fetch = originalFetch; response.destroy(); }
});

test('MPV bandwidth errors survive a generic legacy fallback failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>maintenance</html>');
  try {
    await assert.rejects(resolveImageSource('https://exhentai.org/s/test/900009-1',
      undefined, undefined, async () => { throw new MediaError('BANDWIDTH_LIMIT'); }),
    { code: 'BANDWIDTH_LIMIT' });
  } finally { globalThis.fetch = originalFetch; }
});

test('legacy 509 placeholder is rejected before it enters the image cache', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<img id="img" src="https://ehgt.org/g/509.gif">');
  try {
    await assert.rejects(resolveImageSource('https://exhentai.org/s/test/900010-1',
      undefined, undefined, async () => null), { code: 'BANDWIDTH_LIMIT' });
  } finally { globalThis.fetch = originalFetch; }
});

test('slow receivers exert backpressure without changing image bytes or headers', async () => {
  const originalFetch = globalThis.fetch;
  let produced = 0;
  let received = 0;
  let release: (() => void) | undefined;
  let firstWrite!: () => void;
  const started = new Promise<void>((resolve) => { firstWrite = resolve; });
  const headers = new Map<string, unknown>();
  const response = Object.assign(new Writable({
    highWaterMark: 1024,
    write(chunk, _encoding, callback) {
      received += chunk.length;
      assert.ok(chunk.every((byte: number) => byte === 7));
      if (!release) { release = callback; firstWrite(); } else callback();
    },
  }), { setHeader: (key: string, value: unknown) => headers.set(key, value) });
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      if (produced === 64) { controller.close(); return; }
      produced++;
      controller.enqueue(new Uint8Array(65536).fill(7));
    },
  }), { headers: { 'Content-Type': 'image/webp', 'Content-Length': String(64 * 65536) } });
  try {
    const transfer = proxyImage('https://w1.gold-usergeneratedcontent.net/image.webp', undefined, response as unknown as ExpressResponse);
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(produced < 64, 'must stop pulling while response buffer is full');
    release!();
    await transfer;
    assert.equal(received, 64 * 65536);
    assert.equal(headers.get('Content-Type'), 'image/webp');
    assert.equal(headers.get('Cache-Control'), 'public, max-age=86400');
  } finally { globalThis.fetch = originalFetch; response.destroy(); }
});

test('receiver disconnect aborts an upstream request still waiting for headers', async () => {
  const originalFetch = globalThis.fetch;
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  let aborted = false;
  globalThis.fetch = async (_input, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  });
  try {
    const transfer = proxyImage('https://w1.gold-usergeneratedcontent.net/image.webp', undefined, response as unknown as ExpressResponse);
    response.destroy();
    await assert.rejects(transfer, /aborted/);
    assert.equal(aborted, true);
    assert.equal(response.listenerCount('close'), 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('prefers an MPV-dispatched normal image and preserves its MPV referer', async () => {
  const source = await resolveImageSource(
    'https://exhentai.org/s/abc/900001-1',
    undefined,
    undefined,
    async () => ({
      url: 'https://node.hath.network/normal.webp',
      referer: 'https://exhentai.org/mpv/900001/token/',
    }),
  );

  assert.equal(source.url, 'https://node.hath.network/normal.webp');
  assert.equal(source.headers.Referer, 'https://exhentai.org/mpv/900001/token/');
});

test('falls back to the existing /s/ HTML resolver when MPV resolution fails', async () => {
  const originalFetch = globalThis.fetch;
  const pageUrl = 'https://exhentai.org/s/def/900002-1';
  globalThis.fetch = async (input) => {
    assert.equal(String(input), pageUrl);
    return new Response('<html><img id="img" src="https://fallback.hath.network/fallback.webp"></html>');
  };

  try {
    const source = await resolveImageSource(
      pageUrl,
      undefined,
      undefined,
      async () => { throw new Error('MPV unavailable'); },
    );
    assert.equal(source.url, 'https://fallback.hath.network/fallback.webp');
    assert.equal(source.headers.Referer, pageUrl);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
