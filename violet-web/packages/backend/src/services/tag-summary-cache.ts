import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';
import type { TagEntry } from '@violet-web/shared';

const CACHE_VERSION = 1;
const PERSIST_DELAY_MS = 1_000;

export type TagSummaryCacheEntry = {
  tags: TagEntry[];
  ts: number;
};

type FileFingerprint = {
  mtimeMs: number;
  size: number;
} | null;

type PersistedTagSummaryCache = {
  version: number;
  fingerprint: string;
  entries: [string, TagSummaryCacheEntry][];
};

function fileFingerprint(path: string): FileFingerprint {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

export function contentDbFingerprint(dbPath: string): string {
  return JSON.stringify({
    db: fileFingerprint(dbPath),
    wal: fileFingerprint(`${dbPath}-wal`),
  });
}

export class PersistentTagSummaryCache {
  private readonly entries = new Map<string, TagSummaryCacheEntry>();
  private fingerprint = '';
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly cachePath: string,
    private readonly dbPath: string,
    private readonly maxEntries = 500,
  ) {}

  load(): void {
    this.fingerprint = contentDbFingerprint(this.dbPath);
    if (!existsSync(this.cachePath)) return;

    try {
      const parsed = JSON.parse(
        readFileSync(this.cachePath, 'utf-8'),
      ) as PersistedTagSummaryCache;

      if (
        parsed.version !== CACHE_VERSION ||
        parsed.fingerprint !== this.fingerprint ||
        !Array.isArray(parsed.entries)
      ) {
        return;
      }

      for (const [key, value] of parsed.entries.slice(-this.maxEntries)) {
        if (typeof key === 'string' && value && Array.isArray(value.tags)) {
          this.entries.set(key, value);
        }
      }

      console.log(`Tag summary cache loaded: ${this.entries.size} entries`);
    } catch (error) {
      console.warn('Failed to load tag summary cache:', error);
    }
  }

  refreshIfChanged(): boolean {
    const nextFingerprint = contentDbFingerprint(this.dbPath);
    if (nextFingerprint === this.fingerprint) return false;

    this.entries.clear();
    this.fingerprint = nextFingerprint;
    this.schedulePersist();
    console.log('Tag summary cache invalidated: content DB changed');
    return true;
  }

  get(key: string): TagSummaryCacheEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: TagSummaryCacheEntry): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }

    this.schedulePersist();
  }

  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistNow();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_DELAY_MS);
  }

  private persistNow(): void {
    const tempPath = `${this.cachePath}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const data: PersistedTagSummaryCache = {
        version: CACHE_VERSION,
        fingerprint: this.fingerprint,
        entries: Array.from(this.entries.entries()),
      };
      writeFileSync(tempPath, JSON.stringify(data));
      renameSync(tempPath, this.cachePath);
    } catch (error) {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only.
      }
      console.warn('Failed to persist tag summary cache:', error);
    }
  }
}
