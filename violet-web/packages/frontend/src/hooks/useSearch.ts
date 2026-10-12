import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { searchArticles } from '../api/content';
import { getNextSearchPage, getPreviousSearchPage } from './search-page-model';
import type { SearchDateRange } from '@violet-web/shared';

interface SearchQueryOptions {
  enabled?: boolean;
  dateRange?: SearchDateRange;
}

export function useSearch(
  query: string,
  page: number,
  pageSize = 30,
  options: SearchQueryOptions = {},
) {
  return useQuery({
    queryKey: ['search', query, page, pageSize, options.dateRange?.from, options.dateRange?.to],
    queryFn: () => searchArticles(query, page, pageSize, options.dateRange),
    enabled: query.length > 0 && options.enabled !== false,
  });
}

export function useInfiniteSearch(
  query: string,
  pageSize = 30,
  options: SearchQueryOptions = {},
  initialPage = 0,
) {
  return useInfiniteQuery({
    queryKey: ['search-infinite', query, pageSize, options.dateRange?.from, options.dateRange?.to, initialPage],
    queryFn: ({ pageParam = 0 }) => searchArticles(query, pageParam, pageSize, options.dateRange),
    initialPageParam: initialPage,
    getNextPageParam: getNextSearchPage,
    getPreviousPageParam: getPreviousSearchPage,
    enabled: query.length > 0 && options.enabled !== false,
  });
}
