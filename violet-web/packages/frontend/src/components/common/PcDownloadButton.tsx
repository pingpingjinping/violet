import { Download, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePcDownloadStore } from '../../stores/pc-download-store';
import styles from './PcDownloadButton.module.css';

export function PcDownloadButton({ galleryId, compact = false }: { galleryId: number; compact?: boolean }) {
  const { t } = useTranslation();
  const state = usePcDownloadStore();
  const active = !!state.controller;
  const own = state.galleryId === galleryId;
  const label = active
    ? state.total ? t('pcDownload.progress', { completed: state.completed, total: state.total }) : t('pcDownload.preparing')
    : t('pcDownload.save');
  return (
    <div className={`${styles.wrapper} ${compact ? styles.viewer : ''}`} onClick={(event) => event.stopPropagation()}>
      <button className={styles.button} disabled={active} title={label} aria-label={label}
        onClick={() => void state.start(galleryId)}>
        <Download size={18} />
        {(!compact || active) && <span>{label}</span>}
      </button>
      {active && <button className={styles.button} onClick={state.cancel} title={t('pcDownload.cancel')} aria-label={t('pcDownload.cancel')}><X size={18} /></button>}
      {!active && own && state.result && <span className={styles.result} role="status">{t(`pcDownload.${state.result}`)}</span>}
    </div>
  );
}
