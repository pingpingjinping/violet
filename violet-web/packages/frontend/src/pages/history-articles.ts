/** Stable membership for metadata caching; reading order is applied separately. */
export function historyArticleIds(entries: readonly { articleId: string }[]): string[] {
  return [...new Set(entries.map((entry) => entry.articleId))].sort();
}

export function orderHistoryArticles<T extends { Id: number }>(
  entries: readonly { articleId: string }[], articles: readonly T[],
): T[] {
  const byId = new Map(articles.map((article) => [String(article.Id), article]));
  const result: T[] = [];
  for (const entry of entries) {
    const article = byId.get(entry.articleId);
    if (article) {
      result.push(article);
      byId.delete(entry.articleId);
    }
  }
  return result;
}
