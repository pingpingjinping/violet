import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  translateDateDistributionQuery,
  translateQuery,
} from './query-engine.js';

test('adds inclusive normalized publication bounds', () => {
  const translated = translateQuery('lang:korean', 0, 30, false, {
    from: '2025-01-01',
    to: '2025-12-31',
  });
  assert.match(translated.sql, />= '2025-01-01 00:00:00'/);
  assert.match(translated.sql, /< '2026-01-01 00:00:00'/);
});

test('leaves legacy SQL unchanged without bounds', () => {
  assert.doesNotMatch(translateQuery('', 0, 30).sql, /datetime\(/);
});


test('splits visible gallery rows into indexed branches', () => {
  const translated = translateQuery(
    'lang:korean -female:snuff -female:gore',
    0,
    30,
    true,
  );

  for (const sql of [translated.sql, translated.countSql]) {
    assert.match(sql, /UNION ALL/);
    assert.match(sql, /ExistOnHitomi=1/);
    assert.match(sql, /ExistOnHitomi=0/);
    assert.match(sql, /Tags LIKE '%\\|expunged\\|%'/);
    assert.doesNotMatch(sql, /ExistOnHitomi=1 OR Tags LIKE/);
  }

  assert.equal((translated.sql.match(/FROM FtsTags/g) ?? []).length, 1);
  assert.equal((translated.countSql.match(/FROM FtsTags/g) ?? []).length, 1);
});

test('uses a narrow published source for date distribution', () => {
  const sql = translateDateDistributionQuery(
    'lang:korean -female:snuff -female:gore',
    true,
  );
  assert.match(sql, /SELECT Id, Published/);
  assert.match(sql, /UNION ALL/);
  assert.equal((sql.match(/FROM FtsTags/g) ?? []).length, 1);
});

test('keeps numeric ID lookup on the legacy direct path', () => {
  const translated = translateQuery('4203127', 0, 30, true);
  assert.doesNotMatch(translated.sql, /visible_ids/);
  assert.match(translated.sql, /WHERE Id=4203127/);
});
