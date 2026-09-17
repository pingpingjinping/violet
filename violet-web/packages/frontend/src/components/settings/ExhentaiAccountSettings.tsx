import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getExhentaiAccountStatus,
  refreshExhentaiAccount,
  removeExhentaiAccount,
  saveExhentaiAccount,
  type ExhentaiAccountStatus,
} from '../../api/exhentai-account';
import styles from '../../pages/SettingsPage.module.css';

const EMPTY_STATUS: ExhentaiAccountStatus = {
  configured: false,
  cookieConfigured: false,
  refreshing: false,
  lastCheckAt: null,
  lastRefreshAt: null,
  lastError: null,
};

function formatTime(value: string | null): string {
  if (!value) return '-';
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function findCookieCard(): { card: HTMLElement; before: HTMLElement | null } | null {
  const labels = Array.from(document.querySelectorAll('label'));
  const memberIdLabel = labels.find((label) => label.textContent?.trim() === 'ipb_member_id');
  if (!memberIdLabel) return null;

  let node: HTMLElement | null = memberIdLabel.parentElement;
  while (node && !node.querySelector('h3')) {
    node = node.parentElement;
  }
  if (!node) return null;

  return {
    card: node,
    before: memberIdLabel.parentElement,
  };
}

export function ExhentaiAccountSettings() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<ExhentaiAccountStatus>(EMPTY_STATUS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [autoLoginOpen, setAutoLoginOpen] = useState(false);
  const [manualCookieOpen, setManualCookieOpen] = useState(false);

  useEffect(() => {
    void getExhentaiAccountStatus()
      .then(setStatus)
      .catch(() => setMessage('상태를 불러오지 못했습니다.'));
  }, []);

  useEffect(() => {
    const target = findCookieCard();
    if (!target) return;

    const host = document.createElement('div');
    host.dataset.exhentaiAccountSettings = 'true';
    target.card.insertBefore(host, target.before);
    setPortalHost(host);

    return () => {
      setPortalHost(null);
      host.remove();
    };
  }, []);

  useEffect(() => {
    if (!portalHost) return;

    const manualNodes: HTMLElement[] = [];
    let node = portalHost.nextElementSibling as HTMLElement | null;
    while (node) {
      manualNodes.push(node);
      node = node.nextElementSibling as HTMLElement | null;
    }

    for (const manualNode of manualNodes) {
      manualNode.style.display = manualCookieOpen ? '' : 'none';
    }

    return () => {
      for (const manualNode of manualNodes) {
        manualNode.style.display = '';
      }
    };
  }, [portalHost, manualCookieOpen]);

  const save = async () => {
    setBusy(true);
    setMessage('');
    try {
      const next = await saveExhentaiAccount(username, password);
      setStatus(next);
      setPassword('');
      setMessage('로그인 성공. 쿠키를 저장했고 필요할 때 자동 갱신하도록 설정했습니다.');
    } catch (error: any) {
      setMessage(error?.response?.data?.error || '로그인에 실패했습니다. 서버 로그를 확인하세요.');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setMessage('');
    try {
      const next = await refreshExhentaiAccount();
      setStatus(next);
      setMessage('쿠키를 다시 발급해 저장했습니다.');
    } catch (error: any) {
      setMessage(error?.response?.data?.error || '쿠키 갱신에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setMessage('');
    try {
      const next = await removeExhentaiAccount();
      setStatus(next);
      setUsername('');
      setPassword('');
      setMessage('자동 로그인용 계정 정보를 삭제했습니다. 기존 쿠키는 그대로 유지됩니다.');
    } catch {
      setMessage('계정 정보를 삭제하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  if (!portalHost) return null;

  const toggleButtonStyle = {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--spacing-sm)',
    padding: 0,
    border: 0,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left' as const,
  };

  return createPortal(
    <>
      <div style={{ borderTop: '1px solid var(--color-border, #e5e7eb)', margin: 'var(--spacing-md) 0', paddingTop: 'var(--spacing-md)' }}>
        <button
          type="button"
          style={toggleButtonStyle}
          aria-expanded={autoLoginOpen}
          onClick={() => setAutoLoginOpen((open) => !open)}
        >
          <h4 style={{ margin: 0, fontSize: '0.95rem' }}>계정 자동 로그인</h4>
          <span aria-hidden="true">{autoLoginOpen ? '▲' : '▼'}</span>
        </button>

        {autoLoginOpen && (
          <div style={{ marginTop: 'var(--spacing-sm)' }}>
            <p className={styles.themeDesc}>
              E-Hentai 계정으로 로그인해 ExHentai 쿠키를 자동 저장합니다. 평소에는 추가 확인 요청을 보내지 않고,
              실제 ExHentai 요청에서 인증이 실패했을 때만 재로그인해 쿠키를 갱신한 뒤 요청을 한 번 다시 시도합니다.
            </p>

            <div className={styles.syncInfo}>
              <div className={styles.infoRow}>
                <span className={styles.label}>자동 로그인</span>
                <span className={status.configured ? styles.statusOk : styles.statusError}>
                  {status.configured ? '설정됨' : '설정 안 됨'}
                </span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.label}>마지막 자동 갱신 시도</span>
                <span>{formatTime(status.lastCheckAt)}</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.label}>마지막 재발급</span>
                <span>{formatTime(status.lastRefreshAt)}</span>
              </div>
            </div>

            <div className={styles.settingGroup}>
              <label className={styles.settingLabel}>E-Hentai 아이디</label>
              <input
                type="text"
                autoComplete="username"
                className={styles.tagInput}
                value={username}
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>

            <div className={styles.settingGroup}>
              <label className={styles.settingLabel}>비밀번호</label>
              <input
                type="password"
                autoComplete="current-password"
                className={styles.tagInput}
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            <div className={styles.syncButtons}>
              <button
                className={styles.syncBtn}
                disabled={busy || !username.trim() || !password}
                onClick={save}
              >
                {busy ? '처리 중...' : '로그인하고 자동 갱신 켜기'}
              </button>
              <button
                className={styles.fullSyncBtn}
                disabled={busy || !status.configured}
                onClick={refresh}
              >
                지금 쿠키 갱신
              </button>
            </div>

            <div className={styles.syncButtons} style={{ marginTop: 'var(--spacing-sm)' }}>
              <button
                className={styles.fullSyncBtn}
                disabled={busy || !status.configured}
                onClick={remove}
              >
                자동 로그인 정보 삭제
              </button>
            </div>

            {message && (
              <div className={styles.statusMessage} role="status">
                <span className={message.includes('실패') || message.includes('못했습니다') ? styles.statusError : styles.statusDetail}>
                  {message}
                </span>
              </div>
            )}

            <p className={styles.themeDesc} style={{ marginTop: 'var(--spacing-md)' }}>
              계정 정보는 Pi 서버 파일에 권한 0600으로 저장되며 화면/API로 다시 표시되지 않습니다.
              자동 로그인에 실패해도 기존 쿠키는 삭제하지 않습니다. Cloudflare 확인 화면이 뜨는 경우에는 아래 수동 쿠키 입력을 계속 사용할 수 있습니다.
            </p>
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--color-border, #e5e7eb)', margin: 'var(--spacing-md) 0', paddingTop: 'var(--spacing-md)' }}>
        <button
          type="button"
          style={toggleButtonStyle}
          aria-expanded={manualCookieOpen}
          onClick={() => setManualCookieOpen((open) => !open)}
        >
          <h4 style={{ margin: 0, fontSize: '0.95rem' }}>수동 쿠키</h4>
          <span aria-hidden="true">{manualCookieOpen ? '▲' : '▼'}</span>
        </button>
        {manualCookieOpen && (
          <p className={styles.themeDesc} style={{ marginTop: 'var(--spacing-sm)' }}>
            자동 로그인이 동작하지 않을 때 ipb_member_id, ipb_pass_hash, igneous 값을 직접 저장할 수 있습니다.
          </p>
        )}
      </div>
    </>,
    portalHost,
  );
}
