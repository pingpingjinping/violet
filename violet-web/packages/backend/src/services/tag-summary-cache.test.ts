import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { test } from 'node:test';
import { PersistentTagSummaryCache } from './tag-summary-cache.js';

function tag(name: string) {
  return {
    category: 'tag' as const,
    tag: name,
    count: 1,
    display: `tag:${name}`,
  };
}

test('persists entries and invalidates them when the DB or WAL changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'violet-tag-summary-'));
  const dbPath = join(dir, 'data.db');
  const cachePath = join(dir, 'tag-summary-cache.json');

  try {
    writeFileSync(dbPath, 'db');

    const first = new PersistentTagSummaryCache(cachePath, dbPath, 5);
    first.load();
    first.set('q', { tags: [tag('one')], ts: 1 });
    first.flush();

    const second = new PersistentTagSummaryCache(cachePath, dbPath, 5);
    second.load();
    assert.deepEqual(second.get('q')?.tags, [tag('one')]);

    writeFileSync(`${dbPath}-wal`, 'wal');
    assert.equal(second.refreshIfChanged(), true);
    assert.equal(second.get('q'), undefined);

    second.set('q2', { tags: [tag('two')], ts: 2 });
    second.flush();

    appendFileSync(dbPath, 'x');
    assert.equal(second.refreshIfChanged(), true);
    assert.equal(second.get('q2'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps only the newest configured number of entries across reloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'violet-tag-summary-'));
  const dbPath = join(dir, 'data.db');
  const cachePath = join(dir, 'tag-summary-cache.json');

  try {
    writeFileSync(dbPath, 'db');

    const first = new PersistentTagSummaryCache(cachePath, dbPath, 2);
    first.load();
    first.set('one', { tags: [tag('one')], ts: 1 });
    first.set('two', { tags: [tag('two')], ts: 2 });
    first.set('three', { tags: [tag('three')], ts: 3 });
    first.flush();

    const second = new PersistentTagSummaryCache(cachePath, dbPath, 2);
    second.load();
    assert.equal(second.get('one'), undefined);
    assert.ok(second.get('two'));
    assert.ok(second.get('three'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
