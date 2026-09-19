import { api, syncTokenHeaders } from './client';

export interface ExhentaiCookieStatus {
  configured: boolean;
  source: 'stored' | 'environment' | null;
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
