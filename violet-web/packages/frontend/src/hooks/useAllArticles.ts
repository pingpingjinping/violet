import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getArticlesBatch } from '../api/content';
import type { Article } from '@violet-web/shared';

const BATCH_SIZE = 1000;
const CONCURRENCY = 4;

function idsSignature(ids: string[] | undefined): string {
  if (!ids?.length) return '0:0';
  let hash = 2166136261;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 124;
    hash = Math.imul(hash, 16777619);
  }
  return `${ids.length}:${hash >>> 0}`;
}

/**
 * Fetch all articles for a list of IDs using the batch API.
 * Large lists are split into smaller batches and fetched with bounded
 * concurrency so bookmark/history/download tabs do not wait on each batch
 * serially. The query key stores a compact signature instead of thousands of
 * IDs, which also reduces React Query hashing work during tab switches.
 */
export function useAllArticles(
  queryKey: string,
  articleIds: string[] | undefined,
) {
  const signature = useMemo(() => idsSignature(articleIds), [articleIds]);

  return useQuery<Article[]>({
    queryKey: [queryKey, 'all-articles', signature],
    queryFn: async () => {
      if (!articleIds || articleIds.length === 0) return [];

      const seen = new Set<number>();
      const numericIds: number[] = [];
      for (const id of articleIds) {
        const value = Number.parseInt(id, 10);
        if (Number.isSafeInteger(value) && !seen.has(value)) {
          seen.add(value);
          numericIds.push(value);
        }
      }

      const chunks: number[][] = [];
      for (let i = 0; i < numericIds.length; i += BATCH_SIZE) {
        chunks.push(numericIds.slice(i, i + BATCH_SIZE));
      }

      const results: Article[] = [];
      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        const wave = await Promise.all(
          chunks.slice(i, i + CONCURRENCY).map((chunk) => getArticlesBatch(chunk)),
        );
        for (const articles of wave) results.push(...articles);
      }
      return results;
    },
    enabled: !!articleIds && articleIds.length > 0,
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });
}
