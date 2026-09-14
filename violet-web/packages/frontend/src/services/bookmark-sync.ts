import { syncActivity } from './activity-sync';
import { getGroups, getBookmarkArticles, addBookmarkArticle, deleteBookmarkArticle } from '../api/bookmarks';
import { transactBookmarkSync } from './user-database';

const CONFIG_KEY = 'violet-bookmark-sync-config';
const ENDPOINT = `${window.location.protocol}//${window.location.hostname}:3002/api/bookmark-sync`;
type Config = { token: string; days: number };
type Payload = { requestId: string; baseRevision: number; add: string[]; remove: string[] };
type Response = { revision: number; articles: string[] };
type State = { Id: 'state'; source: 'backend-v1'; revision: number; shadow: string[]; lastSuccess: number;
  leaseUntil: number; leaseOwner?: string; pending?: { payload: Payload; captured: string[];
    applying?: { response: Response; add: string[]; remove: number[] } } };
let inFlight: Promise<number | null> | null = null;
export function getBookmarkSyncConfig(): Config {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? '{}');
    return { token: typeof value.token === 'string' ? value.token : '', days: value.days === 7 ? 7 : 1 };
  } catch { return { token: '', days: 1 }; }
}
export function saveBookmarkSyncConfig(config: Config) { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); }
function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function ids(articles: Array<{ Article: string }>) {
  return [...new Set(articles.map(a => String(a.Article)).filter(x => /^\d{1,20}$/.test(x)))];
}
export function syncBookmarks(force = false): Promise<number | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const count = await syncArticleBookmarks(force);
    await syncActivity(force);
    return count;
  })().finally(() => { inFlight = null; });
  return inFlight;
}
async function syncArticleBookmarks(force: boolean): Promise<number | null> {
  const config = getBookmarkSyncConfig();
  if (!config.token) return null;
  const backendRows = await getBookmarkArticles();
  const state = await transactBookmarkSync<State | null>((_rows, saved, _store, meta) => {
    // The previous installer used browser bookmark storage. Start the backend
    // adapter with an empty shadow so existing server bookmarks are retained.
    const s: State = saved?.source === 'backend-v1' ? saved : {
      Id: 'state', source: 'backend-v1', revision: 0, shadow: [], lastSuccess: 0, leaseUntil: 0 };
    const now = Date.now();
    if (s.leaseUntil > now || (!force && !s.pending && now - s.lastSuccess < config.days * 86400000)) return null;
    if (!s.pending) {
      const captured = ids(backendRows), current = new Set(captured), shadow = new Set(s.shadow);
      s.pending = { captured, payload: { requestId: requestId(), baseRevision: s.revision,
        add: captured.filter(id => !shadow.has(id)), remove: s.shadow.filter(id => !current.has(id)) } };
    }
    s.leaseUntil = now + 600000;
    s.leaseOwner = requestId();
    meta.put(s); return s;
  });
  if (!state?.pending) return null;
  try {
    if (!state.pending.applying) {
      const response = await fetch(ENDPOINT, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Violet-Sync-Token': config.token },
        body: JSON.stringify(state.pending.payload), signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Sync HTTP ${response.status}`);
      const data: Response = await response.json();
      if (!Number.isSafeInteger(data.revision) || data.revision < state.revision ||
          !Array.isArray(data.articles) || data.articles.length > 100000 ||
          data.articles.some((x: unknown) => typeof x !== 'string' || !/^\d{1,20}$/.test(x))) throw new Error('Invalid sync response');
      const rows = await getBookmarkArticles();
      const captured = new Set(state.pending.captured), current = new Set(ids(rows)), wanted = new Set(data.articles);
      for (const id of current) if (!captured.has(id)) wanted.add(id);
      for (const id of captured) if (!current.has(id)) wanted.delete(id);
      state.pending.applying = { response: data,
        add: [...wanted].filter(id => !current.has(id)),
        remove: rows.filter(r => /^\d{1,20}$/.test(String(r.Article)) && !wanted.has(String(r.Article))).map(r => r.Id) };
      // Persist the exact backend operations before applying them. A partial
      // HTTP failure can then resume without interpreting imported rows as edits.
      await transactBookmarkSync((_rows, saved: State, _store, meta) => {
        if (saved?.pending?.payload.requestId !== state.pending!.payload.requestId || saved.leaseOwner !== state.leaseOwner) throw new Error('Sync state changed');
        meta.put(state);
      });
    }
    const plan = state.pending.applying;
    const groups = await getGroups();
    const group = groups.find(g => g.Name === 'violet_default') ?? groups[0];
    const present = await getBookmarkArticles();
    const presentRows = new Set(present.map(r => r.Id));
    const presentArticles = new Set(ids(present));
    let renewed = 0;
    const renewLease = async () => {
      if (Date.now() - renewed < 30000) return;
      await transactBookmarkSync((_rows, saved: State, _store, meta) => {
        if (saved?.pending?.payload.requestId !== state.pending!.payload.requestId || saved.leaseOwner !== state.leaseOwner) throw new Error('Sync state changed');
        meta.put({ ...saved, leaseUntil: Date.now() + 600000 });
      });
      renewed = Date.now();
    };
    for (const rowId of plan.remove) {
      await renewLease();
      if (presentRows.has(rowId)) await deleteBookmarkArticle(rowId);
    }
    for (const article of plan.add) {
      await renewLease();
      if (!presentArticles.has(article)) {
        await addBookmarkArticle({ Article: article, ...(group ? { GroupId: group.Id } : {}) });
        presentArticles.add(article);
      }
    }
    await transactBookmarkSync((_rows, saved: State, _store, meta) => {
      if (saved?.pending?.payload.requestId !== state.pending!.payload.requestId || saved.leaseOwner !== state.leaseOwner) throw new Error('Sync state changed');
      meta.put({ Id: 'state', source: 'backend-v1', revision: plan.response.revision,
        shadow: plan.response.articles, lastSuccess: Date.now(), leaseUntil: 0 });
    });
    window.dispatchEvent(new Event('violet-bookmarks-synced'));
    return plan.response.articles.length;
  } catch (error) {
    await transactBookmarkSync((_rows, saved: State, _store, meta) => {
      if (saved?.pending?.payload.requestId === state.pending!.payload.requestId && saved.leaseOwner === state.leaseOwner) meta.put({ ...saved, leaseUntil: 0 });
    });
    throw error;
  }
}
