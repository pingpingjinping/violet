import fs from 'node:fs';
import path from 'node:path';

export type ExHentaiAuthState = 'valid' | 'invalid' | 'unknown';

export interface ExHentaiAuthStatus {
  available: boolean;
  status: ExHentaiAuthState;
  reason: string | null;
  checkedAt: string | null;
}

function getStatusPath(): string {
  const root = process.env.HOST_SYNC_DIR?.trim() || '/content-data';
  return path.join(root, '.violet-exhentai-auth-status.json');
}

export function getExHentaiAuthStatus(): ExHentaiAuthStatus {
  const statusPath = getStatusPath();

  try {
    const raw = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as {
      status?: unknown;
      reason?: unknown;
      checkedAt?: unknown;
    };

    const status: ExHentaiAuthState =
      raw.status === 'valid' || raw.status === 'invalid' || raw.status === 'unknown'
        ? raw.status
        : 'unknown';

    return {
      available: true,
      status,
      reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason : null,
      checkedAt:
        typeof raw.checkedAt === 'string' && raw.checkedAt.trim()
          ? raw.checkedAt
          : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        available: false,
        status: 'unknown',
        reason: 'no_record',
        checkedAt: null,
      };
    }

    return {
      available: false,
      status: 'unknown',
      reason: 'read_error',
      checkedAt: null,
    };
  }
}
