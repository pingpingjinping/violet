import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { createGalleryZip } from './pc-download-zip';

const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);

test('creates an ordered ZIP preserving mixed image bytes and reports progress', async () => {
  const progress: number[][] = [];
  const signal = new AbortController().signal;
  const blob = await createGalleryZip(['first', 'second'], async (url, passedSignal) => {
    assert.equal(passedSignal, signal);
    return url === 'first' ? jpg : png;
  }, signal, (done, total) => progress.push([done, total]));
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(blob.type, 'application/zip');
  assert.deepEqual(Object.keys(files), ['000001.jpg', '000002.png']);
  assert.deepEqual(files['000001.jpg'], jpg);
  assert.deepEqual(files['000002.png'], png);
  assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
});

test('rejects an empty gallery', async () => {
  await assert.rejects(createGalleryZip([], async () => jpg, new AbortController().signal, () => {}), /noImages/);
});

test('does not return a partial ZIP when a later image request fails', async () => {
  await assert.rejects(createGalleryZip(['first', 'second'], async (url) => {
    if (url === 'second') throw new Error('network failed');
    return jpg;
  }, new AbortController().signal, () => {}), /network failed/);
});

test('rejects HTML masquerading as an image', async () => {
  await assert.rejects(createGalleryZip(['first'], async () => new TextEncoder().encode('<html>login required</html>'), new AbortController().signal, () => {}), /invalidImage/);
});

test('cancellation after a response prevents subsequent requests and ZIP creation', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(createGalleryZip(['first', 'second'], async () => {
    calls++;
    controller.abort();
    return jpg;
  }, controller.signal, () => {}), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('an already cancelled download makes no requests', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createGalleryZip(['first'], async () => {
    assert.fail('must not fetch');
  }, controller.signal, () => {}), { name: 'AbortError' });
});
