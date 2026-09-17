import { api } from './client';

export interface ExhentaiAccountStatus {
  configured: boolean;
  cookieConfigured: boolean;
  refreshing: boolean;
  lastCheckAt: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
}

export async function getExhentaiAccountStatus(): Promise<ExhentaiAccountStatus> {
  const { data } = await api.get<ExhentaiAccountStatus>('/settings/exhentai-account');
  return data;
}

export async function saveExhentaiAccount(
  username: string,
  password: string,
): Promise<ExhentaiAccountStatus> {
  const { data } = await api.put<ExhentaiAccountStatus>('/settings/exhentai-account', {
    username,
    password,
  });
  return data;
}

export async function refreshExhentaiAccount(): Promise<ExhentaiAccountStatus> {
  const { data } = await api.post<ExhentaiAccountStatus>('/settings/exhentai-account/refresh');
  return data;
}

export async function removeExhentaiAccount(): Promise<ExhentaiAccountStatus> {
  const { data } = await api.delete<ExhentaiAccountStatus>('/settings/exhentai-account');
  return data;
}
