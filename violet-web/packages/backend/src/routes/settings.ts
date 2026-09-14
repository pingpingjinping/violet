import { Router } from 'express';
import {
  clearStoredEhCookie,
  getEhCookieStatus,
  saveEhCookie,
} from '../services/eh-cookie-store.js';

export const settingsRouter = Router();

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
