import type { ArticleReadLog, InsertReadLogRequest, UpdateReadLogRequest } from '@violet-web/shared';
import { api } from './client';
import { getSharedActivity } from '../services/activity-sync';

export interface HistoryResponse {
  logs: ArticleReadLog[];
  totalCount: number;
  page: number;
  pageSize: number;
}
export async function getHistory(page = 0, pageSize = 30): Promise<HistoryResponse> {
  const { data } = await api.get<HistoryResponse>('/history', { params: { page, pageSize } });
  return data;
}
// Only backend rows are uploaded. Received app records remain a separate cache.
export async function getLocalHistory(): Promise<ArticleReadLog[]> {
  const rows: ArticleReadLog[] = [];
  for (let page = 0; page < 1000; page++) {
    const data = await getHistory(page, 100);
    rows.push(...data.logs);
    if (!data.logs.length || rows.length >= data.totalCount) return rows;
  }
  throw new Error('History exceeds sync limit');
}
export interface HistoryDateEntry { articleId: string; date: string }
export async function getHistoryEntries(): Promise<HistoryDateEntry[]> {
  const { data } = await api.get<{ entries: HistoryDateEntry[] }>('/history/ids');
  const latest = new Map(data.entries.map(e => [e.articleId, e.date]));
  for (const row of await getSharedActivity()) {
    if (row.kind !== 'read') continue;
    const date = new Date(row.timestamp).toISOString();
    if (!latest.has(row.article) || Date.parse(latest.get(row.article)!) < row.timestamp) latest.set(row.article, date);
  }
  return [...latest].map(([articleId, date]) => ({ articleId, date })).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}
export async function getLastPage(article: string): Promise<number | null> {
  const { data } = await api.get<{ lastPage: number | null }>(`/history/last-page/${article}`);
  const remote = (await getSharedActivity()).find(r => r.kind === 'read' && r.article === article);
  if (!remote) return data.lastPage;
  if (data.lastPage === null) return remote.page;
  const local = (await getLocalHistory()).filter(r => r.Article === article && r.DateTimeEnd !== null);
  const latestTime = local.reduce((time, r) => Math.max(time, Date.parse(r.DateTimeEnd ?? r.DateTimeStart) || 0), 0);
  return remote.timestamp > latestTime ? remote.page : data.lastPage;
}
export async function insertReadLog(req: InsertReadLogRequest): Promise<{ Id: number }> {
  const { data } = await api.post<{ Id: number }>('/history', req);
  return data;
}
export async function updateReadLog(id: number, req: UpdateReadLogRequest): Promise<void> {
  await api.patch(`/history/${id}`, req);
}
export async function deleteReadLog(id: number): Promise<void> {
  await api.delete(`/history/${id}`);
}
