import https from 'node:https';
import { URL } from 'node:url';
import {
  getEhCookie,
  getEhCookieStatus,
  getStoredEhCookieUpdatedAt,
  saveEhCookie,
} from './eh-cookie-store.js';

const REFRESH_AFTER_MS = 21 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface EhCookieRefreshStatus {
  enabled: boolean;
  refreshAfterDays: number;
  storedUpdatedAt: string | null;
  nextRefreshAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

interface RefreshResponse {
  statusCode: number;
  headers: https.IncomingHttpHeaders;
}

let lastAttemptAt: Date | null = null;
let lastSuccessAt: Date | null = null;
let lastError: string | null = null;
let schedulerStarted = false;
let refreshInFlight: Promise<EhCookieRefreshStatus> | null = null;

function parseCookie(cookie: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) result.set(name, value);
  }
  return result;
}

function serializeCookie(cookie: Map<string, string>): string {
  return [...cookie.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function extractSetCookieValue(headers: https.IncomingHttpHeaders, name: string): string | null {
  const values = headers['set-cookie'] ?? [];
  for (const header of values) {
    const firstPart = header.split(';', 1)[0];
    const separator = firstPart.indexOf('=');
    if (separator <= 0) continue;
    if (firstPart.slice(0, separator).trim() !== name) continue;
    return firstPart.slice(separator + 1).trim();
  }
  return null;
}

function requestExhentai(cookieHeader: string, url = 'https://exhentai.org/', redirects = 0): Promise<RefreshResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          Cookie: cookieHeader,
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        const statusCode = response.statusCode ?? 0;
        const location = response.headers.location;

        if (location && statusCode >= 300 && statusCode < 400 && redirects < 3) {
          const next = new URL(location, target).toString();
          requestExhentai(cookieHeader, next, redirects + 1).then(resolve, reject);
          return;
        }

        resolve({ statusCode, headers: response.headers });
      },
    );

    request.once('timeout', () => request.destroy(new Error('ExHentai refresh request timed out')));
    request.once('error', reject);
    request.end();
  });
}

function getBaseStatus(): EhCookieRefreshStatus {
  const source = getEhCookieStatus().source;
  const updatedAt = source === 'stored' ? getStoredEhCookieUpdatedAt() : null;
  const nextRefresh = updatedAt ? new Date(updatedAt.getTime() + REFRESH_AFTER_MS) : null;
  return {
    enabled: source === 'stored',
    refreshAfterDays: Math.round(REFRESH_AFTER_MS / (24 * 60 * 60 * 1000)),
    storedUpdatedAt: updatedAt?.toISOString() ?? null,
    nextRefreshAt: nextRefresh?.toISOString() ?? null,
    lastAttemptAt: lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    lastError,
  };
}

export function getEhCookieRefreshStatus(): EhCookieRefreshStatus {
  return getBaseStatus();
}

export async function refreshStoredEhCookie(force = false): Promise<EhCookieRefreshStatus> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const status = getEhCookieStatus();
      if (status.source !== 'stored') {
        lastError = null;
        return getBaseStatus();
      }

      const updatedAt = getStoredEhCookieUpdatedAt();
      if (!force && updatedAt && Date.now() - updatedAt.getTime() < REFRESH_AFTER_MS) {
        return getBaseStatus();
      }

      const current = getEhCookie();
      if (!current) throw new Error('Stored ExHentai cookie is missing');

      const values = parseCookie(current);
      const memberId = values.get('ipb_member_id');
      const passHash = values.get('ipb_pass_hash');
      if (!memberId || !passHash) {
        throw new Error('Stored cookie is missing ipb_member_id or ipb_pass_hash');
      }

      lastAttemptAt = new Date();
      const authCookie = `ipb_member_id=${memberId}; ipb_pass_hash=${passHash}`;
      const response = await requestExhentai(authCookie);
      if (response.statusCode === 403) {
        throw new Error('ExHentai returned HTTP 403 while refreshing igneous');
      }
      if (response.statusCode < 200 || response.statusCode >= 400) {
        throw new Error(`ExHentai returned HTTP ${response.statusCode} while refreshing igneous`);
      }

      const igneous = extractSetCookieValue(response.headers, 'igneous');
      if (!igneous) {
        throw new Error('ExHentai did not issue a new igneous cookie');
      }
      if (igneous === 'mystery' || igneous === 'deleted') {
        throw new Error(`ExHentai returned igneous=${igneous}`);
      }

      values.set('igneous', igneous);
      saveEhCookie(serializeCookie(values));
      lastSuccessAt = new Date();
      lastError = null;
      console.log('[violet-web] ExHentai igneous cookie refreshed automatically');
      return getBaseStatus();
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown ExHentai refresh error';
      console.warn(`[violet-web] ExHentai cookie refresh failed: ${lastError}`);
      return getBaseStatus();
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export function startEhCookieRefreshScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const run = () => {
    void refreshStoredEhCookie(false);
  };

  const initial = setTimeout(run, 60_000);
  initial.unref();
  const interval = setInterval(run, CHECK_INTERVAL_MS);
  interval.unref();
}
