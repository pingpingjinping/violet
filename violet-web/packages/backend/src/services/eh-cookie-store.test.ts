import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  clearStoredEhCookie,
  getEhCookie,
  getEhCookieStatus,
  saveEhCookie,
} from './eh-cookie-store.js';

const originalCookie = process.env.EXHENTAI_COOKIE;
const originalPath = process.env.EXHENTAI_COOKIE_PATH;
const temporaryDirectories: string[] = [];

function useTemporaryCookiePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'violet-eh-cookie-'));
  temporaryDirectories.push(directory);
  const cookiePath = path.join(directory, 'cookie.txt');
  process.env.EXHENTAI_COOKIE_PATH = cookiePath;
  delete process.env.EXHENTAI_COOKIE;
  return cookiePath;
}

afterEach(() => {
  if (originalCookie === undefined) delete process.env.EXHENTAI_COOKIE;
  else process.env.EXHENTAI_COOKIE = originalCookie;
  if (originalPath === undefined) delete process.env.EXHENTAI_COOKIE_PATH;
  else process.env.EXHENTAI_COOKIE_PATH = originalPath;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stores a validated cookie without exposing it through status', () => {
  const cookiePath = useTemporaryCookiePath();
  const cookie = 'ipb_member_id=1; ipb_pass_hash=secret; igneous=value';

  assert.deepEqual(saveEhCookie(cookie), {
    configured: true,
    source: 'stored',
  });
  assert.equal(getEhCookie(), cookie);
  assert.deepEqual(getEhCookieStatus(), {
    configured: true,
    source: 'stored',
  });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(cookiePath).mode & 0o777, 0o600);
  }
});

test('rejects incomplete cookies and falls back to the environment after clear', () => {
  useTemporaryCookiePath();
  assert.throws(
    () => saveEhCookie('ipb_member_id=1; ipb_pass_hash=secret'),
    /igneous/,
  );

  process.env.EXHENTAI_COOKIE = 'legacy=environment';
  saveEhCookie('ipb_member_id=1; ipb_pass_hash=secret; igneous=value');
  assert.deepEqual(clearStoredEhCookie(), {
    configured: true,
    source: 'environment',
  });
  assert.equal(getEhCookie(), 'legacy=environment');
});
