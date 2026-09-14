import { getBookmarkSyncConfig } from './bookmark-sync';
import { getAllUserItems, replaceUserItems, USER_STORES } from './user-database';
import { api } from '../api/client';

export type SharedActivity = { Id: string; kind: 'read' | 'download'; device: string;
  article: string; origin: 'app' | 'web'; timestamp: number; page: number; type: 0 | 1 };
const ENDPOINT = `${window.location.protocol}//${window.location.hostname}:3002/api/activity-sync`;
let inFlight: Promise<void> | null = null;
const numeric = /^\d{1,20}$/;

export async function getSharedActivity(): Promise<SharedActivity[]> {
  return (await getAllUserItems<SharedActivity>(USER_STORES.sharedActivity)).sort((a, b) => b.timestamp - a.timestamp);
}
function deviceId() {
  const key = 'violet-activity-device';
  let value = localStorage.getItem(key);
  if (!value) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    value = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    localStorage.setItem(key, value);
  }
  return value;
}
export function validateActivity(records: unknown): asserts records is SharedActivity[] {
  if (!Array.isArray(records) || records.length > 100000 || records.some(r =>
    !r || !['read', 'download'].includes(r.kind) || !['app', 'web'].includes(r.origin) ||
    typeof r.device !== 'string' || !/^[0-9a-f-]{36}$/.test(r.device) ||
    typeof r.article !== 'string' || !numeric.test(r.article) ||
    !Number.isSafeInteger(r.timestamp) || r.timestamp <= 0 || r.timestamp > 8640000000000000 ||
    !Number.isSafeInteger(r.page) || r.page < 0 || r.page > 1000000 || ![0, 1].includes(r.type))) {
    throw new Error('Invalid activity response');
  }
}
export function syncActivity(force = false): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = exchange(force).finally(() => { inFlight = null; });
  return inFlight;
}
async function exchange(force: boolean) {
  const config = getBookmarkSyncConfig();
  if (!config.token) return;
  const last = Number(localStorage.getItem('violet-activity-last-success') ?? '0');
  if (!force && Date.now() - last < config.days * 86400000) return;
  const { getLocalHistory } = await import('../api/history');
  const latest = new Map<string, { article: string; timestamp: number; page: number; type: number }>();
  for (const row of await getLocalHistory()) {
    const timestamp = Date.parse(row.DateTimeEnd ?? row.DateTimeStart);
    if (!numeric.test(row.Article) || !Number.isSafeInteger(timestamp) || timestamp <= 0) continue;
    if (!latest.has(row.Article) || latest.get(row.Article)!.timestamp < timestamp) {
      latest.set(row.Article, { article: row.Article, timestamp, page: Math.max(0, row.LastPage ?? 0), type: row.Type === 1 ? 1 : 0 });
    }
  }
  const downloads = new Map<string, { article: string; timestamp: number }>();
  for (let page = 0; page < 1000; page++) {
    const { data } = await api.get('/downloads', { params: { page, pageSize: 100 } });
    for (const row of data.downloads) {
      const timestamp = Date.parse(row.DateTime);
      if (row.Status !== 'completed' || !numeric.test(String(row.Article)) || !Number.isSafeInteger(timestamp) || timestamp <= 0) continue;
      const article = String(row.Article);
      if (!downloads.has(article) || downloads.get(article)!.timestamp < timestamp) downloads.set(article, { article, timestamp });
    }
    if (!data.downloads.length || (page + 1) * data.pageSize >= data.totalCount) break;
    if (page === 999) throw new Error('Downloads exceed sync limit');
  }
  const response = await fetch(ENDPOINT, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Violet-Sync-Token': config.token },
    body: JSON.stringify({ device: deviceId(), origin: 'web', read: [...latest.values()], download: [...downloads.values()] }),
    signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Activity sync HTTP ${response.status}`);
  const data = await response.json();
  if (data.version !== 1) throw new Error('Unsupported activity version');
  validateActivity(data.records);
  await replaceUserItems(USER_STORES.sharedActivity, data.records.map((r: SharedActivity) => ({ ...r, Id: `${r.kind}:${r.device}:${r.article}` })));
  localStorage.setItem('violet-activity-last-success', String(Date.now()));
  window.dispatchEvent(new Event('violet-activity-synced'));
}
