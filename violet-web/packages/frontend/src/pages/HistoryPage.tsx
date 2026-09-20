import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { getHistoryEntries } from '../api/history';
import { useAllArticles } from '../hooks/useAllArticles';
import { historyArticleIds, orderHistoryArticles } from './history-articles';
import { LocalSearchSection } from '../components/search/LocalSearchSection';
import { SearchResultGrid } from '../components/search/SearchResultGrid';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { InfiniteScroll } from '../components/common/InfiniteScroll';
import { useArticleTagSummary } from '../hooks/useArticleTagSummary';
import { useLocalArticleSearch } from '../hooks/useLocalArticleSearch';
import { useLocalSearchState } from '../hooks/useLocalSearchState';
import { useAppStore } from '../stores/app-store';
import { usePaginationKeyboard } from '../hooks/usePaginationKeyboard';
import { useResultGridKeyboard } from '../hooks/useResultGridKeyboard';
import styles from './HistoryPage.module.css';
import { DateRangeFilter } from '../components/search/DateRangeFilter';
import { updateDateParams } from '../components/search/date-range-model';
import { buildLocalDateDistribution, filterItemsByDateRange } from '../components/search/local-date-range-model';

const PAGE_SIZE = 30;

// A browser back-navigation restores the same React Router location key.
// Remember keys seen in this page lifetime so returning from the viewer can
// reuse the existing history cache without immediately reordering the list.
const visitedHistoryLocationKeys = new Set<string>();

export function HistoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { scrollMode } = useAppStore();

  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get('p') || '0');
  const from = searchParams.get('from') || undefined;
  const to = searchParams.get('to') || undefined;
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
  const location = useLocation();
  const isHistoryReturn = visitedHistoryLocationKeys.has(location.key);

  useEffect(() => {
    visitedHistoryLocationKeys.add(location.key);
  }, [location.key]);

  const visibleKey = `history-visible:${location.key}`;
  const readVisibleCount = () => {
    try {
      const value = Number(sessionStorage.getItem(visibleKey));
      return Number.isSafeInteger(value) && value >= PAGE_SIZE ? value : PAGE_SIZE;
    } catch { return PAGE_SIZE; }
  };
  const [visibleState, setVisibleState] = useState(() => ({
    key: visibleKey, count: readVisibleCount(),
  }));
  const visibleCount = visibleState.key === visibleKey ? visibleState.count : readVisibleCount();

  // Fetch all history article IDs
  const { data: historyEntries, isLoading: idsLoading } = useQuery({
    queryKey: ['readHistory', 'ids'],
    queryFn: getHistoryEntries,
    refetchOnMount: !isHistoryReturn,
  });
  const articleIds = useMemo(
    () => historyEntries && historyArticleIds(historyEntries),
    [historyEntries],
  );

  // Fetch all articles in bulk
  const { data: articleDetails, isLoading: articlesLoading } = useAllArticles(
    'historyArticleDetails',
    articleIds,
  );

  // Reading changes dates/order, not article metadata. Keep its cache independent
  // of readHistory invalidation, then apply the current reading order locally.
  const allArticles = useMemo(
    () => orderHistoryArticles(historyEntries ?? [], articleDetails ?? []),
    [historyEntries, articleDetails],
  );
  const isLoading = idsLoading || (!!articleIds?.length && articlesLoading);

  // Tag summary from ALL articles
  const tagSummary = useArticleTagSummary(allArticles ?? []);

  // Filter articles based on search query
  const searchFilteredArticles = useLocalArticleSearch(allArticles ?? []);
  const historyDateByArticle = useMemo(
    () => new Map(historyEntries?.map((entry) => [entry.articleId, entry.date])),
    [historyEntries],
  );
  const dateDistribution = useMemo(
    () => buildLocalDateDistribution(
      searchFilteredArticles.map((article) => historyDateByArticle.get(String(article.Id)) ?? ''),
    ),
    [searchFilteredArticles, historyDateByArticle],
  );
  const filteredArticles = useMemo(
    () => filterItemsByDateRange(
      searchFilteredArticles,
      (article) => historyDateByArticle.get(String(article.Id)) ?? '',
      from,
      to,
    ),
    [searchFilteredArticles, historyDateByArticle, from, to],
  );

  // Paginate/slice filtered results for display
  const totalPages = Math.ceil(filteredArticles.length / PAGE_SIZE);
  const displayArticles = useMemo(
    () => scrollMode === 'infinite'
      ? filteredArticles.slice(0, visibleCount)
      : filteredArticles.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filteredArticles, scrollMode, visibleCount, page],
  );

  const keyboardSelectedId = useResultGridKeyboard(
    displayArticles,
    ['history', page, scrollMode, searchParams.toString()].join('|'),
  );

  usePaginationKeyboard(page, totalPages, setPage, scrollMode === 'pagination');

  const handleReset = useCallback(() => {
    navigate('/history', { replace: true });
  }, [navigate]);

  const { selectedTags, searchBarRef, getSuggestions, handleTagToggle } =
    useLocalSearchState({
      basePath: '/history',
      tagSummary,
      onReset: handleReset,
    });

  const handleLoadMore = useCallback(() => {
    const count = visibleCount + PAGE_SIZE;
    try { sessionStorage.setItem(visibleKey, String(count)); } catch { /* Optional restoration. */ }
    setVisibleState({ key: visibleKey, count });
  }, [visibleCount, visibleKey]);

  const hasMore = scrollMode === 'infinite' && visibleCount < filteredArticles.length;

  return (
    <div className={styles.page}>
      <LocalSearchSection
        basePath="/history"
        searchBarRef={searchBarRef}
        getSuggestions={getSuggestions}
        tagSummary={tagSummary}
        selectedTags={selectedTags}
        onTagToggle={handleTagToggle}
        resultCount={filteredArticles.length}
        isLoading={isLoading}
        sticky
        dateRangeContent={
          <DateRangeFilter
            compact
            query=""
            from={from}
            to={to}
            distributionData={dateDistribution}
            distributionLoading={isLoading}
            onCommit={(nextFrom, nextTo) =>
              setSearchParams(updateDateParams(searchParams, nextFrom, nextTo))
            }
          />
        }
      />

      {scrollMode === 'infinite' ? (
        <>
          {isLoading && <LoadingSpinner />}
          {!isLoading && (
            <InfiniteScroll
              hasMore={hasMore}
              loading={false}
              onLoadMore={handleLoadMore}
            >
              <SearchResultGrid
                articles={displayArticles}
                keyboardSelectedId={keyboardSelectedId}
                keyboardNavigation
              />
            </InfiniteScroll>
          )}
        </>
      ) : (
        <>
          {isLoading && <LoadingSpinner />}
          {!isLoading && (
            <SearchResultGrid
              articles={displayArticles}
              keyboardSelectedId={keyboardSelectedId}
              keyboardNavigation
            />
          )}

          {totalPages > 1 && (
            <div className={styles.pagination}>
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                {t('home.prev')}
              </button>
              <span>
                {page + 1} / {totalPages}
              </span>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('home.next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
