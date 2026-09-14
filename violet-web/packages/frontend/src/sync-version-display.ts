import i18n from './i18n/config';

const dbVersionLabels: Record<string, string> = {
  ko: 'DB 버전:',
  en: 'DB version:',
  ja: 'DBバージョン:',
  zh: 'DB 版本:',
  eo: 'DB-versio:',
  it: 'Versione DB:',
  pt: 'Versão do DB:',
};

for (const [language, label] of Object.entries(dbVersionLabels)) {
  i18n.addResource(language, 'translation', 'settings.sync.lastSyncDb', label);
}

let mobileDbVersion: string | null = null;
let lastObservedSync = '';
let loading = false;

function formatDbVersion(timestamp: string): string | null {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toLocaleString();
}

async function loadMobileDbVersion() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch(`http://${window.location.hostname}:3002/syncversion.txt`, {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parts = (await response.text()).trim().split(/\s+/);
    mobileDbVersion = parts[0] === 'db' && parts[1] ? formatDbVersion(parts[1]) : null;
  } catch {
    mobileDbVersion = null;
  } finally {
    loading = false;
    renderDbVersion();
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

function renderDbVersion() {
  const versionLabel = i18n.t('settings.sync.lastSyncDb');
  const versionRow = findRowByLabel(versionLabel);
  if (!versionRow) return;

  const value = versionRow.lastElementChild as HTMLElement | null;
  const nextValue = mobileDbVersion || i18n.t('settings.sync.never');
  if (value && value.textContent !== nextValue) value.textContent = nextValue;

  const lastSyncRow = findRowByLabel(i18n.t('settings.sync.lastSync'));
  const currentLastSync = lastSyncRow?.lastElementChild?.textContent?.trim() || '';
  if (currentLastSync && currentLastSync !== lastObservedSync) {
    lastObservedSync = currentLastSync;
    void loadMobileDbVersion();
  }
}

const observer = new MutationObserver(() => renderDbVersion());
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

i18n.on('languageChanged', () => {
  lastObservedSync = '';
  renderDbVersion();
});

void loadMobileDbVersion();
