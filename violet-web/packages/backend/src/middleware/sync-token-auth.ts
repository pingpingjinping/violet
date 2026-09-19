import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';

const DEFAULT_SYNC_TOKEN_PATH = '/sync-state/sync-token.txt';

function configuredSyncToken(): string | null {
  const environmentToken = process.env.VIOLET_SYNC_TOKEN?.trim();
  if (environmentToken) return environmentToken;

  const path = process.env.VIOLET_SYNC_TOKEN_PATH?.trim() || DEFAULT_SYNC_TOKEN_PATH;
  try {
    const token = readFileSync(path, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

export function hasValidSyncToken(provided: string | undefined): boolean {
  const expected = configuredSyncToken();
  if (!expected || !provided) return false;

  const actualBuffer = Buffer.from(provided.trim());
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function requireSyncToken(req: Request, res: Response, next: NextFunction) {
  const expectedAvailable = configuredSyncToken();
  if (!expectedAvailable) {
    res.status(503).json({ error: 'Sync token is not configured on this server' });
    return;
  }

  if (!hasValidSyncToken(req.get('X-Violet-Sync-Token'))) {
    res.status(401).json({ error: 'Invalid sync token' });
    return;
  }

  next();
}
