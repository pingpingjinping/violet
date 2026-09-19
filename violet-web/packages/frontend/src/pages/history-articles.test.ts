import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyArticleIds, orderHistoryArticles } from './history-articles';

test('rereading changes presentation order without changing metadata membership', () => {
  const before = [{ articleId: '12' }, { articleId: '34' }, { articleId: '56' }];
  const after = [before[2], before[0], before[1]];
  const articles = [{ Id: 34 }, { Id: 56 }, { Id: 12 }];
  assert.deepEqual(historyArticleIds(before), historyArticleIds(after));
  assert.deepEqual(orderHistoryArticles(after, articles).map(a => a.Id), [56, 12, 34]);
  assert.equal(orderHistoryArticles(after, articles)[0], articles[1]);
  assert.deepEqual(articles.map(a => a.Id), [34, 56, 12]);
});

test('added and removed works change membership, duplicate records do not', () => {
  const entries = [{ articleId: '12' }, { articleId: '34' }];
  assert.deepEqual(historyArticleIds([...entries, entries[0]]), historyArticleIds(entries));
  assert.notDeepEqual(historyArticleIds([...entries, { articleId: '56' }]), historyArticleIds(entries));
  assert.notDeepEqual(historyArticleIds(entries.slice(1)), historyArticleIds(entries));
});

test('empty histories and missing database articles render no stale or duplicate works', () => {
  const articles = [{ Id: 12 }, { Id: 34 }];
  assert.deepEqual(orderHistoryArticles([], articles), []);
  assert.deepEqual(orderHistoryArticles([{ articleId: '99' }, { articleId: '12' }, { articleId: '12' }], articles), [articles[0]]);
});
