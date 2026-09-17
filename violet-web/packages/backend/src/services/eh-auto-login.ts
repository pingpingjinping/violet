import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEhCookie, getEhCookieStatus, saveEhCookie } from './eh-cookie-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LOGIN_URL = 'https://forums.e-hentai.org/index.php?act=Login&CODE=01';
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;

interface EhCredentials {
  username: string;
  password: string;
}

export interface EhAutoLoginStatus {
  configured: boolean;
  cookieConfigured: boolean;
  refreshing: boolean;
  lastCheckAt: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
}

const runtimeState: Omit<EhAutoLoginStatus, 'configured' | 'cookieConfigured'> = {
  refreshing: false,
  lastCheckAt: null,
  lastRefreshAt: null,
  lastError: null,
};

let refreshPromise: Promise<EhAutoLoginStatus> | null = null;
let schedulerStarted = false;

function getCredentialsPath(): string {
  if (process.env.EXHENTAI_ACCOUNT_PATH) {
    return path.resolve(process.env.EXHENTAI_ACCOUNT_PATH);
  }
  if (process.env.USER_DB_PATH) {
    return path.join(path.dirname(path.resolve(process.env.USER_DB_PATH)), 'exhentai-account.json');
  }
  return path.resolve(__dirname, '../../data/exhentai-account.json');
}

function normalizeCredentials(username: string, password: string): EhCredentials {
  const normalizedUsername = username.trim();
  if (!normalizedUsername) throw new Error('Username is empty');
  if (!password) throw new Error('Password is empty');
  if (normalizedUsername.length > 256 || password.length > 1024) {
    throw new Error('Credentials are too long');
  }
  if (/[\r\n]/.test(normalizedUsername)) throw new Error('Username contains invalid characters');
  return { username: normalizedUsername, password };
}

function readCredentials(): EhCredentials | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getCredentialsPath(), 'utf8')) as Partial<EhCredentials>;
    if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') return null;
    return normalizeCredentials(parsed.username, parsed.password);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function writeCredentials(credentials: EhCredentials): void {
  const target = getCredentialsPath();
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.exhentai-account.${process.pid}.tmp`);
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(credentials)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function clearEhCredentials(): EhAutoLoginStatus {
  try {
    fs.unlinkSync(getCredentialsPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  runtimeState.lastError = null;
  return getEhAutoLoginStatus();
}

function getSetCookieHeaders(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof enhanced.getSetCookie === 'function') return enhanced.getSetCookie();
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}

function mergeResponseCookies(jar: Map<string, string>, headers: Headers): void {
  for (const setCookie of getSetCookieHeaders(headers)) {
    const pair = setCookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name) continue;
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}

function serializeJar(jar: Map<string, string>): string {
  const preferred = ['ipb_member_id', 'ipb_pass_hash', 'igneous', 'sk', 'nw', 'sl'];
  const ordered = new Set<string>(preferred.filter((name) => jar.has(name)));
  for (const name of jar.keys()) ordered.add(name);
  return [...ordered].map((name) => `${name}=${jar.get(name)}`).join('; ');
}

function loadJarFromCookie(cookie: string | null): Map<string, string> {
  const jar = new Map<string, string>();
  if (!cookie) return jar;
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    jar.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return jar;
}

function isCloudflareChallenge(status: number, body: string): boolean {
  const lower = body.toLowerCase();
  return status === 403 && (
    lower.includes('cloudflare')
    || lower.includes('cf-chl')
    || lower.includes('just a moment')
  );
}

async function fetchWithJar(
  url: string,
  jar: Map<string, string>,
  init: RequestInit = {},
): Promise<{ response: Response; body: string }> {
  const headers = new Headers(init.headers);
  headers.set('User-Agent', USER_AGENT);
  headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  const cookie = serializeJar(jar);
  if (cookie) headers.set('Cookie', cookie);

  const response = await fetch(url, {
    ...init,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  mergeResponseCookies(jar, response.headers);
  const body = await response.text();
  if (isCloudflareChallenge(response.status, body)) {
    throw new Error('Cloudflare challenge blocked automatic E-Hentai login');
  }
  return { response, body };
}

function validIgneous(value: string | undefined): boolean {
  return Boolean(value && value !== 'mystery' && value !== 'deleted' && value !== 'null');
}

async function loginForCookie(credentials: EhCredentials): Promise<string> {
  const jar = new Map<string, string>();
  const form = new URLSearchParams({
    CookieDate: '1',
    b: 'd',
    bt: '1-1',
    UserName: credentials.username,
    PassWord: credentials.password,
    ipb_login_submit: 'Login!',
  });

  const login = await fetchWithJar(LOGIN_URL, jar, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://e-hentai.org/bounce_login.php?b=d&bt=1-1',
    },
    body: form.toString(),
  });
  if (login.response.status >= 500) {
    throw new Error(`E-Hentai login returned HTTP ${login.response.status}`);
  }

  const propagationUrls = [
    'https://e-hentai.org/',
    'https://exhentai.org/',
    'https://exhentai.org/uconfig.php',
    'https://exhentai.org/',
  ];
  for (const url of propagationUrls) await fetchWithJar(url, jar);

  if (!validIgneous(jar.get('igneous'))) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await fetchWithJar('https://e-hentai.org/', jar);
    await fetchWithJar('https://exhentai.org/', jar);
  }

  const memberId = jar.get('ipb_member_id');
  const passHash = jar.get('ipb_pass_hash');
  const igneous = jar.get('igneous');
  if (!memberId || !passHash) {
    throw new Error('E-Hentai login did not return account cookies; check ID/password');
  }
  if (!validIgneous(igneous)) {
    throw new Error(`ExHentai did not issue a usable igneous cookie (${igneous ?? 'missing'})`);
  }

  return serializeJar(jar);
}

export async function isCurrentEhCookieValid(): Promise<boolean> {
  const cookie = getEhCookie();
  if (!cookie) return false;
  const jar = loadJarFromCookie(cookie);
  if (!validIgneous(jar.get('igneous'))) return false;

  const { response, body } = await fetchWithJar('https://exhentai.org/', jar);
  if (response.status !== 200) return false;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) return false;
  const lower = body.toLowerCase();
  return lower.includes('exhentai.org')
    && (lower.includes('class="itg') || lower.includes('id="searchbox') || lower.includes('favorites.php'));
}

async function doRefresh(credentials: EhCredentials, persistCredentials: boolean): Promise<EhAutoLoginStatus> {
  runtimeState.refreshing = true;
  runtimeState.lastCheckAt = new Date().toISOString();
  runtimeState.lastError = null;
  try {
    const cookie = await loginForCookie(credentials);
    saveEhCookie(cookie);
    if (persistCredentials) writeCredentials(credentials);
    runtimeState.lastRefreshAt = new Date().toISOString();
    runtimeState.refreshing = false;
    return getEhAutoLoginStatus();
  } catch (error) {
    runtimeState.lastError = error instanceof Error ? error.message : 'Unknown login error';
    throw error;
  } finally {
    runtimeState.refreshing = false;
  }
}

export async function configureEhAutoLogin(username: string, password: string): Promise<EhAutoLoginStatus> {
  const credentials = normalizeCredentials(username, password);
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefresh(credentials, true).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function refreshEhCookieNow(): Promise<EhAutoLoginStatus> {
  const credentials = readCredentials();
  if (!credentials) throw new Error('ExHentai account credentials are not configured');
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefresh(credentials, false).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export function getEhAutoLoginStatus(): EhAutoLoginStatus {
  return {
    configured: readCredentials() !== null,
    cookieConfigured: getEhCookieStatus().configured,
    ...runtimeState,
  };
}

async function scheduledCheck(): Promise<void> {
  const credentials = readCredentials();
  if (!credentials || runtimeState.refreshing) return;
  runtimeState.lastCheckAt = new Date().toISOString();
  try {
    if (await isCurrentEhCookieValid()) {
      runtimeState.lastError = null;
      return;
    }
    await refreshEhCookieNow();
  } catch (error) {
    runtimeState.lastError = error instanceof Error ? error.message : 'Automatic cookie check failed';
    console.warn(`[exhentai-auto-login] ${runtimeState.lastError}`);
  }
}

export function startEhAutoLoginScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const startup = setTimeout(() => void scheduledCheck(), STARTUP_CHECK_DELAY_MS);
  startup.unref?.();
  const interval = setInterval(() => void scheduledCheck(), AUTO_CHECK_INTERVAL_MS);
  interval.unref?.();
}
