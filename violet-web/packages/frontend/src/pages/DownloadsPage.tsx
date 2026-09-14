import { ScopedMessageSearchButton } from '../components/message-search/ScopedMessageSearchButton';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { getDownloadEntries, getDownloads } from '../api/downloads';
import type { DownloadRecord } from '@violet-web/shared';
import { useAllArticles } from '../hooks/useAllArticles';
import { LocalSearchSection } from '../components/search/LocalSearchSection';
import { SearchResultGrid } from '../components/search/SearchResultGrid';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { InfiniteScroll } from '../components/common/InfiniteScroll';
import { DownloadProgressProvider } from '../contexts/DownloadProgressContext';
import { useArticleTagSummary } from '../hooks/useArticleTagSummary';
import { useLocalArticleSearch } from '../hooks/useLocalArticleSearch';
import { useLocalSearchState } from '../hooks/useLocalSearchState';
import { useAppStore } from '../stores/app-store';
import { usePaginationKeyboard } from '../hooks/usePaginationKeyboard';
import { useResultGridKeyboard } from '../hooks/useResultGridKeyboard';
import { useToastStore } from '../stores/toast-store';
import styles from './DownloadsPage.module.css';
import { DateRangeFilter } from '../components/search/DateRangeFilter';
import { updateDateParams } from '../components/search/date-range-model';
import { buildLocalDateDistribution, filterItemsByDateRange } from '../components/search/local-date-range-model';

const PAGE_SIZE = 30;
const PROGRESS_RECORD_LIMIT = 50;

export function DownloadsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const { scrollMode } = useAppStore();

  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get('p') || '0');
  const from = searchParams.get('from') || undefined;
  const to = searchParams.get('to') || undefined;
  const hasActiveFilters = Boolean(searchParams.get('q')?.trim() || from || to);
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
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadAllArticles, setLoadAllArticles] = useState(false);

  // Fetch download IDs/dates first. This payload is much lighter than full
  // article metadata and lets the first visible page start immediately.
  const { data: downloadEntries, isLoading: idsLoading } = useQuery({
    queryKey: ['downloads', 'ids'],
    queryFn: getDownloadEntries,
  });
  const articleIds = useMemo(
    () => downloadEntries?.map((entry) => entry.articleId),
    [downloadEntries],
  );
  const initialArticleIds = useMemo(
    () => articleIds?.slice(0, PAGE_SIZE),
    [articleIds],
  );

  // Load only the first screen first so opening the tab does not wait for the
  // entire download library.
  const { data: initialArticles, isLoading: initialArticlesLoading } = useAllArticles(
    'downloads-initial',
    initialArticleIds,
  );

  // After the first page is available, fetch the remaining article metadata in
  // the background. Deep-linked pages and active filters need the full set for
  // correct results, so they skip the deferred phase.
  useEffect(() => {
    if (!articleIds || articleIds.length <= PAGE_SIZE) return;
    if (hasActiveFilters || page > 0) {
      setLoadAllArticles(true);
      return;
    }
    if (initialArticlesLoading || !initialArticles) return;

    const timer = window.setTimeout(() => setLoadAllArticles(true), 100);
    return () => window.clearTimeout(timer);
  }, [articleIds, hasActiveFilters, page, initialArticles, initialArticlesLoading]);

  const backgroundArticleIds = loadAllArticles ? articleIds : undefined;
  const { data: allArticles, isLoading: allArticlesLoading } = useAllArticles(
    'downloads',
    backgroundArticleIds,
  );

  // Progress only needs recent records. Avoid loading thousands of full rows
  // every time the downloads tab is opened.
  const { data: downloadData } = useQuery({
    queryKey: ['downloads', 'progress'],
    queryFn: () => getDownloads(0, PROGRESS_RECORD_LIMIT),
    refetchInterval: (query) => {
      const downloads = query.state.data?.downloads;
      if (downloads?.some((dl) => dl.Status === 'downloading')) {
        return 2000;
      }
      return false;
    },
  });

  const currentDownloads = downloadData?.downloads ?? [];

  // Build download progress map for context
  const downloadProgressMap = useMemo(() => {
    const map = new Map<string, DownloadRecord>();
    for (const dl of currentDownloads) {
      map.set(dl.Article, dl);
    }
    return map;
  }, [currentDownloads]);

  // Detect completion transitions and show toast
  const prevStatusRef = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    const prevMap = prevStatusRef.current;
    for (const dl of currentDownloads) {
      const prev = prevMap.get(dl.Id);
      if (prev === 'downloading' && dl.Status === 'completed') {
        addToast(t('downloads.completeToast'), 'success');
      }
      if (prev === 'downloading' && dl.Status === 'failed') {
        addToast(t('downloads.failedToast'), 'error');
      }
    }
    const newMap = new Map<number, string>();
    for (const dl of currentDownloads) {
      newMap.set(dl.Id, dl.Status);
    }
    prevStatusRef.current = newMap;
  }, [currentDownloads, addToast, t]);

  const initialLoading = idsLoading || initialArticlesLoading;
  const fullLoadPending = Boolean(
    articleIds && articleIds.length > PAGE_SIZE && !allArticles,
  );
  const requiresFullBeforeDisplay = hasActiveFilters || page > 0;
  const displayLoading = initialLoading || (requiresFullBeforeDisplay && fullLoadPending);
  const controlsLoading = initialLoading || fullLoadPending || allArticlesLoading;
  const effectiveArticles = allArticles ?? (
    requiresFullBeforeDisplay ? [] : initialArticles ?? []
  );

  // Tag summary uses the full set once background loading finishes. Until then
  // the grid can already show the first page while search controls stay loading.
  const tagSummary = useArticleTagSummary(effectiveArticles);

  // Filter articles based on search query
  const searchFilteredArticles = useLocalArticleSearch(effectiveArticles);
  const downloadDateByArticle = useMemo(
    () => new Map(downloadEntries?.map((entry) => [entry.articleId, entry.date])),
    [downloadEntries],
  );
  const dateDistribution = useMemo(
    () => buildLocalDateDistribution(
      searchFilteredArticles.map((article) => downloadDateByArticle.get(String(article.Id)) ?? ''),
    ),
    [searchFilteredArticles, downloadDateByArticle],
  );
  const filteredArticles = useMemo(
    () => filterItemsByDateRange(
      searchFilteredArticles,
      (article) => downloadDateByArticle.get(String(article.Id)) ?? '',
      from,
      to,
    ),
    [searchFilteredArticles, downloadDateByArticle, from, to],
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
    ['downloads', page, scrollMode, searchParams.toString()].join('|'),
  );

  usePaginationKeyboard(page, totalPages, setPage, scrollMode === 'pagination');

  const handleReset = useCallback(() => {
    navigate('/downloads', { replace: true });
  }, [navigate]);

  const { selectedTags, searchBarRef, getSuggestions, handleTagToggle } =
    useLocalSearchState({
      basePath: '/downloads',
      tagSummary,
      onReset: handleReset,
    });

  const handleLoadMore = useCallback(() => {
    setVisibleCount((prev) => prev + PAGE_SIZE);
  }, []);

  const hasMore = scrollMode === 'infinite' && visibleCount < filteredArticles.length;

  return (
    <div className={styles.page}>
      <p style={{ color: 'var(--color-text-secondary)' }}>{t('activity.recordOnly')}</p>
      <LocalSearchSection
        basePath="/downloads"
        searchBarRef={searchBarRef}
        getSuggestions={getSuggestions}
        tagSummary={tagSummary}
        selectedTags={selectedTags}
        onTagToggle={handleTagToggle}
        resultCount={filteredArticles.length}
        isLoading={controlsLoading}
        sticky
        extraControls={<ScopedMessageSearchButton articleIds={filteredArticles.map((article) => article.Id)}
          label={t('nav.downloads')} disabled={controlsLoading} completedOnly />}
        dateRangeContent={
          <DateRangeFilter
            compact
            query=""
            from={from}
            to={to}
            distributionData={dateDistribution}
            distributionLoading={controlsLoading}
            onCommit={(nextFrom, nextTo) =>
              setSearchParams(updateDateParams(searchParams, nextFrom, nextTo))
            }
          />
        }
      />

      <DownloadProgressProvider value={downloadProgressMap}>
        {scrollMode === 'infinite' ? (
          <>
            {displayLoading && <LoadingSpinner />}
            {!displayLoading && (
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
            {displayLoading && <LoadingSpinner />}
            {!displayLoading && (
              <SearchResultGrid
                articles={displayArticles}
                keyboardSelectedId={keyboardSelectedId}
                keyboardNavigation
              />
            )}

            {!displayLoading && totalPages > 1 && (
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
      </DownloadProgressProvider>
    </div>
  );
}
