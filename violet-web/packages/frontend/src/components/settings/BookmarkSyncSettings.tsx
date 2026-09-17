import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBookmarkSyncConfig, saveBookmarkSyncConfig, syncBookmarks } from '../../services/bookmark-sync';
import styles from '../../pages/SettingsPage.module.css';
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
    } catch {
      setMessage(t('bookmarkSync.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className={styles.section}>
        <h3 className={styles.subheading}>{t('bookmarkSync.heading')}</h3>
        <p className={styles.themeDesc}>{t('bookmarkSync.description')}</p>

        <div className={styles.settingGroup}>
          <label className={styles.settingLabel}>{t('bookmarkSync.token')}</label>
          <input
            type="password"
            autoComplete="off"
            className={styles.tagInput}
            value={config.token}
            disabled={busy}
            onChange={(event) => setConfig({ ...config, token: event.target.value })}
          />
        </div>

        <div className={styles.settingGroup}>
          <label className={styles.settingLabel}>{t('bookmarkSync.interval')}</label>
          <select
            className={styles.select}
            value={config.days}
            disabled={busy}
            onChange={(event) => setConfig({ ...config, days: Number(event.target.value) })}
          >
            <option value={1}>{t('bookmarkSync.daily')}</option>
            <option value={7}>{t('bookmarkSync.weekly')}</option>
          </select>
        </div>

        <div className={styles.syncButtons}>
          <button className={styles.fullSyncBtn} disabled={busy} onClick={save}>
            {t('bookmarkSync.save')}
          </button>
          <button
            className={styles.syncBtn}
            disabled={busy || !config.token.trim()}
            onClick={sync}
          >
            {t(busy ? 'bookmarkSync.busy' : 'bookmarkSync.now')}
          </button>
        </div>

        {message && (
          <div className={styles.statusMessage} role="status">
            <span className={styles.statusDetail}>{message}</span>
          </div>
        )}
      </div>

      <ExhentaiAccountSettings />
    </>
  );
}
