import { useEffect, useState } from 'react';
import {
  getExhentaiAccountStatus,
  refreshExhentaiAccount,
  removeExhentaiAccount,
  saveExhentaiAccount,
  type ExhentaiAccountStatus,
} from '../../api/exhentai-account';

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

export function ExhentaiAccountSettings() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<ExhentaiAccountStatus>(EMPTY_STATUS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void getExhentaiAccountStatus()
      .then(setStatus)
      .catch(() => setMessage('상태를 불러오지 못했습니다.'));
  }, []);

  const save = async () => {
    setBusy(true);
    setMessage('');
    try {
      const next = await saveExhentaiAccount(username, password);
      setStatus(next);
      setPassword('');
      setMessage('로그인 성공. 쿠키를 저장했고 자동 갱신을 켰습니다.');
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

  return (
    <section style={{ display: 'grid', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-lg)' }}>
      <h3>ExHentai 계정 자동 로그인</h3>
      <p>
        E-Hentai 아이디와 비밀번호로 로그인해 ExHentai 쿠키를 자동 저장합니다.
        서버가 6시간마다 쿠키를 확인하고 만료되었을 때만 재로그인을 시도합니다.
      </p>

      <div style={{ display: 'grid', gap: '0.35rem' }}>
        <div>자동 로그인: <strong>{status.configured ? '설정됨' : '설정 안 됨'}</strong></div>
        <div>ExHentai 쿠키: <strong>{status.cookieConfigured ? '있음' : '없음'}</strong></div>
        <div>마지막 확인: {formatTime(status.lastCheckAt)}</div>
        <div>마지막 재발급: {formatTime(status.lastRefreshAt)}</div>
        {status.lastError && <div style={{ color: 'var(--color-error, #d33)' }}>최근 오류: {status.lastError}</div>}
      </div>

      <label>
        E-Hentai 아이디
        <input
          type="text"
          autoComplete="username"
          value={username}
          disabled={busy}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label>
        비밀번호
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>

      <div>
        <button disabled={busy || !username.trim() || !password} onClick={save}>
          {busy ? '처리 중...' : '로그인하고 자동 갱신 켜기'}
        </button>{' '}
        <button disabled={busy || !status.configured} onClick={refresh}>
          지금 쿠키 갱신
        </button>{' '}
        <button disabled={busy || !status.configured} onClick={remove}>
          자동 로그인 정보 삭제
        </button>
      </div>

      <p role="status">{message}</p>
      <p style={{ opacity: 0.75 }}>
        계정 정보는 Pi의 서버 파일에 권한 0600으로 저장되며 화면/API로 다시 표시되지 않습니다.
        자동 로그인에 실패해도 기존 쿠키는 삭제하지 않습니다. Cloudflare 확인 화면이 뜨는 경우에는 수동 쿠키 입력을 계속 사용할 수 있습니다.
      </p>
    </section>
  );
}
