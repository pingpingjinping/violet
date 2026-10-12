import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getNextSearchPage, getPreviousSearchPage, parseSearchPage } from './search-page-model.js';

test('deep page in URL is parsed as a zero-based page without losing the offset', () => {
  assert.equal(parseSearchPage('529'), 529); // Page 530 in the UI
  assert.equal(parseSearchPage(null), 0);
  assert.equal(parseSearchPage('-2'), 0);
  assert.equal(parseSearchPage('not-a-page'), 0);
});

test('pagination around page 530 supports both directions', () => {
  const current = { page: 529, pageSize: 30, totalCount: 30_000 };
  assert.equal(getPreviousSearchPage(current), 528);
  assert.equal(getNextSearchPage(current), 530);
});

test('the first and final pages have no further page in that direction', () => {
  assert.equal(getPreviousSearchPage({ page: 0, pageSize: 30, totalCount: 91 }), undefined);
  assert.equal(getNextSearchPage({ page: 3, pageSize: 30, totalCount: 91 }), undefined);
  assert.equal(getNextSearchPage({ page: 0, pageSize: 30, totalCount: 0 }), undefined);
});

test('after prepending pages, next page is still derived from the last loaded page', () => {
  assert.equal(getNextSearchPage({ page: 529, pageSize: 30, totalCount: 30_000 }), 530);
  assert.equal(getPreviousSearchPage({ page: 528, pageSize: 30, totalCount: 30_000 }), 527);
});
