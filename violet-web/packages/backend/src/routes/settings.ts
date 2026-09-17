import { Router } from 'express';
import {
  clearStoredEhCookie,
  getEhCookieStatus,
  saveEhCookie,
} from '../services/eh-cookie-store.js';
import {
  getEhCookieRefreshStatus,
  refreshStoredEhCookie,
} from '../services/eh-cookie-refresh.js';

export const settingsRouter = Router();

settingsRouter.get('/exhentai-cookie', (_req, res) => {
  try {
    res.json({
      ...getEhCookieStatus(),
      autoRefresh: getEhCookieRefreshStatus(),
    });
  } catch {
    res.status(500).json({ error: 'Failed to read cookie settings' });
  }
});

settingsRouter.put('/exhentai-cookie', (req, res) => {
  try {
    if (typeof req.body?.cookie !== 'string') {
      res.status(400).json({ error: 'Cookie must be a string' });
      return;
    }
    res.json({
      ...saveEhCookie(req.body.cookie),
      autoRefresh: getEhCookieRefreshStatus(),
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid cookie',
    });
  }
});

settingsRouter.post('/exhentai-cookie/refresh', async (_req, res) => {
  try {
    const status = getEhCookieStatus();
    if (status.source !== 'stored') {
      res.status(400).json({ error: 'A stored ExHentai cookie is required for refresh' });
      return;
    }
    res.json({
      ...status,
      autoRefresh: await refreshStoredEhCookie(true),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to refresh ExHentai cookie',
    });
  }
});

settingsRouter.delete('/exhentai-cookie', (_req, res) => {
  try {
    res.json({
      ...clearStoredEhCookie(),
      autoRefresh: getEhCookieRefreshStatus(),
    });
  } catch {
    res.status(500).json({ error: 'Failed to remove stored cookie' });
  }
});
