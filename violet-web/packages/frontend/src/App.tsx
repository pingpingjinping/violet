import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppRoutes } from './router';
import { ThemeProvider } from './components/ThemeProvider';
import { DbDownloadOverlay } from './components/common/DbDownloadOverlay';
import { useEffect } from 'react';
import { syncBookmarks } from './services/bookmark-sync';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  },
});

export function App() {
  useEffect(() => {
    const sync = () => { if (!document.hidden) void syncBookmarks().catch(() => {}); };
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['bookmarkArticles'] });
      void queryClient.invalidateQueries({ queryKey: ['isBookmarked'] });
      void queryClient.invalidateQueries({ queryKey: ['allArticles'] });
    };
    const refreshActivity = () => {
      for (const key of ['sharedActivity', 'readHistory', 'readHistory-infinite', 'downloads', 'downloads-infinite', 'downloaded', 'allArticles']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    };
    window.addEventListener('violet-activity-synced', refreshActivity);
    window.addEventListener('violet-bookmarks-synced', refresh);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    sync();
    return () => {
      window.removeEventListener('violet-activity-synced', refreshActivity);
      window.removeEventListener('violet-bookmarks-synced', refresh);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider />
        <DbDownloadOverlay />
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
