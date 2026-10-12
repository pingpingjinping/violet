import { useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { LoadingSpinner } from './LoadingSpinner';

interface InfiniteScrollProps {
  onLoadMore: () => void;
  hasMore: boolean;
  loading: boolean;
  onLoadPrevious?: () => void;
  hasPrevious?: boolean;
  loadingPrevious?: boolean;
  firstPage?: number;
  children: React.ReactNode;
}

/**
 * Loads both sides of an infinite list without moving the current card when
 * earlier pages are inserted above it.
 */
export function InfiniteScroll({
  onLoadMore,
  hasMore,
  loading,
  onLoadPrevious,
  hasPrevious = false,
  loadingPrevious = false,
  firstPage,
  children,
}: InfiniteScrollProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const previousSentinelRef = useRef<HTMLDivElement>(null);
  const previousFirstPageRef = useRef(firstPage);
  const scrollAnchorRef = useRef<{ scrollHost: HTMLElement; anchor: HTMLElement; top: number } | null>(null);

  useLayoutEffect(() => {
    if (firstPage === previousFirstPageRef.current) return;
    if (
      firstPage !== undefined
      && previousFirstPageRef.current !== undefined
      && firstPage < previousFirstPageRef.current
      && scrollAnchorRef.current
    ) {
      const { scrollHost, anchor, top } = scrollAnchorRef.current;
      if (anchor.isConnected) {
        // Compare actual positions to avoid fighting native scroll anchoring.
        scrollHost.scrollTop += anchor.getBoundingClientRect().top - top;
      }
    }
    previousFirstPageRef.current = firstPage;
    scrollAnchorRef.current = null;
  }, [firstPage]);

  const handlePrevious = useCallback(() => {
    if (!hasPrevious || loadingPrevious || !onLoadPrevious) return;
    const marker = previousSentinelRef.current;
    const scrollHost = marker?.closest('main');
    const anchor = marker?.parentElement?.querySelector<HTMLElement>('[data-keyboard-result-grid="true"] > *');
    if (scrollHost && anchor) {
      scrollAnchorRef.current = {
        scrollHost,
        anchor,
        top: anchor.getBoundingClientRect().top,
      };
    }
    onLoadPrevious();
  }, [hasPrevious, loadingPrevious, onLoadPrevious]);

  useEffect(() => {
    const el = previousSentinelRef.current;
    if (!el || !hasPrevious || loadingPrevious || !onLoadPrevious) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) handlePrevious();
      },
      {
        root: el.closest('main'),
        rootMargin: '200px 0px 0px 0px',
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [handlePrevious, hasPrevious, loadingPrevious, onLoadPrevious]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          onLoadMore();
        }
      },
      { rootMargin: '300px' },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, loading]);

  return (
    <>
      {hasPrevious && <div ref={previousSentinelRef} />}
      {loadingPrevious && <LoadingSpinner />}
      {children}
      <div ref={sentinelRef} />
      {loading && <LoadingSpinner />}
    </>
  );
}
