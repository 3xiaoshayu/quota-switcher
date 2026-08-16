import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronLeft, ChevronRight, ExternalLink, Pin, RefreshCw, X } from 'lucide-react';
import { AccountQuota, ProductKind } from '../types';
import {
  desktopApi,
  formatResetLine,
  hasDesktopBridge,
  canRefreshQuota,
  canSwitchAccount,
  hideStaleQuota,
  isCursorAccount,
  lensQuotaWindows,
  planLabel,
  quotaHero,
  quotaStroke,
  statusTextForAccount,
  STATUS_TEXT,
} from '../api/desktop';
import { toCursorUserMessage, toUserMessage } from '../api/user-messages';
import { previewAccountsForLens } from '../data/mockData';
import { productById, readStoredProduct } from '../data/products';
import './FloatLens.css';

const RING_SIZE = 188;
const RING_CENTER = RING_SIZE / 2;
const OUTER_RADIUS = 78;
const INNER_RADIUS = 62;
const PAIR_SIZE = 112;
const PAIR_CENTER = PAIR_SIZE / 2;
const PAIR_RADIUS = 44;
const SILENT_REFRESH_MS = 60_000;

function hasFill(percent: number | null | undefined): boolean {
  return percent != null && Number.isFinite(percent) && percent > 0;
}

function ringLength(radius: number): number {
  return 2 * Math.PI * radius;
}

function arcOffset(radius: number, percent: number | null): number {
  const length = ringLength(radius);
  if (percent == null || !Number.isFinite(percent)) return length;
  return length * (1 - Math.max(0, Math.min(100, percent)) / 100);
}

function blockedRefreshText(account: AccountQuota): string {
  return account.status === 'BANNED' && !isCursorAccount(account)
    ? '账号已封号，无法刷新额度'
    : '该账号需要重新授权后才能刷新额度';
}

function blockedSwitchText(account: AccountQuota): string {
  return account.status === 'BANNED' && !isCursorAccount(account)
    ? '账号已封号，无法切换'
    : '该账号需要重新授权后才能切换';
}

function planBadgeText(account: AccountQuota): string {
  return planLabel(account.plan);
}

function statusBadgeText(account: AccountQuota): string | null {
  if (account.status === 'BANNED' && !isCursorAccount(account)) return STATUS_TEXT.BANNED;
  if (account.status === 'SUSPENDED' || account.status === 'LIMITED' || account.status === 'SYNC_FAILED' || account.status === 'EXPIRED') {
    return statusTextForAccount(account);
  }
  return null;
}

function accountErrorText(product: ProductKind, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return product === 'cursor' ? toCursorUserMessage(raw) : toUserMessage(raw);
}

function tokenRemainLine(text: string | null | undefined): string {
  const value = String(text || '').trim();
  if (!value) return '';
  if (value.startsWith('剩余')) return `登录还剩 ${value.slice(2).trim()}`;
  if (value === '已过期') return '登录已过期';
  if (value === '已失效') return '登录已失效';
  if (value === '有效期未知') return '登录有效期未知';
  return value;
}

function QuotaDial({
  size = 'hero',
  weekly,
  fiveHour,
  heroPercent,
  heroLabel,
  emptyKind,
  preview,
  spinning,
}: {
  size?: 'hero' | 'pair';
  weekly: number | null;
  fiveHour: number | null;
  heroPercent: number | null;
  heroLabel: string;
  emptyKind: 'reauth' | 'banned' | null;
  preview: boolean;
  spinning: boolean;
}) {
  const isPair = size === 'pair';
  const box = isPair ? PAIR_SIZE : RING_SIZE;
  const center = isPair ? PAIR_CENTER : RING_CENTER;
  const showInner = !isPair && fiveHour != null;
  const outerRadius = isPair ? PAIR_RADIUS : (showInner ? OUTER_RADIUS : 74);
  const outerWidth = isPair ? 7 : (showInner ? 8 : 10);
  const outerLength = ringLength(outerRadius);
  const innerLength = ringLength(INNER_RADIUS);
  const outerFill = weekly ?? heroPercent;
  const rest = !hasFill(heroPercent);
  return (
    <div
      className={`float-lens-dial${isPair ? ' is-pair' : ''}${rest ? ' is-rest' : ''}`}
      style={isPair && heroPercent != null ? { '--dial-tone': quotaStroke(heroPercent) } as CSSProperties : undefined}
    >
      <svg viewBox={`0 0 ${box} ${box}`} aria-hidden="true">
        <circle
          cx={center}
          cy={center}
          r={outerRadius}
          fill="none"
          stroke="rgba(255,255,255,0.10)"
          strokeWidth={outerWidth}
          strokeDasharray={preview ? '3 7' : undefined}
          strokeLinecap="round"
        />
        {hasFill(outerFill) ? (
          <circle
            className="float-lens-dial-arc"
            cx={center}
            cy={center}
            r={outerRadius}
            fill="none"
            stroke={quotaStroke(outerFill)}
            strokeWidth={outerWidth}
            strokeLinecap="round"
            strokeDasharray={outerLength}
            strokeDashoffset={arcOffset(outerRadius, outerFill)}
            transform={`rotate(-90 ${center} ${center})`}
          />
        ) : null}
        {showInner ? (
          <>
            <circle
              cx={center}
              cy={center}
              r={INNER_RADIUS}
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="5"
              strokeLinecap="round"
            />
            {hasFill(fiveHour) ? (
              <circle
                className="float-lens-dial-arc"
                cx={center}
                cy={center}
                r={INNER_RADIUS}
                fill="none"
                stroke={quotaStroke(fiveHour)}
                strokeWidth="5"
                strokeLinecap="round"
                strokeDasharray={innerLength}
                strokeDashoffset={arcOffset(INNER_RADIUS, fiveHour)}
                transform={`rotate(-90 ${center} ${center})`}
              />
            ) : null}
          </>
        ) : null}
      </svg>
      <div className={`float-lens-sweep${spinning ? ' is-on' : ''}`} />
      <div className="float-lens-readout">
        {heroPercent == null ? (
          isPair ? (
            <div className="float-lens-readout-label is-empty">{heroLabel}</div>
          ) : null
        ) : (
          <>
            <div className={`float-lens-readout-value${rest ? ' is-rest' : ''}${heroPercent === 0 ? ' is-empty-text' : ''}`}>
              {heroPercent === 0 ? '已用尽' : (
                <>
                  {Math.round(heroPercent)}
                  <span className="float-lens-readout-unit">%</span>
                </>
              )}
            </div>
            <div className="float-lens-readout-label">{heroLabel}</div>
          </>
        )}
      </div>
    </div>
  );
}

export default function FloatLens() {
  const [product, setProduct] = useState<ProductKind>(() => readStoredProduct());
  const [accounts, setAccounts] = useState<AccountQuota[]>([]);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const lensRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const productRef = useRef(product);
  productRef.current = product;
  const productLabel = productById(product).label;

  const applyProduct = useCallback((next: ProductKind) => {
    setProduct((current) => (current === next ? current : next));
  }, []);

  const loadAccounts = useCallback(async () => {
    const kind = productRef.current;
    if (!hasDesktopBridge()) {
      const previewAccounts = previewAccountsForLens(kind);
      setAccounts(previewAccounts);
      setViewedId((current) => {
        if (current && previewAccounts.some((account) => account.id === current)) return current;
        const live = previewAccounts.find((account) => account.isCurrent);
        return live?.id || previewAccounts[0]?.id || null;
      });
      setLoading(false);
      return previewAccounts;
    }
    try {
      const snapshot = await desktopApi.loadFloatAccounts(kind);
      if (productRef.current !== kind) return;
      setAccounts(snapshot.accounts);
      setViewedId((current) => {
        if (current && snapshot.accounts.some((account) => account.id === current)) return current;
        const live = snapshot.accounts.find((account) => account.isCurrent);
        return live?.id || snapshot.accounts[0]?.id || null;
      });
      return snapshot.accounts;
    } catch (error) {
      if (productRef.current !== kind) return;
      setErrorText(accountErrorText(kind, error));
    } finally {
      if (productRef.current === kind) setLoading(false);
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
    setConfirmSwitch(false);
    setErrorText(null);
    setRefreshing(false);
    setSwitching(false);
    setAccounts([]);
    setViewedId(null);
    setLoading(true);
  }, [product]);

  useEffect(() => {
    void loadAccounts();
  }, [product, loadAccounts]);

  useEffect(() => {
    if (!hasDesktopBridge()) return undefined;
    void desktopApi.getFloatState().then((state) => {
      setAlwaysOnTop(!!state?.alwaysOnTop);
      if (state?.product === 'cursor' || state?.product === 'codex') applyProduct(state.product);
    }).catch(() => {});
    return desktopApi.subscribe({
      onDaemonTick: () => { void loadAccounts(); },
      onAutoSwitch: () => { void loadAccounts(); },
      onFloatProduct: (next) => {
        if (next === 'cursor' || next === 'codex') applyProduct(next);
      },
    });
  }, [applyProduct, loadAccounts]);

  const viewed = useMemo(
    () => accounts.find((account) => account.id === viewedId) || accounts[0] || null,
    [accounts, viewedId],
  );
  const viewedIndex = viewed ? accounts.findIndex((account) => account.id === viewed.id) : -1;
  const hero = quotaHero(viewed);
  const windows = lensQuotaWindows(viewed);
  const isCurrent = !!viewed?.isCurrent;
  const hideQuota = hideStaleQuota(viewed);
  const hideFailedQuota = viewed?.status === 'SYNC_FAILED';
  const outerValue = hideQuota || hideFailedQuota ? null : windows.outer;
  const innerValue = hideQuota || hideFailedQuota ? null : windows.inner;
  const showInner = innerValue != null;
  const showOuter = outerValue != null;
  const innerReset = formatResetLine(windows.innerReset);
  const outerReset = formatResetLine(windows.outerReset);
  const resetLine = hero.key === 'fiveHour' ? innerReset : (outerReset || innerReset);
  const tokenLine = product === 'cursor' && !hideQuota && !hideFailedQuota ? tokenRemainLine(viewed?.tokenValidity) : '';
  const caption = tokenLine || (!hideQuota && !hideFailedQuota ? resetLine : '');
  const showPair = product === 'cursor' && !hideQuota;
  const planBadge = viewed ? planBadgeText(viewed) : '';
  const statusBadge = viewed ? statusBadgeText(viewed) : null;
  const emptyKind = hideQuota
    ? (viewed?.status === 'BANNED' && !isCursorAccount(viewed) ? 'banned' : 'reauth')
    : null;

  const moveAccount = useCallback((step: -1 | 1) => {
    if (accounts.length <= 1 || viewedIndex < 0) return;
    const next = (viewedIndex + step + accounts.length) % accounts.length;
    setViewedId(accounts[next].id);
    setConfirmSwitch(false);
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
    const kind = productRef.current;
    if ((kind === 'cursor') !== isCursorAccount(viewed)) return;
    if (!silent) {
      setRefreshing(true);
      setErrorText(null);
    }
    try {
      if (kind === 'cursor') await desktopApi.refreshCursorQuota(viewed.id, true);
      else await desktopApi.refreshQuota(viewed.id, true);
    } catch (error) {
      if (!silent && productRef.current === kind) {
        setErrorText(accountErrorText(kind, error));
      }
    } finally {
      try {
        if (productRef.current === kind) {
          const nextAccounts = await loadAccounts();
          if (!silent && productRef.current === kind) {
            const next = nextAccounts?.find((item) => item.id === viewed.id);
            if (next?.status === 'SUSPENDED') {
              setErrorText(next.warning || '该账号需要重新授权后才能刷新额度');
            } else if (next?.status === 'SYNC_FAILED') {
              setErrorText(next.warning || (kind === 'cursor' ? '这次没查清额度，请稍后重试。' : '额度同步失败，请稍后重试。'));
            }
          }
        }
      } finally {
        if (!silent) setRefreshing(false);
      }
    }
  }, [loadAccounts, refreshing, switching, viewed]);

  const openedRefreshKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!viewed || !hasDesktopBridge()) return;
    const key = `${productRef.current}:${viewed.id}`;
    if (openedRefreshKeyRef.current === key) return;
    openedRefreshKeyRef.current = key;
    void refreshViewed(true);
  }, [refreshViewed, viewed]);

  useEffect(() => {
    if (!viewed) return undefined;
    const timer = window.setInterval(() => {
      void refreshViewed(true);
    }, SILENT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshViewed, viewed]);

  useEffect(() => {
    const lens = lensRef.current;
    const shell = shellRef.current;
    if (!lens || !shell || !hasDesktopBridge()) return undefined;
    let frame = 0;
    const apply = () => {
      const nextHeight = Math.ceil(lens.getBoundingClientRect().height);
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
    const kind = productRef.current;
    if ((kind === 'cursor') !== isCursorAccount(viewed)) return;
    setSwitching(true);
    setErrorText(null);
    try {
      if (kind === 'cursor') await desktopApi.switchCursorAccount(viewed.id);
      else await desktopApi.switchAccount(viewed.id);
      setConfirmSwitch(false);
      if (productRef.current === kind) await loadAccounts();
    } catch (error) {
      if (productRef.current === kind) setErrorText(accountErrorText(kind, error));
    } finally {
      if (productRef.current === kind) setSwitching(false);
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
    <div className="float-lens" ref={lensRef}>
      <div className="float-lens-shell app-drag" ref={shellRef}>
        <div className="float-lens-chrome">
          <div
            className={`float-lens-mark${productLabel.length > 5 ? ' is-long' : ''}`}
            id="float-lens-mark"
          >
            {productLabel.toUpperCase()}
          </div>
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
              {showPair ? (
                <div className="float-lens-pair" id="float-lens-pair">
                  <QuotaDial
                    size="pair"
                    weekly={outerValue}
                    fiveHour={null}
                    heroPercent={outerValue}
                    heroLabel={windows.outerLabel}
                    emptyKind={null}
                    preview={!isCurrent}
                    spinning={refreshing}
                  />
                  <QuotaDial
                    size="pair"
                    weekly={innerValue}
                    fiveHour={null}
                    heroPercent={innerValue}
                    heroLabel={windows.innerLabel}
                    emptyKind={null}
                    preview={!isCurrent}
                    spinning={refreshing}
                  />
                </div>
              ) : (
                <QuotaDial
                  weekly={showOuter ? outerValue : null}
                  fiveHour={showInner ? innerValue : null}
                  heroPercent={hero.percent}
                  heroLabel={hero.label}
                  emptyKind={emptyKind}
                  preview={!isCurrent}
                  spinning={refreshing}
                />
              )}

              <div className="float-lens-identity" title={viewed.email}>
                <div className="float-lens-name">{viewed.email}</div>
                <div className="float-lens-pills">
                  <div className="float-lens-plan">{planBadge}</div>
                  {statusBadge ? <div className="float-lens-plan is-status">{statusBadge}</div> : null}
                </div>
                {caption ? (
                  <div className="float-lens-reset">
                    {caption}
                  </div>
                ) : null}
              </div>

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
                  {isCurrent ? '在用' : '未在用'}
                </div>
              </div>

              {!isCurrent ? (
                <div className="float-lens-action">
                  {confirmSwitch ? (
                    <div className="float-lens-confirm" id="float-lens-confirm">
                      <p>会关掉正在运行的官方 Cursor，再写入此账号。未保存的编辑可能会丢。</p>
                      <div className="float-lens-confirm-row">
                        <button
                          className="float-lens-confirm-cancel"
                          id="float-lens-confirm-cancel"
                          type="button"
                          disabled={switching}
                          onClick={() => setConfirmSwitch(false)}
                        >
                          取消
                        </button>
                        <button
                          className="float-lens-confirm-accept"
                          id="float-lens-confirm-accept"
                          type="button"
                          disabled={switching}
                          onClick={() => void handleSwitch()}
                        >
                          {switching ? '切换中...' : '确认切换'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="float-lens-switch"
                      type="button"
                      disabled={switching || !canSwitchAccount(viewed)}
                      title={!canSwitchAccount(viewed) ? blockedSwitchText(viewed) : '切到此账号'}
                      onClick={() => {
                        if (product === 'cursor') {
                          setConfirmSwitch(true);
                          return;
                        }
                        void handleSwitch();
                      }}
                    >
                      {switching ? <RefreshCw size={13} className="animate-spin" /> : <ArrowLeftRight size={13} />}
                      {switching
                        ? '切换中...'
                        : !canSwitchAccount(viewed)
                          ? (viewed.status === 'BANNED' && !isCursorAccount(viewed) ? '账号已封号，无法切换' : '需重新授权后才能切换')
                          : '切到此账号'}
                    </button>
                  )}
                </div>
              ) : null}
            </>
          ) : (
            <div className="float-lens-empty">
              <strong>{loading ? '正在读取账号' : '还没有账号'}</strong>
              <span>{loading ? '稍等片刻' : `先在主窗口添加一个 ${productLabel} 账号`}</span>
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
