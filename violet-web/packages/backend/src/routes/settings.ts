import { Router } from 'express';
import {
  clearStoredEhCookie,
  getEhCookieStatus,
  saveEhCookie,
} from '../services/eh-cookie-store.js';
import {
  clearEhCredentials,
  configureEhAutoLogin,
  getEhAutoLoginStatus,
  refreshEhCookieNow,
  startEhAutoLoginScheduler,
} from '../services/eh-auto-login.js';

export const settingsRouter = Router();

startEhAutoLoginScheduler();

settingsRouter.get('/exhentai-cookie', (_req, res) => {
  try {
    res.json(getEhCookieStatus());
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
    res.json(saveEhCookie(req.body.cookie));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid cookie',
    });
  }
});

settingsRouter.delete('/exhentai-cookie', (_req, res) => {
  try {
    res.json(clearStoredEhCookie());
  } catch {
    res.status(500).json({ error: 'Failed to remove stored cookie' });
  }
});

settingsRouter.get('/exhentai-account', (_req, res) => {
  try {
    res.json(getEhAutoLoginStatus());
  } catch {
    res.status(500).json({ error: 'Failed to read ExHentai account settings' });
  }
});

settingsRouter.put('/exhentai-account', async (req, res) => {
  try {
    if (typeof req.body?.username !== 'string' || typeof req.body?.password !== 'string') {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }
    res.json(await configureEhAutoLogin(req.body.username, req.body.password));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'ExHentai login failed',
    });
  }
});

settingsRouter.post('/exhentai-account/refresh', async (_req, res) => {
  try {
    res.json(await refreshEhCookieNow());
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'ExHentai cookie refresh failed',
    });
  }
});

settingsRouter.delete('/exhentai-account', (_req, res) => {
  try {
    res.json(clearEhCredentials());
  } catch {
    res.status(500).json({ error: 'Failed to remove ExHentai account settings' });
  }
});
