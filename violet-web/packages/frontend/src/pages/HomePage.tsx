import { useRef, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useSearch, useInfiniteSearch } from '../hooks/useSearch';
import { useAppStore } from '../stores/app-store';
import { usePaginationKeyboard } from '../hooks/usePaginationKeyboard';
import { parseSearchPage } from '../hooks/search-page-model';
import { useResultGridKeyboard } from '../hooks/useResultGridKeyboard';
import { SearchResultGrid } from '../components/search/SearchResultGrid';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { InfiniteScroll } from '../components/common/InfiniteScroll';
import styles from './HomePage.module.css';

export function HomePage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  const page = parseSearchPage(searchParams.get('p'));
  const from = searchParams.get('from') || undefined;
  const to = searchParams.get('to') || undefined;
  const dateRange = { from, to };
  const { contentLanguage, scrollMode, excludedTags } = useAppStore();

  const setPage = useCallback(
    (updater: number | ((prev: number) => number)) => {
      const newPage = typeof updater === 'function' ? updater(page) : updater;
      const newParams = new URLSearchParams(searchParams);
      if (newPage === 0) {
        newParams.delete('p');
      } else {
        newParams.set('p', String(newPage));
      }
      setSearchParams(newParams);
    },
    [page, searchParams, setSearchParams],
  );

  useEffect(() => {
    document.title = query ? `${query} - Violet` : 'Violet';
    return () => { document.title = 'Violet'; };
  }, [query]);

  const baseQuery =
    contentLanguage !== 'all' ? `${query} lang:${contentLanguage}` : query;

  const excludeSuffix = excludedTags
    .filter((tag) => !query.includes(`-${tag}`))
    .map((tag) => `-${tag}`)
    .join(' ');
  const fullQuery = excludeSuffix ? `${baseQuery} ${excludeSuffix}` : baseQuery;

  // Pagination mode
  const { data, isLoading } = useSearch(
    scrollMode === 'pagination' ? (fullQuery || ' ') : '',
    page,
    30,
    { dateRange },
  );

  // Infinite scroll mode
  const {
    data: infiniteData,
    isLoading: infiniteLoading,
    hasNextPage,
    hasPreviousPage,
    isFetchingNextPage,
    isFetchingPreviousPage,
    fetchNextPage,
    fetchPreviousPage,
  } = useInfiniteSearch(
    scrollMode === 'infinite' ? (fullQuery || ' ') : '',
    30,
    { dateRange },
    page,
  );

  const handleLoadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  const handleLoadPrevious = useCallback(() => {
    void fetchPreviousPage();
  }, [fetchPreviousPage]);

  const totalPages = data ? Math.ceil(data.totalCount / data.pageSize) : 0;
  const lastTotalPagesRef = useRef(0);
  if (totalPages > 0) lastTotalPagesRef.current = totalPages;
  const displayTotalPages = totalPages || lastTotalPagesRef.current;

  usePaginationKeyboard(page, displayTotalPages, setPage, scrollMode === 'pagination');

  const displayedArticles = scrollMode === 'infinite'
    ? (infiniteData?.pages.flatMap((p) => p.articles) ?? [])
    : (data?.articles ?? []);

  const keyboardSelectedId = useResultGridKeyboard(
    displayedArticles,
    [query, page, scrollMode, from, to, contentLanguage].join('|'),
  );

  if (scrollMode === 'infinite') {
    return (
      <div className={styles.page}>
        {infiniteLoading && !infiniteData && <LoadingSpinner />}
        <InfiniteScroll
          key={[fullQuery, page, from, to].join('|')}
          hasMore={!!hasNextPage}
          loading={isFetchingNextPage}
          onLoadMore={handleLoadMore}
          hasPrevious={!!hasPreviousPage}
          loadingPrevious={isFetchingPreviousPage}
          onLoadPrevious={handleLoadPrevious}
          firstPage={infiniteData?.pages[0]?.page}
        >
          <SearchResultGrid
            articles={displayedArticles}
            keyboardSelectedId={keyboardSelectedId}
            keyboardNavigation
          />
        </InfiniteScroll>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {isLoading && <LoadingSpinner />}
      {data && (
        <SearchResultGrid
          articles={data.articles}
          keyboardSelectedId={keyboardSelectedId}
          keyboardNavigation
        />
      )}
      {displayTotalPages > 1 && (
        <div className={styles.pagination}>
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            {t('home.prev')}
          </button>
          <span>
            {page + 1} / {displayTotalPages}
          </span>
          <button
            disabled={page >= displayTotalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('home.next')}
          </button>
        </div>
      )}
    </div>
  );
}
