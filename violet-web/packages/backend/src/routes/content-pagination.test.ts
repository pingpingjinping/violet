import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { closeContentDb } from '../services/content-db.js';

test('search pagination rejects invalid limits and retains defaults and caps', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'violet-search-pagination-'));
  const previousPath = process.env.DATA_DB_PATH;
  const path = join(dir, 'data.db');
  process.env.DATA_DB_PATH = path;
  t.after(() => {
    closeContentDb();
    if (previousPath === undefined) delete process.env.DATA_DB_PATH;
    else process.env.DATA_DB_PATH = previousPath;
    rmSync(dir, { force: true, recursive: true });
  });

  const { contentRouter } = await import('./content.js');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE HitomiColumnModel (Id INTEGER PRIMARY KEY, ExistOnHitomi INTEGER, Tags TEXT);
    WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 125)
    INSERT INTO HitomiColumnModel SELECT n, 1, '' FROM ids;
  `);
  db.close();

  const server = express().use('/api/content', contentRouter).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/api/content/search`;

  for (const query of [
    'pageSize=-1', 'pageSize=0', 'pageSize=1.5', 'pageSize=30oops',
    'pageSize=1&pageSize=100', 'page=-1', 'page=9007199254740991&pageSize=100',
  ]) {
    const response = await fetch(`${url}?${query}`);
    assert.equal(response.status, 400, query);
    await response.text();
  }

  const first = await fetch(url).then((response) => response.json());
  assert.equal(first.pageSize, 30);
  assert.equal(first.articles.length, 30);
  const capped = await fetch(`${url}?page=0&pageSize=1000`).then((response) => response.json());
  assert.equal(capped.pageSize, 100);
  assert.equal(capped.articles.length, 100);
  const next = await fetch(`${url}?page=1&pageSize=2`).then((response) => response.json());
  assert.deepEqual(next.articles.map((article: { Id: number }) => article.Id), [123, 122]);
});
