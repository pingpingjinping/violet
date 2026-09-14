import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_COOKIE_NAMES = [
  'ipb_member_id',
  'ipb_pass_hash',
  'igneous',
] as const;
const MAX_COOKIE_LENGTH = 8 * 1024;
let cachedCookiePath: string | null = null;
let cachedStoredCookie: string | null = null;

export type EhCookieSource = 'stored' | 'environment' | null;

export interface EhCookieStatus {
  configured: boolean;
  source: EhCookieSource;
}

function getCookiePath(): string {
  if (process.env.EXHENTAI_COOKIE_PATH) {
    return path.resolve(process.env.EXHENTAI_COOKIE_PATH);
  }
  if (process.env.USER_DB_PATH) {
    return path.join(path.dirname(path.resolve(process.env.USER_DB_PATH)), 'exhentai-cookie.txt');
  }
  return path.resolve(__dirname, '../../data/exhentai-cookie.txt');
}

function normalizeCookie(cookie: string): string {
  const normalized = cookie.trim();
  if (!normalized) throw new Error('Cookie is empty');
  if (normalized.length > MAX_COOKIE_LENGTH) throw new Error('Cookie is too long');
  if (/[\r\n]/.test(normalized)) throw new Error('Cookie contains invalid characters');
  return normalized;
}

function validateExhentaiCookie(cookie: string): string {
  const normalized = normalizeCookie(cookie);
  const names = new Set(
    normalized.split(';').flatMap((part) => {
      const separator = part.indexOf('=');
      return separator > 0 ? [part.slice(0, separator).trim()] : [];
    }),
  );
  const missing = REQUIRED_COOKIE_NAMES.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing required cookie values: ${missing.join(', ')}`);
  }
  return normalized;
}

function readStoredCookie(): string | null {
  const cookiePath = getCookiePath();
  if (cachedCookiePath === cookiePath) return cachedStoredCookie;

  try {
    const cookie = fs.readFileSync(cookiePath, 'utf8').trim();
    cachedCookiePath = cookiePath;
    cachedStoredCookie = cookie ? normalizeCookie(cookie) : null;
    return cachedStoredCookie;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cachedCookiePath = cookiePath;
      cachedStoredCookie = null;
      return null;
    }
    throw error;
  }
}

export function getEhCookie(): string | null {
  const stored = readStoredCookie();
  if (stored) return stored;
  const environment = process.env.EXHENTAI_COOKIE?.trim();
  return environment ? normalizeCookie(environment) : null;
}

export function getEhCookieStatus(): EhCookieStatus {
  if (readStoredCookie()) return { configured: true, source: 'stored' };
  if (process.env.EXHENTAI_COOKIE?.trim()) {
    return { configured: true, source: 'environment' };
  }
  return { configured: false, source: null };
}

export function saveEhCookie(cookie: string): EhCookieStatus {
  const normalized = validateExhentaiCookie(cookie);
  const cookiePath = getCookiePath();
  const directory = path.dirname(cookiePath);
  const temporary = path.join(directory, `.exhentai-cookie.${process.pid}.tmp`);

  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporary, `${normalized}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, cookiePath);
    fs.chmodSync(cookiePath, 0o600);
    cachedCookiePath = cookiePath;
    cachedStoredCookie = normalized;
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { configured: true, source: 'stored' };
}

export function clearStoredEhCookie(): EhCookieStatus {
  const cookiePath = getCookiePath();
  try {
    fs.unlinkSync(cookiePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  cachedCookiePath = cookiePath;
  cachedStoredCookie = null;
  return getEhCookieStatus();
}
