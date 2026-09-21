import type Database from 'better-sqlite3';
import type {
  DateDistributionBucket,
  DateDistributionResponse,
} from '@violet-web/shared';

const DOTNET_UNIX_EPOCH_TICKS = 621355968000000000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 100;

const distributionCaches = new WeakMap<Database.Database, {
  revision: string;
  entries: Map<string, { value: DateDistributionResponse; expiresAt: number }>;
}>();

function getDistributionCache(db: Database.Database) {
  if (db.inTransaction) return new Map<string, { value: DateDistributionResponse; expiresAt: number }>();
  const revision = `${db.pragma('data_version', { simple: true })}:${db.pragma('schema_version', { simple: true })}:${db.prepare('SELECT total_changes()').pluck().get()}`;
  let cache = distributionCaches.get(db);
  if (!cache || cache.revision !== revision) {
    cache = { revision, entries: new Map() };
    distributionCaches.set(db, cache);
  }
  return cache.entries;
}

export function normalizedPublishedSql(column = 'Published'): string {
  return `CASE
    WHEN typeof(${column})='integer' AND ${column}>${DOTNET_UNIX_EPOCH_TICKS}
      THEN datetime((${column}-${DOTNET_UNIX_EPOCH_TICKS})/10000000.0, 'unixepoch')
    WHEN typeof(${column})='text' THEN datetime(${column})
    ELSE NULL END`;
}

export function parseDateBounds(from?: string, to?: string): {
  from?: string;
  toExclusive?: string;
} {
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !isoDay.test(from)) || (to && !isoDay.test(to))) {
    throw new Error('Date bounds must use YYYY-MM-DD');
  }
  for (const value of [from, to]) {
    if (!value) continue;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error('Date bounds must use valid calendar dates');
    }
  }
  if (from && to && from > to) {
    throw new Error('from must be before or equal to to');
  }

  let toExclusive: string | undefined;
  if (to) {
    const nextDay = new Date(`${to}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    toExclusive = `${nextDay.toISOString().slice(0, 10)} 00:00:00`;
  }

  return {
    from: from ? `${from} 00:00:00` : undefined,
    toExclusive,
  };
}

function daysBetween(from: string, to: string): number {
  return Math.ceil(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

function selectBucketUnit(
  minDate: string,
  maxDate: string,
): DateDistributionResponse['unit'] {
  const days = daysBetween(minDate, maxDate);
  if (days > 1_860) return 'year';
  if (days > 45) return 'month';
  return 'day';
}

function addBucket(date: Date, unit: DateDistributionResponse['unit']): void {
  if (unit === 'year') date.setUTCFullYear(date.getUTCFullYear() + 1);
  else if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
  else date.setUTCDate(date.getUTCDate() + 1);
}

function floorDate(value: string, unit: DateDistributionResponse['unit']): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (unit === 'year') {
    date.setUTCMonth(0, 1);
  } else if (unit === 'month') {
    date.setUTCDate(1);
  }
  return date;
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizedPublishedDay(value: number | string | null): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= DOTNET_UNIX_EPOCH_TICKS) return null;
    const date = new Date((value - DOTNET_UNIX_EPOCH_TICKS) / 10_000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(value.trim());
  if (!match) return null;

  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day
    ? day
    : null;
}

export function getDateDistributionFromSql(
  db: Database.Database,
  publishedSql: string,
  cacheKey: string,
  blockedPublishedSql?: string | null,
): DateDistributionResponse {
  const now = Date.now();
  const distributionCache = getDistributionCache(db);
  const cached = distributionCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) distributionCache.delete(cacheKey);

  // Pull raw publication values only. On low-power storage this is much faster
  // than materializing datetime() for every matching row and grouping in SQLite.
  const publishedRows = db.prepare(publishedSql).all() as Array<{
    Published: number | string | null;
  }>;

  const dayCounts = new Map<string, number>();
  let invalidCount = 0;

  const applyRows = (
    rows: Array<{ Published: number | string | null }>,
    delta: 1 | -1,
  ) => {
    for (const row of rows) {
      const start = normalizedPublishedDay(row.Published);
      if (!start) {
        invalidCount += delta;
        continue;
      }
      const next = (dayCounts.get(start) ?? 0) + delta;
      if (next <= 0) dayCounts.delete(start);
      else dayCounts.set(start, next);
    }
  };

  applyRows(publishedRows, 1);

  if (blockedPublishedSql) {
    const blockedRows = db.prepare(blockedPublishedSql).all() as Array<{
      Published: number | string | null;
    }>;
    applyRows(blockedRows, -1);
  }

  const validDays = [...dayCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([start, count]) => ({ start, count }));
  const minDate = validDays[0]?.start ?? null;
  const maxDate = validDays.at(-1)?.start ?? null;
  const unit = minDate && maxDate ? selectBucketUnit(minDate, maxDate) : 'year';
  const buckets: DateDistributionBucket[] = [];

  if (minDate && maxDate) {
    const counts = new Map<string, number>();
    for (const row of validDays) {
      const start = formatDay(floorDate(row.start, unit));
      counts.set(start, (counts.get(start) ?? 0) + row.count);
    }
    const cursor = floorDate(minDate, unit);
    const last = floorDate(maxDate, unit);
    while (cursor <= last) {
      const start = formatDay(cursor);
      const endCursor = new Date(cursor);
      addBucket(endCursor, unit);
      buckets.push({ start, end: formatDay(endCursor), count: counts.get(start) ?? 0 });
      addBucket(cursor, unit);
    }
  }

  const value: DateDistributionResponse = {
    minDate,
    maxDate,
    totalCount: validDays.reduce((sum, row) => sum + row.count, 0),
    invalidCount,
    unit,
    buckets,
  };

  if (distributionCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = distributionCache.keys().next().value as string | undefined;
    if (oldestKey) distributionCache.delete(oldestKey);
  }
  distributionCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}


export function getDateDistribution(
  db: Database.Database,
  condition: string,
  cacheKey: string,
): DateDistributionResponse {
  return getDateDistributionFromSql(
    db,
    `SELECT Published FROM HitomiColumnModel WHERE ${condition}`,
    cacheKey,
  );
}
