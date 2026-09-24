import { api, syncTokenHeaders } from './client';

export interface ExhentaiCookieStatus {
  configured: boolean;
  source: 'stored' | 'environment' | null;
}

export interface ExhentaiAuthStatus extends ExhentaiCookieStatus {
  available: boolean;
  status: 'valid' | 'invalid' | 'unknown';
  reason: string | null;
  checkedAt: string | null;
}

export async function getExhentaiAuthStatus(): Promise<ExhentaiAuthStatus> {
  const { data } = await api.get<ExhentaiAuthStatus>('/settings/exhentai-auth-status');
  return data;
}

export async function getExhentaiCookieStatus(): Promise<ExhentaiCookieStatus> {
  const { data } = await api.get<ExhentaiCookieStatus>('/settings/exhentai-cookie');
  return data;
}

export async function saveExhentaiCookie(cookie: string): Promise<ExhentaiCookieStatus> {
  const { data } = await api.put<ExhentaiCookieStatus>('/settings/exhentai-cookie', { cookie }, { headers: syncTokenHeaders() });
  return data;
}

export async function removeExhentaiCookie(): Promise<ExhentaiCookieStatus> {
  const { data } = await api.delete<ExhentaiCookieStatus>('/settings/exhentai-cookie', { headers: syncTokenHeaders() });
  return data;
}
