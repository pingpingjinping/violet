import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  translatePublicationQuery,
  translateQuery,
  translateTagSummaryQuery,
} from './query-engine.js';

test('adds inclusive normalized publication bounds', () => {
  const translated = translateQuery('lang:korean', 0, 30, false, {
    from: '2025-01-01',
    to: '2025-12-31',
  });
  assert.match(translated.sql, />= '2025-01-01 00:00:00'/);
  assert.match(translated.sql, /< '2026-01-01 00:00:00'/);
});

test('leaves publication normalization out without bounds', () => {
  assert.doesNotMatch(translateQuery('', 0, 30).sql, /datetime\(/);
});

test('splits visible and expunged rows so composite indexes can be used', () => {
  const translated = translateQuery('lang:korean', 0, 30, true);
  assert.match(translated.sql, /UNION ALL/);
  assert.match(translated.sql, /ExistOnHitomi=1/);
  assert.match(translated.sql, /ExistOnHitomi=0/);
  assert.match(translated.sql, /Tags LIKE '%\|expunged\|%'/);
  assert.doesNotMatch(
    translated.sql,
    /ExistOnHitomi=1 OR Tags LIKE '%\|expunged\|%'/,
  );
});

test('applies batched negative FTS once after the visible-id union', () => {
  const translated = translateQuery(
    'lang:korean -female:snuff -female:gore',
    0,
    30,
    true,
  );
  assert.equal(
    translated.sql.match(/FtsTags WHERE Tags MATCH/g)?.length,
    1,
  );
  assert.equal(
    translated.countSql.match(/FtsTags WHERE Tags MATCH/g)?.length,
    1,
  );
  assert.match(translated.countSql, /blocked AS MATERIALIZED/);
  assert.doesNotMatch(translated.countSql, /Id NOT IN/);
});

test('keeps existing visibility and fallback filtering semantics', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE HitomiColumnModel (
        Id INTEGER PRIMARY KEY,
        Language TEXT,
        ExistOnHitomi INTEGER,
        Tags TEXT,
        Published TEXT
      );

      INSERT INTO HitomiColumnModel VALUES
        (1, 'korean', 1, '|safe|', '2026-01-01'),
        (2, 'korean', 1, '|female:snuff|', '2026-01-02'),
        (3, 'korean', 0, '|expunged|', '2026-01-03'),
        (4, 'korean', 0, '|safe|', '2026-01-04'),
        (5, 'english', 1, '|safe|', '2026-01-05'),
        (6, 'korean', 1, '|female:gore|', '2026-01-06');
    `);

    const translated = translateQuery(
      'lang:korean -female:snuff -female:gore',
      0,
      30,
      false,
    );
    const ids = (db.prepare(translated.sql).all() as Array<{ Id: number }>)
      .map((row) => row.Id);
    const count = (db.prepare(translated.countSql).get() as { cnt: number }).cnt;

    assert.deepEqual(ids, [3, 1]);
    assert.equal(count, 2);
  } finally {
    db.close();
  }
});

test('uses optimized visible sources for date distribution and tag summary', () => {
  const publication = translatePublicationQuery(
    'lang:korean -female:snuff -female:gore',
    true,
  );
  const tagSql = translateTagSummaryQuery(
    'lang:korean -female:snuff -female:gore',
    true,
  );

  assert.match(publication.baseSql, /UNION ALL/);
  assert.match(publication.baseSql, /ExistOnHitomi=1/);
  assert.match(publication.baseSql, /ExistOnHitomi=0/);
  assert.match(publication.baseSql, /Tags LIKE '%\|expunged\|%'/);
  assert.doesNotMatch(publication.baseSql, /FtsTags WHERE Tags MATCH/);
  assert.ok(publication.blockedSql);
  assert.match(publication.blockedSql, /blocked AS MATERIALIZED/);
  assert.match(publication.blockedSql, /INDEXED BY idx_language_exist_published/);
  assert.equal(publication.blockedSql.match(/FtsTags WHERE Tags MATCH/g)?.length, 1);

  assert.match(tagSql, /UNION ALL/);
  assert.match(tagSql, /ExistOnHitomi=1/);
  assert.match(tagSql, /ExistOnHitomi=0/);
  assert.match(tagSql, /Tags LIKE '%\|expunged\|%'/);
  assert.equal(tagSql.match(/FtsTags WHERE Tags MATCH/g)?.length, 1);
});

test('keeps legacy date filtering when a negative FTS query has no language filter', () => {
  const publication = translatePublicationQuery('-female:snuff', true);
  assert.equal(publication.blockedSql, null);
  assert.match(publication.baseSql, /Id NOT IN/);
});
