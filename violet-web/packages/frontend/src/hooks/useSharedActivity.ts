import { useQuery } from '@tanstack/react-query';
import { getSharedActivity } from '../services/activity-sync';

export function useSharedActivity() {
  return useQuery({ queryKey: ['sharedActivity'], queryFn: getSharedActivity });
}
export function useArticleActivity(article: string) {
  const { data } = useSharedActivity();
  const downloads = (data ?? []).filter(r => r.article === article && r.kind === 'download');
  const read = (data ?? []).find(r => r.article === article && r.kind === 'read');
  return { downloads, read };
}
