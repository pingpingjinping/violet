import axios from 'axios';

export const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

const BOOKMARK_SYNC_CONFIG_KEY = 'violet-bookmark-sync-config';

export function syncTokenHeaders(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(BOOKMARK_SYNC_CONFIG_KEY) ?? '{}');
    const token = typeof value.token === 'string' ? value.token.trim() : '';
    return token ? { 'X-Violet-Sync-Token': token } : {};
  } catch {
    return {};
  }
}
