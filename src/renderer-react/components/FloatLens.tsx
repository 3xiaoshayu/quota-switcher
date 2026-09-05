import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronLeft, ChevronRight, ExternalLink, Pin, RefreshCw, X } from 'lucide-react';
import { AccountQuota, ProductKind } from '../types';
import {
  desktopApi,
  formatResetLine,
  hasDesktopBridge,
  canRefreshQuota,
  canSwitchAccount,
  antigravityQuotaFamilies,
  hideStaleQuota,
  isManagedProductAccount,
  lensQuotaWindows,
  planCaption,
  quotaHero,
  quotaStroke,
  statusTextForAccount,
  STATUS_TEXT,
  withCurrentFlag,
} from '../api/desktop';
import { floatChromeMark, isManagedProduct, officialClientLabel, productActions, productLabel as productName, toProductUserMessage } from '../api/product-adapter';
import { previewAccountsForLens } from '../data/mockData';
import { isActiveProduct, readStoredProduct } from '../data/products';
import './FloatLens.css';

const RING_SIZE = 156;
const RING_CENTER = RING_SIZE / 2;
const OUTER_RADIUS = 65;
const INNER_RADIUS = 51;
const PAIR_SIZE = 112;
const PAIR_CENTER = PAIR_SIZE / 2;
const PAIR_RADIUS = 44;
const PAIR_NEST_OUTER_RADIUS = 42;
const PAIR_NEST_OUTER_WIDTH = 5;
const PAIR_NEST_INNER_RADIUS = 30;
const PAIR_NEST_INNER_WIDTH = 3;
const SILENT_REFRESH_MS = 60_000;

function hasFill(percent: number | null | undefined): boolean {
  return percent != null && Number.isFinite(percent) && percent > 0;
}

function pickViewedId(accounts: AccountQuota[], current: string | null | undefined): string | null {
  if (current && accounts.some((account) => account.id === current)) return current;
  const live = accounts.find((account) => account.isCurrent);
  return live?.id || accounts[0]?.id || null;
}

function tighterRemaining(weekly: number | null | undefined, fiveHour: number | null | undefined): number | null {
  const week = weekly ?? null;
  const hourly = fiveHour ?? null;
  if (week == null && hourly == null) return null;
  if (week == null) return hourly;
  if (hourly == null) return week;
  return Math.min(week, hourly);
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
  return account.status === 'BANNED' && !isManagedProductAccount(account)
    ? '账号已封号，无法刷新额度'
    : '该账号需要重新授权后才能刷新额度';
}

function blockedSwitchText(account: AccountQuota): string {
  if (account.status === 'BANNED' && !isManagedProductAccount(account)) return '账号已封号，无法切换';
  if (account.tokenAccessAvailable === false) return '该账号没有可用登录令牌，无法切换';
  return '该账号需要重新授权后才能切换';
}

function planBadgeText(account: AccountQuota): string {
  return planCaption(account);
}

function statusBadgeText(account: AccountQuota): string | null {
  if (account.status === 'BANNED' && !isManagedProductAccount(account)) return STATUS_TEXT.BANNED;
  if (account.status === 'SUSPENDED' || account.status === 'LIMITED' || account.status === 'SYNC_FAILED' || account.status === 'EXPIRED') {
    return statusTextForAccount(account);
  }
  return null;
}

function accountErrorText(product: ProductKind, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return toProductUserMessage(product, raw);
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

function splitEmail(email: string | null | undefined): { local: string; domain: string } {
  const value = String(email || '').trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return { local: value, domain: '' };
  return { local: value.slice(0, at), domain: value.slice(at) };
}

function QuotaDial({
  size = 'hero',
  weekly,
  fiveHour,
  heroPercent,
  heroLabel,
  emptyKind,
  nest = false,
  spinning,
}: {
  size?: 'hero' | 'pair';
  weekly: number | null;
  fiveHour: number | null;
  heroPercent: number | null;
  heroLabel: string;
  emptyKind: 'reauth' | 'banned' | null;
  nest?: boolean;
  spinning: boolean;
}) {
  const isPair = size === 'pair';
  const showInner = fiveHour != null || nest;
  const nested = showInner;
  const box = isPair ? PAIR_SIZE : RING_SIZE;
  const center = isPair ? PAIR_CENTER : RING_CENTER;
  const outerRadius = isPair
    ? (nested ? PAIR_NEST_OUTER_RADIUS : PAIR_RADIUS)
    : (nested ? OUTER_RADIUS : 61);
  const outerWidth = isPair
    ? (nested ? PAIR_NEST_OUTER_WIDTH : 7)
    : (nested ? 8 : 10);
  const innerRadius = isPair ? PAIR_NEST_INNER_RADIUS : INNER_RADIUS;
  const innerWidth = isPair ? PAIR_NEST_INNER_WIDTH : 5;
  const outerLength = ringLength(outerRadius);
  const innerLength = ringLength(innerRadius);
  const outerFill = nested ? weekly : (weekly ?? heroPercent);
  const rest = !hasFill(heroPercent);
  const captionBelow = isPair && nested;
  const glow = quotaStroke(heroPercent);
  const discRadius = Math.max(16, (nested ? innerRadius : outerRadius) - (nested ? innerWidth : outerWidth) - 5);
  const dial = (
    <div
      className={`float-lens-dial${isPair ? ' is-pair' : ''}${captionBelow ? ' is-nested' : ''}${rest ? ' is-rest' : ''}`}
      style={{
        ...(heroPercent != null ? { '--dial-glow': glow } : {}),
        ...(isPair && !captionBelow && heroPercent != null ? { '--dial-tone': glow } : {}),
      } as CSSProperties}
    >
      <svg viewBox={`0 0 ${box} ${box}`} aria-hidden="true">
        <circle
          cx={center}
          cy={center}
          r={discRadius}
          fill="rgba(255,255,255,0.03)"
        />
        <circle
          cx={center}
          cy={center}
          r={outerRadius}
          fill="none"
          stroke="rgba(255,255,255,0.13)"
          strokeWidth={outerWidth}
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
            opacity={nested ? 0.72 : 1}
          />
        ) : null}
        {showInner ? (
          <>
            <circle
              cx={center}
              cy={center}
              r={innerRadius}
              fill="none"
              stroke="rgba(255,255,255,0.10)"
              strokeWidth={innerWidth}
              strokeLinecap="round"
            />
            {hasFill(fiveHour) ? (
              <circle
                className="float-lens-dial-arc"
                cx={center}
                cy={center}
                r={innerRadius}
                fill="none"
                stroke={quotaStroke(fiveHour)}
                strokeWidth={innerWidth}
                strokeLinecap="round"
                strokeDasharray={innerLength}
                strokeDashoffset={arcOffset(innerRadius, fiveHour)}
                transform={`rotate(-90 ${center} ${center})`}
              />
            ) : null}
          </>
        ) : null}
      </svg>
      <div className={`float-lens-sweep${spinning ? ' is-on' : ''}`} />
      <div className="float-lens-readout">
        {heroPercent == null ? (
          isPair && !captionBelow ? (
            <div className="float-lens-readout-label is-empty">{heroLabel}</div>
          ) : captionBelow ? null : (
            <div className={`float-lens-readout-value is-empty-text${heroLabel.length > 4 ? ' is-long' : ''}`}>
              {emptyKind === 'banned' ? '已封号' : emptyKind === 'reauth' ? '需重新授权' : heroLabel}
            </div>
          )
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
            {captionBelow ? null : (
              <div className="float-lens-readout-label">{heroLabel}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
  if (!captionBelow) return dial;
  return (
    <div className="float-lens-dial-col">
      {dial}
      <div className="float-lens-dial-caption">{heroLabel}</div>
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
  const cacheRef = useRef<Partial<Record<ProductKind, { accounts: AccountQuota[]; viewedId: string | null }>>>({});
  const cacheProductRef = useRef(product);
  const productLabel = productName(product);
  const chromeMark = floatChromeMark(product);
  const actions = productActions();

  if (cacheProductRef.current !== product) {
    cacheProductRef.current = product;
    const cached = cacheRef.current[product];
    if (cached) {
      setAccounts(cached.accounts);
      setViewedId(cached.viewedId);
      setLoading(false);
    } else {
      setAccounts([]);
      setViewedId(null);
      setLoading(true);
    }
    setConfirmSwitch(false);
    setErrorText(null);
    setRefreshing(false);
    setSwitching(false);
  }

  const applyProduct = useCallback((next: ProductKind) => {
    setProduct((current) => (current === next ? current : next));
  }, []);

  const applyAccounts = useCallback((kind: ProductKind, nextAccounts: AccountQuota[]) => {
    setAccounts(nextAccounts);
    setViewedId((current) => {
      const nextId = pickViewedId(nextAccounts, current);
      cacheRef.current[kind] = { accounts: nextAccounts, viewedId: nextId };
      return nextId;
    });
  }, []);

  const loadAccounts = useCallback(async () => {
    const kind = productRef.current;
    if (!hasDesktopBridge()) {
      const previewAccounts = previewAccountsForLens(kind);
      applyAccounts(kind, previewAccounts);
      setLoading(false);
      return previewAccounts;
    }
    try {
      const snapshot = await desktopApi.loadFloatAccounts(kind);
      if (productRef.current !== kind) return;
      applyAccounts(kind, snapshot.accounts);
      if (kind === 'antigravity' || kind === 'cursor') {
        const refresh = kind === 'antigravity'
          ? desktopApi.loadAntigravityState()
          : desktopApi.loadCursorState();
        void refresh.then((fresh) => {
          if (productRef.current !== kind) return;
          applyAccounts(kind, fresh.accounts);
        }).catch(() => {});
      }
      return snapshot.accounts;
    } catch (error) {
      if (productRef.current !== kind) return;
      setErrorText(accountErrorText(kind, error));
    } finally {
      if (productRef.current === kind) setLoading(false);
    }
  }, [applyAccounts]);

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
  }, [product, loadAccounts]);

  useEffect(() => {
    if (!hasDesktopBridge()) return undefined;
    void desktopApi.getFloatState().then((state) => {
      setAlwaysOnTop(!!state?.alwaysOnTop);
      if (isActiveProduct(state?.product)) applyProduct(state.product);
    }).catch(() => {});
    return desktopApi.subscribe({
      onDaemonTick: () => { void loadAccounts(); },
      onAccountUpdated: (payload) => {
        if (payload?.product !== productRef.current) return;
        if (payload?.current && payload.account?.id) {
          const currentId = payload.account.id;
          setAccounts((prev) => {
            const next = withCurrentFlag(prev, currentId);
            cacheRef.current[productRef.current] = { accounts: next, viewedId: currentId };
            return next;
          });
          setViewedId(currentId);
        }
        void loadAccounts();
      },
      onFloatProduct: (next) => {
        if (isActiveProduct(next)) applyProduct(next);
      },
    });
  }, [applyProduct, loadAccounts]);

  const viewed = useMemo(
    () => accounts.find((account) => account.id === viewedId) || accounts[0] || null,
    [accounts, viewedId],
  );

  useEffect(() => {
    if (product !== 'antigravity' || viewed) return undefined;
    const timer = window.setInterval(() => {
      void loadAccounts();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [product, viewed, loadAccounts]);
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
  const tokenLine = isManagedProduct(product) && !hideQuota && !hideFailedQuota ? tokenRemainLine(viewed?.tokenValidity) : '';
  const caption = tokenLine || (!hideQuota && !hideFailedQuota ? resetLine : '');
  const showPair = product === 'antigravity'
    ? !!viewed
    : isManagedProduct(product) && !hideQuota;
  const pairDials = showPair && viewed && product === 'antigravity'
    ? antigravityQuotaFamilies(viewed).map((family) => {
      const weekly = hideQuota || hideFailedQuota ? null : family.weekly.remaining;
      const fiveHour = hideQuota || hideFailedQuota ? null : family.fiveHour.remaining;
      return {
        weekly,
        fiveHour,
        heroPercent: tighterRemaining(weekly, fiveHour),
        heroLabel: family.title,
      };
    })
    : [
      { weekly: outerValue, fiveHour: null as number | null, heroPercent: outerValue, heroLabel: windows.outerLabel },
      { weekly: innerValue, fiveHour: null as number | null, heroPercent: innerValue, heroLabel: windows.innerLabel },
    ];
  const planBadge = viewed ? planBadgeText(viewed) : '';
  const statusBadge = viewed ? statusBadgeText(viewed) : null;
  const emailParts = splitEmail(viewed?.email);
  const emptyKind = hideQuota
    ? (viewed?.status === 'BANNED' && !isManagedProductAccount(viewed) ? 'banned' : 'reauth')
    : null;

  const moveAccount = useCallback((step: -1 | 1) => {
    if (accounts.length <= 1 || viewedIndex < 0) return;
    const next = (viewedIndex + step + accounts.length) % accounts.length;
    const nextId = accounts[next].id;
    setViewedId(nextId);
    const cached = cacheRef.current[product];
    if (cached) cacheRef.current[product] = { ...cached, viewedId: nextId };
    setConfirmSwitch(false);
    setErrorText(null);
  }, [accounts, viewedIndex, product]);

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
    if (isManagedProduct(kind) !== isManagedProductAccount(viewed)) return;
    if (!silent) {
      setRefreshing(true);
      setErrorText(null);
    }
    try {
      await actions.refreshQuota(kind, viewed.id, true);
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
              setErrorText(next.warning || (isManagedProduct(kind) ? '这次没查清额度，请稍后重试。' : '额度同步失败，请稍后重试。'));
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

  // The interval must keep its cadence across list reloads: `viewed` is a new
  // object after every daemon tick or account update, and re-arming the timer
  // on each of those would keep resetting the 60 s countdown before it fires.
  const refreshViewedRef = useRef(refreshViewed);
  useEffect(() => {
    refreshViewedRef.current = refreshViewed;
  }, [refreshViewed]);
  const viewedAccountId = viewed?.id ?? null;
  useEffect(() => {
    if (!viewedAccountId) return undefined;
    const timer = window.setInterval(() => {
      void refreshViewedRef.current(true);
    }, SILENT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [viewedAccountId]);

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
    if (isManagedProduct(kind) !== isManagedProductAccount(viewed)) return;
    setSwitching(true);
    setErrorText(null);
    try {
      await actions.switchAccount(kind, viewed.id);
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
            className={`float-lens-mark${chromeMark.length > 8 ? ' is-full' : chromeMark.length > 5 ? ' is-long' : chromeMark.length <= 2 ? ' is-short' : ''}`}
            id="float-lens-mark"
          >
            {chromeMark}
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
                  {pairDials.map((dial) => (
                    <QuotaDial
                      key={dial.heroLabel}
                      size="pair"
                      weekly={dial.weekly}
                      fiveHour={dial.fiveHour}
                      heroPercent={dial.heroPercent}
                      heroLabel={dial.heroLabel}
                      emptyKind={null}
                      nest={product === 'antigravity'}
                      spinning={refreshing}
                    />
                  ))}
                </div>
              ) : (
                <QuotaDial
                  weekly={showOuter ? outerValue : null}
                  fiveHour={showInner ? innerValue : null}
                  heroPercent={hero.percent}
                  heroLabel={hero.label}
                  emptyKind={emptyKind}
                  spinning={refreshing}
                />
              )}

              <div className="float-lens-identity" title={viewed.email}>
                <div className="float-lens-name">
                  <span className="float-lens-name-local">{emailParts.local}</span>
                  {emailParts.domain ? (
                    <span className="float-lens-name-domain">{emailParts.domain}</span>
                  ) : null}
                </div>
                <div className="float-lens-meta">
                  {planBadge ? <div className="float-lens-plan">{planBadge}</div> : null}
                  {statusBadge ? <div className="float-lens-plan is-status">{statusBadge}</div> : null}
                  {caption ? <div className="float-lens-reset">{caption}</div> : null}
                </div>
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
                      <p>会关掉正在运行的官方 {officialClientLabel(product)}，再写入此账号。未保存的编辑可能会丢。</p>
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
                        if (isManagedProduct(product)) {
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
                          ? (viewed.status === 'BANNED' && !isManagedProductAccount(viewed) ? '账号已封号，无法切换' : '需重新授权后才能切换')
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
