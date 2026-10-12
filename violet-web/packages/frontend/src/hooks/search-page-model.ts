import type { ArticleSearchResult } from '@violet-web/shared';

type SearchPageInfo = Pick<ArticleSearchResult, 'page' | 'pageSize' | 'totalCount'>;

/** Page numbers in the URL and the backend are zero based. */
export function parseSearchPage(raw: string | null): number {
  if (raw === null) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Use absolute page numbers, not the number of pages loaded so far. */
export function getNextSearchPage(lastPage: SearchPageInfo): number | undefined {
  const totalPages = Math.ceil(lastPage.totalCount / lastPage.pageSize);
  return lastPage.page + 1 < totalPages ? lastPage.page + 1 : undefined;
}

export function getPreviousSearchPage(firstPage: SearchPageInfo): number | undefined {
  return firstPage.page > 0 ? firstPage.page - 1 : undefined;
}
