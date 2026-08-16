import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronLeft, ChevronRight, ExternalLink, Pin, RefreshCw, X } from 'lucide-react';
import { AccountQuota } from '../types';
import {
  desktopApi,
  formatResetLine,
  hasDesktopBridge,
  canRefreshQuota,
  canSwitchAccount,
  hideStaleQuota,
  quotaHero,
  quotaStroke,
  STATUS_TEXT,
} from '../api/desktop';
import { toUserMessage } from '../api/user-messages';
import { previewAccountsForLens } from '../data/mockData';
import './FloatLens.css';

const RING_SIZE = 188;
const RING_CENTER = RING_SIZE / 2;
const OUTER_RADIUS = 78;
const INNER_RADIUS = 62;
const SILENT_REFRESH_MS = 60_000;

function ringLength(radius: number): number {
  return 2 * Math.PI * radius;
}

function arcOffset(radius: number, percent: number | null): number {
  const length = ringLength(radius);
  if (percent == null || !Number.isFinite(percent)) return length;
  return length * (1 - Math.max(0, Math.min(100, percent)) / 100);
}

function percentLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}%`;
}

function blockedRefreshText(account: AccountQuota): string {
  return account.status === 'BANNED' ? '账号已封号，无法刷新额度' : '该账号需要重新授权后才能刷新额度';
}

function blockedSwitchText(account: AccountQuota): string {
  return account.status === 'BANNED' ? '账号已封号，无法切换' : '该账号需要重新授权后才能切换';
}

function identityStatusText(account: AccountQuota): string {
  if (
    account.status === 'BANNED'
    || account.status === 'SUSPENDED'
    || account.status === 'LIMITED'
    || account.status === 'SYNC_FAILED'
  ) {
    return STATUS_TEXT[account.status] || account.status;
  }
  return String(account.plan || 'Standard').toUpperCase();
}

function QuotaDial({
  weekly,
  fiveHour,
  heroPercent,
  heroLabel,
  preview,
  spinning,
}: {
  weekly: number | null;
  fiveHour: number | null;
  heroPercent: number | null;
  heroLabel: string;
  preview: boolean;
  spinning: boolean;
}) {
  const showInner = fiveHour != null;
  const outerRadius = showInner ? OUTER_RADIUS : 74;
  const outerWidth = showInner ? 8 : 10;
  const outerLength = ringLength(outerRadius);
  const innerLength = ringLength(INNER_RADIUS);
  return (
    <div className="float-lens-dial">
      <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={outerRadius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={outerWidth}
          strokeDasharray={preview ? '3 7' : undefined}
          strokeLinecap="round"
        />
        <circle
          className="float-lens-dial-arc"
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={outerRadius}
          fill="none"
          stroke={quotaStroke(weekly ?? heroPercent)}
          strokeWidth={outerWidth}
          strokeLinecap="round"
          strokeDasharray={outerLength}
          strokeDashoffset={arcOffset(outerRadius, weekly ?? heroPercent)}
          transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
        />
        {showInner ? (
          <>
            <circle
              cx={RING_CENTER}
              cy={RING_CENTER}
              r={INNER_RADIUS}
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="5"
              strokeLinecap="round"
            />
            <circle
              className="float-lens-dial-arc"
              cx={RING_CENTER}
              cy={RING_CENTER}
              r={INNER_RADIUS}
              fill="none"
              stroke={quotaStroke(fiveHour)}
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={innerLength}
              strokeDashoffset={arcOffset(INNER_RADIUS, fiveHour)}
              transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
            />
          </>
        ) : null}
      </svg>
      <div className={`float-lens-sweep${spinning ? ' is-on' : ''}`} />
      <div className="float-lens-readout">
        <div className="float-lens-readout-value">
          {heroPercent == null ? '—' : Math.round(heroPercent)}
          {heroPercent != null ? <span style={{ fontSize: 18, marginLeft: 1, color: 'rgba(235, 235, 245, 0.62)' }}>%</span> : null}
        </div>
        <div className="float-lens-readout-label">{heroLabel}</div>
      </div>
    </div>
  );
}

export default function FloatLens() {
  const [accounts, setAccounts] = useState<AccountQuota[]>([]);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const loadAccounts = useCallback(async () => {
    if (!hasDesktopBridge()) {
      const previewAccounts = previewAccountsForLens();
      setAccounts(previewAccounts);
      setViewedId((current) => {
        if (current && previewAccounts.some((account) => account.id === current)) return current;
        const live = previewAccounts.find((account) => account.isCurrent);
        return live?.id || previewAccounts[0]?.id || null;
      });
      setLoading(false);
      return;
    }
    try {
      const snapshot = await desktopApi.loadFloatAccounts();
      setAccounts(snapshot.accounts);
      setViewedId((current) => {
        if (current && snapshot.accounts.some((account) => account.id === current)) return current;
        const live = snapshot.accounts.find((account) => account.isCurrent);
        return live?.id || snapshot.accounts[0]?.id || null;
      });
    } catch (error) {
      setErrorText(toUserMessage(error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('float-lens-root');
    document.body.classList.add('float-lens-root');
    document.getElementById('root')?.classList.add('float-lens-root');
    return () => {
      document.documentElement.classList.remove('float-lens-root');
      document.body.classList.remove('float-lens-root');
      document.getElementById('root')?.classList.remove('float-lens-root');
    };
  }, []);

  useEffect(() => {
    void loadAccounts();
    if (!hasDesktopBridge()) return undefined;
    void desktopApi.getFloatState().then((state) => {
      setAlwaysOnTop(!!state?.alwaysOnTop);
    }).catch(() => {});
    return desktopApi.subscribe({
      onDaemonTick: () => { void loadAccounts(); },
      onAutoSwitch: () => { void loadAccounts(); },
    });
  }, [loadAccounts]);

  const viewed = useMemo(
    () => accounts.find((account) => account.id === viewedId) || accounts[0] || null,
    [accounts, viewedId],
  );
  const viewedIndex = viewed ? accounts.findIndex((account) => account.id === viewed.id) : -1;
  const hero = quotaHero(viewed);
  const isCurrent = !!viewed?.isCurrent;
  const hideQuota = hideStaleQuota(viewed);
  const weeklyValue = hideQuota ? null : (viewed && viewed.weeklyQuotaPresent !== false ? viewed.weeklyQuotaRemaining : null);
  const fiveHourValue = hideQuota ? null : (viewed && viewed.fiveHourQuotaPresent !== false ? viewed.fiveHourQuotaRemaining : null);
  const showFiveHour = viewed?.fiveHourQuotaPresent !== false && fiveHourValue != null;
  const showWeekly = viewed?.weeklyQuotaPresent !== false && weeklyValue != null;

  const moveAccount = useCallback((step: -1 | 1) => {
    if (accounts.length <= 1 || viewedIndex < 0) return;
    const next = (viewedIndex + step + accounts.length) % accounts.length;
    setViewedId(accounts[next].id);
    setErrorText(null);
  }, [accounts, viewedIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        moveAccount(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveAccount(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moveAccount]);

  const refreshViewed = useCallback(async (silent = false) => {
    if (!viewed || refreshing || switching) return;
    if (!canRefreshQuota(viewed)) {
      if (!silent) {
        setErrorText(blockedRefreshText(viewed));
      }
      return;
    }
    if (!silent) {
      setRefreshing(true);
      setErrorText(null);
    }
    try {
      await desktopApi.refreshQuota(viewed.id, true);
    } catch (error) {
      if (!silent) {
        setErrorText(toUserMessage(error instanceof Error ? error.message : String(error)));
      }
    } finally {
      await loadAccounts();
      if (!silent) setRefreshing(false);
    }
  }, [loadAccounts, refreshing, switching, viewed]);

  useEffect(() => {
    if (!viewed) return undefined;
    const timer = window.setInterval(() => {
      void refreshViewed(true);
    }, SILENT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshViewed, viewed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') moveAccount(-1);
      if (event.key === 'ArrowRight') moveAccount(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveAccount]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !hasDesktopBridge()) return undefined;
    let frame = 0;
    const apply = () => {
      const nextHeight = Math.ceil(shell.getBoundingClientRect().height) + 20;
      void desktopApi.setFloatHeight(nextHeight).catch(() => {});
    };
    const observer = new ResizeObserver(() => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(apply);
    });
    observer.observe(shell);
    apply();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const handleSwitch = useCallback(async () => {
    if (!viewed || isCurrent || switching) return;
    if (viewed.status === 'SUSPENDED' || viewed.status === 'BANNED') {
      setErrorText(blockedSwitchText(viewed));
      return;
    }
    setSwitching(true);
    setErrorText(null);
    try {
      await desktopApi.switchAccount(viewed.id);
      await loadAccounts();
    } catch (error) {
      setErrorText(toUserMessage(error instanceof Error ? error.message : String(error)));
    } finally {
      setSwitching(false);
    }
  }, [isCurrent, loadAccounts, switching, viewed]);

  const handlePin = useCallback(async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    try {
      await desktopApi.setFloatAlwaysOnTop(next);
    } catch {
      setAlwaysOnTop(!next);
    }
  }, [alwaysOnTop]);

  return (
    <div className="float-lens">
      <div className="float-lens-shell app-drag" ref={shellRef}>
        <div className="float-lens-chrome">
          <div className="float-lens-mark">CODEX</div>
          <div className="float-lens-tools">
            <button
              className={`float-lens-icon${alwaysOnTop ? ' is-on' : ''}`}
              type="button"
              title={alwaysOnTop ? '取消置顶' : '置顶'}
              onClick={() => void handlePin()}
            >
              <Pin size={16} />
            </button>
            <button
              className="float-lens-icon"
              type="button"
              title="关闭"
              onClick={() => void desktopApi.hideFloatWindow()}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="float-lens-body">
          {viewed ? (
            <>
              <QuotaDial
                weekly={showWeekly ? weeklyValue : null}
                fiveHour={showFiveHour ? fiveHourValue : null}
                heroPercent={hero.percent}
                heroLabel={hero.label}
                preview={!isCurrent}
                spinning={refreshing}
              />

              <div className="float-lens-identity" title={viewed.email}>
                <div className="float-lens-name">{viewed.email}</div>
                <div className="float-lens-plan">
                  {identityStatusText(viewed)}
                </div>
                {!(showFiveHour && showWeekly) && !hideQuota ? (
                  <div className="float-lens-reset">
                    {formatResetLine(showWeekly ? viewed.weeklyResetAt : viewed.fiveHourResetAt)}
                  </div>
                ) : null}
              </div>

              {showFiveHour && showWeekly ? (
              <div className="float-lens-complications">
                <div className="float-lens-cell">
                  <div className="float-lens-cell-kicker" style={{ color: quotaStroke(fiveHourValue) }}>
                    <span className="float-lens-dot" />
                    5 小时
                  </div>
                  <div className="float-lens-cell-value">{percentLabel(fiveHourValue)}</div>
                  <div className="float-lens-cell-reset">{formatResetLine(viewed.fiveHourResetAt)}</div>
                </div>
                <div className="float-lens-cell">
                  <div className="float-lens-cell-kicker" style={{ color: quotaStroke(weeklyValue) }}>
                    <span className="float-lens-dot" />
                    周额度
                  </div>
                  <div className="float-lens-cell-value">{percentLabel(weeklyValue)}</div>
                  <div className="float-lens-cell-reset">{formatResetLine(viewed.weeklyResetAt)}</div>
                </div>
              </div>
              ) : null}

              <div className="float-lens-pager">
                <div className="float-lens-nav">
                  <button
                    className="float-lens-icon"
                    type="button"
                    title="上一个账号"
                    disabled={accounts.length <= 1}
                    onClick={() => moveAccount(-1)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <div className="float-lens-count">
                    {String(Math.max(1, viewedIndex + 1)).padStart(2, '0')} / {String(Math.max(accounts.length, 1)).padStart(2, '0')}
                  </div>
                  <button
                    className="float-lens-icon"
                    type="button"
                    title="下一个账号"
                    disabled={accounts.length <= 1}
                    onClick={() => moveAccount(1)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
                <div className={`float-lens-state${isCurrent ? ' is-live' : ''}`}>
                  <span className="float-lens-state-dot" />
                  {isCurrent ? '在用' : '预览 · 非当前登录'}
                </div>
              </div>

              {!isCurrent ? (
                <div className="float-lens-action">
                  <button
                    className="float-lens-switch"
                    type="button"
                    disabled={switching || !canSwitchAccount(viewed)}
                    title={!canSwitchAccount(viewed) ? blockedSwitchText(viewed) : '切到此账号'}
                    onClick={() => void handleSwitch()}
                  >
                    {switching ? <RefreshCw size={13} className="animate-spin" /> : <ArrowLeftRight size={13} />}
                    {switching
                      ? '切换中...'
                      : !canSwitchAccount(viewed)
                        ? (viewed.status === 'BANNED' ? '账号已封号，无法切换' : '需授权后才能切换')
                        : '切到此账号'}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="float-lens-empty">
              <strong>{loading ? '正在读取账号' : '还没有账号'}</strong>
              <span>{loading ? '稍等片刻' : '先在主窗口添加一个 Codex 账号'}</span>
            </div>
          )}
        </div>

        <div className="float-lens-footer">
          <div className="float-lens-error" title={errorText || ''}>{errorText || ''}</div>
          <div className="float-lens-tools">
            <button
              className="float-lens-icon"
              type="button"
              title={!viewed || canRefreshQuota(viewed) ? '刷新额度' : blockedRefreshText(viewed)}
              disabled={!viewed || refreshing || switching || !canRefreshQuota(viewed)}
              onClick={() => void refreshViewed(false)}
            >
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : undefined} />
            </button>
            <button
              className="float-lens-icon"
              type="button"
              title="打开主窗口"
              onClick={() => void desktopApi.showMainWindow()}
            >
              <ExternalLink size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
