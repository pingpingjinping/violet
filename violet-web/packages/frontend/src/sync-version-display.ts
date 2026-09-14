import i18n from './i18n/config';

const syncVersionLabels: Record<string, string> = {
  ko: '동기화 버전:',
  en: 'Sync version:',
  ja: '同期バージョン:',
  zh: '同步版本:',
  eo: 'Sinkroniga versio:',
  it: 'Versione sincronizzazione:',
  pt: 'Versão de sincronização:',
};

for (const [language, label] of Object.entries(syncVersionLabels)) {
  i18n.addResource(language, 'translation', 'settings.sync.lastSyncDb', label);
}

let mobileDbSyncVersion: string | null = null;
let lastObservedSync = '';
let loading = false;

async function loadMobileDbSyncVersion() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch(`http://${window.location.hostname}:3002/syncversion.txt`, {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parts = (await response.text()).trim().split(/\s+/);
    mobileDbSyncVersion = parts[0] === 'db' ? parts[1] || null : null;
  } catch {
    mobileDbSyncVersion = null;
  } finally {
    loading = false;
    renderSyncVersion();
  }
}

function findRowByLabel(label: string): HTMLElement | null {
  for (const span of document.querySelectorAll('span')) {
    if (span.textContent?.trim() === label.trim()) {
      return span.parentElement as HTMLElement | null;
    }
  }
  return null;
}

function renderSyncVersion() {
  const versionLabel = i18n.t('settings.sync.lastSyncDb');
  const versionRow = findRowByLabel(versionLabel);
  if (!versionRow) return;

  const value = versionRow.lastElementChild as HTMLElement | null;
  if (value) value.textContent = mobileDbSyncVersion || i18n.t('settings.sync.never');

  const lastSyncRow = findRowByLabel(i18n.t('settings.sync.lastSync'));
  const currentLastSync = lastSyncRow?.lastElementChild?.textContent?.trim() || '';
  if (currentLastSync && currentLastSync !== lastObservedSync) {
    lastObservedSync = currentLastSync;
    void loadMobileDbSyncVersion();
  }
}

const observer = new MutationObserver(() => renderSyncVersion());
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

i18n.on('languageChanged', () => {
  lastObservedSync = '';
  renderSyncVersion();
});

void loadMobileDbSyncVersion();
