import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBookmarkSyncConfig, saveBookmarkSyncConfig, syncBookmarks } from '../../services/bookmark-sync';
import { ExhentaiAccountSettings } from './ExhentaiAccountSettings';

export function BookmarkSyncSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState(getBookmarkSyncConfig);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const save = () => {
    saveBookmarkSyncConfig({ ...config, token: config.token.trim() });
    setMessage(t('bookmarkSync.saved'));
  };
  const sync = async () => {
    saveBookmarkSyncConfig({ ...config, token: config.token.trim() });
    setBusy(true);
    try {
      const count = await syncBookmarks(true);
      setMessage(count === null ? t('bookmarkSync.notReady') : t('bookmarkSync.success', { count }));
    } catch { setMessage(t('bookmarkSync.error')); }
    finally { setBusy(false); }
  };
  return <>
    <section style={{ display: 'grid', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-lg)' }}>
      <h3>{t('bookmarkSync.heading')}</h3>
      <p>{t('bookmarkSync.description')}</p>
      <label>{t('bookmarkSync.token')}
        <input type="password" autoComplete="off" value={config.token}
          disabled={busy} onChange={e => setConfig({ ...config, token: e.target.value })} />
      </label>
      <label>{t('bookmarkSync.interval')}
        <select value={config.days} disabled={busy} onChange={e => setConfig({ ...config, days: Number(e.target.value) })}>
          <option value={1}>{t('bookmarkSync.daily')}</option>
          <option value={7}>{t('bookmarkSync.weekly')}</option>
        </select>
      </label>
      <div><button disabled={busy} onClick={save}>{t('bookmarkSync.save')}</button>{' '}
        <button disabled={busy || !config.token.trim()} onClick={sync}>{t(busy ? 'bookmarkSync.busy' : 'bookmarkSync.now')}</button>
      </div>
      <p role="status">{message}</p>
    </section>
    <ExhentaiAccountSettings />
  </>;
}
