import fs from 'fs';
import { dirname, join } from 'path';
import type Database from 'better-sqlite3';
import type { DateDistributionResponse } from '@violet-web/shared';
import { getDbPath } from './content-db.js';

export const DEFAULT_PERSISTENT_SEARCH_QUERY =
  'lang:korean -female:snuff -female:gore';

const CACHE_VERSION = 1;
const REVISION_KEY = 'web_search_stats_revision';

export type PersistentSearchStats = {
  version: number;
  query: string;
  revision: string;
  generatedAt: string;
  totalCount: number;
  dateDistribution: DateDistributionResponse;
};

let fileCache:
  | {
      path: string;
      mtimeMs: number;
      size: number;
      value: PersistentSearchStats | null;
    }
  | undefined;

function getCachePath(): string {
  return process.env.WEB_SEARCH_STATS_PATH ||
    join(dirname(getDbPath()), 'web-search-stats.json');
}

function readPersistentStatsFile(): PersistentSearchStats | null {
  const path = getCachePath();
  try {
    const stat = fs.statSync(path);
    if (
      fileCache &&
      fileCache.path === path &&
      fileCache.mtimeMs === stat.mtimeMs &&
      fileCache.size === stat.size
    ) {
      return fileCache.value;
    }

    const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as PersistentSearchStats;
    const valid =
      parsed.version === CACHE_VERSION &&
      parsed.query === DEFAULT_PERSISTENT_SEARCH_QUERY &&
      typeof parsed.revision === 'string' &&
      parsed.revision.length > 0 &&
      typeof parsed.totalCount === 'number' &&
      parsed.dateDistribution != null &&
      Array.isArray(parsed.dateDistribution.buckets);

    const value = valid ? parsed : null;
    fileCache = {
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      value,
    };
    return value;
  } catch {
    fileCache = undefined;
    return null;
  }
}

function getPublishedRevision(db: Database.Database): string | null {
  try {
    const row = db
      .prepare('SELECT Value FROM SyncState WHERE Key = ?')
      .get(REVISION_KEY) as { Value?: string } | undefined;
    return typeof row?.Value === 'string' ? row.Value : null;
  } catch {
    return null;
  }
}

export function getPersistentDefaultSearchStats(
  db: Database.Database,
  query: string,
  useFts: boolean,
): PersistentSearchStats | null {
  if (!useFts || query.trim() !== DEFAULT_PERSISTENT_SEARCH_QUERY) {
    return null;
  }

  const value = readPersistentStatsFile();
  if (!value) return null;

  const revision = getPublishedRevision(db);
  if (!revision || revision !== value.revision) return null;

  return value;
}
