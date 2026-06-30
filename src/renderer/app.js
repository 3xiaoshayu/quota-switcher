(() => {
  "use strict";

  const API = window.codexAccountManager || window.codexDeskep || null;
  const QUOTA_AUTO_SYNC_STALE_MS = 10 * 60 * 1000;
  const QUOTA_AUTO_SYNC_MIN_GAP_MS = 60 * 1000;
  let quotaAutoSyncPromise = null;
  let lastQuotaAutoSyncAt = 0;

  const state = {
    accounts: [],
    current: null,
    cfg: null,
    appInfo: null,
    codexStatus: null,
    updateStatus: null,
    daemonRunning: false,
    view: "accounts",
    search: "",
    filter: "all",
    loading: true,
    error: null,
    busy: new Set(),
  };

  function el(tag, props, ...children) {
    const element = document.createElement(tag);
    Object.entries(props || {}).forEach(([key, value]) => {
      if (value === null || value === undefined || value === false) return;
      if (key === "className") element.className = value;
      else if (key === "text") element.textContent = value;
      else if (key === "style") Object.assign(element.style, value);
      else if (key === "dataset") Object.assign(element.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in element && typeof value !== "string") {
        element[key] = value;
      } else {
        element.setAttribute(key, String(value));
      }
    });

    children.flat(Infinity).forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      element.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return element;
  }

  function icon(name, size = 18, className = "") {
    return el("i", { "data-lucide": name, "data-size": size, className });
  }

  function refreshIcons(root = document) {
    if (!window.lucide || typeof window.lucide.createIcons !== "function") return;
    window.lucide.createIcons({
      root,
      attrs: { width: 18, height: 18, "stroke-width": 1.8 },
    });
    root.querySelectorAll("svg[data-size]").forEach((svg) => {
      const size = svg.getAttribute("data-size");
      if (size) {
        svg.setAttribute("width", size);
        svg.setAttribute("height", size);
      }
    });
  }

  function expectData(response, label) {
    if (!response || response.success !== true) {
      throw new Error(response?.error || `${label}失败`);
    }
    return response.data;
  }

  function requireBridge() {
    const required = [
      "listAccounts",
      "getCurrentAccount",
      "getDaemonStatus",
      "getAutoSwitchConfig",
      "getAppInfo",
      "getCodexStatus",
      "getUpdateStatus",
    ];
    if (!API || required.some((name) => typeof API[name] !== "function")) {
      throw new Error("桌面桥接未加载。请通过 Electron 启动应用。");
    }
  }

  async function loadState(showLoading = false) {
    requireBridge();
    if (showLoading) {
      state.loading = true;
      renderApp();
    }

    const [accountsResponse, currentResponse, daemonResponse, configResponse] = await Promise.all([
      API.listAccounts(),
      API.getCurrentAccount(),
      API.getDaemonStatus(),
      API.getAutoSwitchConfig(),
    ]);

    state.accounts = expectData(accountsResponse, "读取账号") || [];
    state.current = expectData(currentResponse, "读取当前账号") || null;
    state.daemonRunning = !!expectData(daemonResponse, "读取守护状态")?.running;
    state.cfg = expectData(configResponse, "读取自动切号配置") || defaultConfig();
    state.loading = false;
    state.error = null;
  }

  async function loadStaticState() {
    requireBridge();
    const [appResponse, codexResponse, updateResponse] = await Promise.all([
      API.getAppInfo(),
      API.getCodexStatus(),
      API.getUpdateStatus(),
    ]);
    state.appInfo = expectData(appResponse, "读取应用信息") || null;
    state.codexStatus = expectData(codexResponse, "读取 Codex 安装状态") || null;
    state.updateStatus = expectData(updateResponse, "读取更新状态") || null;
  }

  function defaultConfig() {
    return {
      enabled: false,
      primary_threshold: 20,
      secondary_threshold: 30,
      account_scope_mode: "all",
      selected_account_ids: [],
    };
  }

  function clampPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.min(100, number));
  }

  function toDate(value) {
    if (!value) return null;
    const date = typeof value === "number"
      ? new Date(value < 1e12 ? value * 1000 : value)
      : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDateTime(value) {
    const date = toDate(value);
    if (!date) return "未知";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return "未知";
    if (value <= 0) return "已过期";
    if (value < 3600) return `${Math.max(1, Math.ceil(value / 60))} 分钟`;
    if (value < 86400) return `${Math.floor(value / 3600)} 小时 ${Math.ceil((value % 3600) / 60)} 分钟`;
    return `${Math.floor(value / 86400)} 天 ${Math.floor((value % 86400) / 3600)} 小时`;
  }

  function formatResetTime(value) {
    const date = toDate(value);
    if (!date) return "";
    const seconds = Math.floor((date.getTime() - Date.now()) / 1000);
    return `重置：${formatDuration(seconds)} · ${formatDateTime(value)}`;
  }

  function planLabel(account) {
    return String(account.plan_type || "unknown").replaceAll("_", " ").toUpperCase();
  }

  function quotaTone(percentage) {
    if (percentage === null) return "unknown";
    if (percentage > 50) return "high";
    if (percentage > 20) return "medium";
    return "low";
  }

  function tokenPresentation(account) {
    if (account.requires_reauth) {
      return { tone: "danger", label: "需要重新授权" };
    }
    const token = account.token_status || {};
    if (!token.accessAvailable) {
      return { tone: "danger", label: "缺少访问 Token" };
    }
    if (token.expired) {
      return { tone: "danger", label: "Token 已过期" };
    }
    if (Number(token.timeLeft) < 600) {
      return { tone: "warning", label: `Token 将在 ${formatDuration(token.timeLeft)}后过期` };
    }
    return { tone: "success", label: `Token 剩余 ${formatDuration(token.timeLeft)}` };
  }

  function isAttention(account) {
    if (account.requires_reauth || account.quota_error || account.token_status?.expired) return true;
    const quota = account.quota;
    if (!quota) return false;
    const primaryThreshold = Number(state.cfg?.primary_threshold ?? 20);
    const secondaryThreshold = Number(state.cfg?.secondary_threshold ?? 30);
    const hourly = clampPercent(quota.hourly_percentage);
    const weekly = clampPercent(quota.weekly_percentage);
    return (quota.hourly_window_present !== false && hourly !== null && hourly <= primaryThreshold)
      || (quota.weekly_window_present && weekly !== null && weekly <= secondaryThreshold);
  }

  function quotaItems(account) {
    const quota = account.quota || null;
    const hourly = quota ? clampPercent(quota.hourly_percentage) : null;
    const weekly = quota ? clampPercent(quota.weekly_percentage) : null;
    const hourlyKnown = !!quota && quota.hourly_window_present !== false && hourly !== null;
    const weeklyKnown = !!quota && quota.weekly_window_present !== false && weekly !== null;
    const minutes = Number(quota?.hourly_window_minutes);
    const hourlyLabel = Number.isFinite(minutes)
      ? (minutes >= 60 ? `${Math.round(minutes / 60)} 小时额度` : `${minutes} 分钟额度`)
      : "5 小时额度";
    const missingNote = quota ? "接口未返回" : "等待同步";

    return [
      {
        key: "hourly",
        label: hourlyLabel,
        percentage: hourlyKnown ? hourly : null,
        reset: hourlyKnown ? quota.hourly_reset_time : null,
        icon: "clock-3",
        note: hourlyKnown ? null : missingNote,
      },
      {
        key: "weekly",
        label: "周额度",
        percentage: weeklyKnown ? weekly : null,
        reset: weeklyKnown ? quota.weekly_reset_time : null,
        icon: "calendar-days",
        note: weeklyKnown ? null : missingNote,
      },
    ];
  }

  function accountHasQuotaData(account) {
    return quotaItems(account).some((item) => item.percentage !== null);
  }

  function showToast(message, tone = "info") {
    const root = document.getElementById("toast-root");
    if (!root) return;
    const iconName = tone === "success" ? "check-circle-2"
      : tone === "error" ? "circle-alert"
        : tone === "warning" ? "triangle-alert" : "info";
    const toast = el("div", { className: `toast ${tone}` }, icon(iconName, 17), el("span", { text: message }));
    root.appendChild(toast);
    refreshIcons(toast);
    window.setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px)";
      toast.style.transition = "opacity 160ms ease, transform 160ms ease";
      window.setTimeout(() => toast.remove(), 180);
    }, 3200);
  }

  function navigate(view) {
    state.view = view;
    renderApp();
  }

  function actionButton(iconName, title, onClick, options = {}) {
    return el("button", {
      type: "button",
      className: `card-action ${options.variant || ""}`.trim(),
      title,
      "aria-label": title,
      "aria-busy": options.spinning ? "true" : null,
      disabled: !!options.disabled,
      onClick: (event) => {
        event.stopPropagation();
        onClick(event);
      },
    }, icon(iconName, 16, options.spinning ? "spin" : ""));
  }

  async function runBusy(key, action, successMessage) {
    if (state.busy.has(key)) return;
    state.busy.add(key);
    renderApp();
    try {
      await action();
      if (successMessage) showToast(successMessage, "success");
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      state.busy.delete(key);
      renderApp();
    }
  }

  function renderWindowBar() {
    const appName = state.appInfo?.name || "Codex Account Manager";
    return el("header", { className: "window-bar" },
      el("div", { className: "window-brand" },
        el("span", { className: "window-brand-mark" }, icon("terminal", 13)),
        el("span", { text: appName }),
      ),
      el("div", { className: "window-controls" },
        el("button", {
          type: "button", className: "window-control", title: "最小化", "aria-label": "最小化",
          onClick: () => API?.minimizeWindow?.(),
        }, icon("minus", 15)),
        el("button", {
          type: "button", className: "window-control", title: "最大化或还原", "aria-label": "最大化或还原",
          onClick: () => API?.toggleMaximize?.(),
        }, icon("square", 12)),
        el("button", {
          type: "button", className: "window-control close", title: "关闭", "aria-label": "关闭",
          onClick: () => API?.closeWindow?.(),
        }, icon("x", 16)),
      ),
    );
  }

  function navButton(view, iconName, label) {
    const active = state.view === view;
    return el("button", {
      type: "button",
      className: `nav-button ${active ? "active" : ""}`,
      "aria-current": active ? "page" : null,
      onClick: () => navigate(view),
    }, icon(iconName, 17), el("span", { text: label }));
  }

  function renderAppHeader() {
    const currentEmail = state.current?.email || "未选择账号";
    return el("header", { className: "app-header" },
      el("div", { className: "header-inner" },
        el("button", { type: "button", className: "brand-button", "aria-label": "返回账号列表", onClick: () => navigate("accounts") },
          el("span", { className: "brand-mark" }, icon("terminal-square", 20)),
          el("span", { className: "brand-copy" },
            el("span", { className: "brand-title", text: "Codex 账号" }),
            el("span", { className: "brand-status" },
              el("span", { className: `status-dot ${state.current ? "success" : "warning"}` }),
              el("span", { text: currentEmail }),
            ),
          ),
        ),
        el("nav", { className: "primary-nav", "aria-label": "主要导航" },
          navButton("accounts", "users", "账号"),
          navButton("quota", "gauge", "配额"),
          navButton("autoswitch", "refresh-cw", "自动"),
          navButton("settings", "settings", "设置"),
        ),
        el("div", { className: "header-actions" },
          el("span", { className: "daemon-chip" },
            el("span", { className: `status-dot ${state.daemonRunning ? "success" : "warning"}` }),
            el("span", { text: state.daemonRunning ? "守护运行中" : "守护已停止" }),
          ),
        ),
      ),
    );
  }

  function renderLoadingView() {
    return el("main", { className: "workspace" },
      el("section", { className: "view" },
        el("div", { className: "view-heading" },
          el("div", null, el("h1", { text: "账号管理" }), el("p", { className: "view-meta", text: "正在读取本地数据" })),
        ),
        el("div", { className: "account-grid" },
          el("div", { className: "skeleton-card" }),
          el("div", { className: "skeleton-card" }),
          el("div", { className: "skeleton-card" }),
          el("div", { className: "skeleton-card" }),
        ),
      ),
    );
  }

  function renderFatalState() {
    return el("main", { className: "workspace" },
      el("section", { className: "view" },
        el("div", { className: "fatal-state" },
          el("span", { className: "fatal-state-icon" }, icon("circle-alert", 25)),
          el("h2", { text: "应用未能初始化" }),
          el("p", { text: state.error || "未知错误" }),
          el("button", {
            type: "button", className: "button primary", onClick: retryLoad,
          }, icon("rotate-cw", 17), "重试"),
        ),
      ),
    );
  }

  function renderApp() {
    const root = document.getElementById("app");
    if (!root) return;
    const surface = el("div", { className: "app-surface" }, renderAppHeader());
    if (state.loading) surface.appendChild(renderLoadingView());
    else if (state.error) surface.appendChild(renderFatalState());
    else surface.appendChild(renderCurrentView());
    root.replaceChildren(renderWindowBar(), surface);
    refreshIcons(root);
  }

  function renderCurrentView() {
    if (state.view === "quota") return renderQuotaView();
    if (state.view === "autoswitch") return renderAutoSwitchView();
    if (state.view === "settings") return renderSettingsView();
    return renderAccountsView();
  }

  function viewHeading(title, meta, actions = [], count = null) {
    return el("div", { className: "view-heading" },
      el("div", null,
        el("div", { className: "view-title-row" },
          el("h1", { text: title }),
          count === null ? null : el("span", { className: "count-badge", text: count }),
        ),
        el("p", { className: "view-meta", text: meta }),
      ),
      actions.length ? el("div", { className: "header-actions", style: { display: "flex" } }, actions) : null,
    );
  }

  function filteredAccounts() {
    const query = state.search.trim().toLowerCase();
    return state.accounts
      .filter((account) => !query || account.email.toLowerCase().includes(query) || planLabel(account).toLowerCase().includes(query))
      .filter((account) => {
        if (state.filter === "current") return account.id === state.current?.id;
        if (state.filter === "attention") return isAttention(account);
        return true;
      })
      .sort((a, b) => {
        const currentA = a.id === state.current?.id ? 1 : 0;
        const currentB = b.id === state.current?.id ? 1 : 0;
        if (currentA !== currentB) return currentB - currentA;
        return Number(b.last_used || b.created_at || 0) - Number(a.last_used || a.created_at || 0);
      });
  }

  function renderAccountsView() {
    const refreshButton = el("button", {
      type: "button", className: "icon-button", title: "重新读取本地账号", "aria-label": "重新读取本地账号",
      "aria-busy": state.busy.has("reload") ? "true" : null,
      disabled: state.busy.has("reload"), onClick: () => reloadLocalData(),
    }, icon("rotate-cw", 17, state.busy.has("reload") ? "spin" : ""));
    const addButton = el("button", {
      type: "button", className: "button primary", "aria-busy": state.busy.has("add") ? "true" : null,
      disabled: state.busy.has("add"), onClick: addAccount,
    }, icon(state.busy.has("add") ? "loader-circle" : "plus", 17, state.busy.has("add") ? "spin" : ""), el("span", { text: "添加账号" }));

    const search = el("input", {
      type: "search", value: state.search, placeholder: "搜索账号", "aria-label": "搜索账号",
      onInput: (event) => {
        state.search = event.target.value;
        renderAccountResults();
      },
    });
    const filter = el("select", {
      className: "select-control", "aria-label": "账号筛选", value: state.filter,
      onChange: (event) => {
        state.filter = event.target.value;
        renderAccountResults();
      },
    },
      el("option", { value: "all", text: "全部账号" }),
      el("option", { value: "current", text: "当前账号" }),
      el("option", { value: "attention", text: "需要处理" }),
    );
    filter.value = state.filter;

    const view = el("section", { className: "view" },
      viewHeading("账号管理", `当前 ${state.current ? planLabel(state.current) : "未选择"}`, [refreshButton, addButton], state.accounts.length),
      el("div", { className: "toolbar" },
        el("label", { className: "search-control" }, icon("search", 16), search),
        filter,
      ),
      el("div", { id: "account-results" }),
    );
    renderAccountResults(view.querySelector("#account-results"));
    return el("main", { className: "workspace" }, view);
  }

  function renderAccountResults(target = document.getElementById("account-results")) {
    if (!target) return;
    const accounts = filteredAccounts();
    if (!accounts.length) {
      target.replaceChildren(el("div", { className: "empty-state" },
        el("span", { className: "empty-state-icon" }, icon("user-round-x", 25)),
        el("h2", { text: state.accounts.length ? "没有匹配的账号" : "暂无账号" }),
      ));
    } else {
      target.replaceChildren(el("div", { className: "account-grid" }, accounts.map(renderAccountCard)));
    }
    refreshIcons(target);
  }

  function renderAccountCard(account) {
    const current = account.id === state.current?.id;
    const token = tokenPresentation(account);
    const attention = isAttention(account);
    const quotaBusy = state.busy.has(`quota:${account.id}`);
    const tokenBusy = state.busy.has(`token:${account.id}`);
    const switchBusy = state.busy.has(`switch:${account.id}`);
    const deleteBusy = state.busy.has(`delete:${account.id}`);
    const resetConsumeBusy = state.busy.has(`reset:consume:${account.id}`);
    const accountBusy = quotaBusy || tokenBusy || switchBusy || deleteBusy || resetConsumeBusy;
    const items = quotaItems(account);
    const creditCount = Number(account.reset_credits?.available_count || account.quota?.reset_credits_available || 0);

    const quotaStack = el("div", { className: "quota-stack" });
    if (account.quota_error) {
      quotaStack.appendChild(el("div", { className: "inline-error", title: account.quota_error.message || "" },
        icon("circle-alert", 16), el("span", { text: account.quota_error.code || "配额读取失败" }),
      ));
    }
    if (items.length) items.forEach((item) => quotaStack.appendChild(renderQuotaItem(item)));
    else if (!account.quota_error) {
      quotaStack.appendChild(el("div", { className: "quota-empty" }, icon("activity", 17), el("span", { text: "尚无配额数据" })));
    }

    const card = el("article", {
      className: `account-card ${current ? "current" : ""} ${attention ? "attention" : ""}`.trim(),
      "aria-label": `账号 ${account.email}`,
      "aria-busy": accountBusy ? "true" : null,
    },
      el("div", { className: "card-header" },
        el("span", { className: "account-avatar" }, icon("terminal", 20)),
        el("div", { className: "account-title" },
          el("span", { className: "account-email", title: account.email, text: account.email }),
          el("span", { className: "account-subtitle" },
            el("span", { className: `status-dot ${token.tone}` }),
            el("span", { text: `第 ${account.token_generation || 0} 代凭据` }),
          ),
        ),
        el("div", { className: "card-badges" },
          current ? el("span", { className: "current-badge", text: "当前" }) : null,
          attention && !current ? el("span", { className: "state-badge", text: "注意" }) : null,
          el("span", { className: "plan-badge", text: planLabel(account) }),
        ),
      ),
      el("div", { className: "token-line", title: token.label },
        icon("key-round", 14),
        el("span", { className: "token-copy", text: token.label }),
        creditCount > 0 ? el("span", { className: "reset-credit", text: `${creditCount} 次重置` }) : null,
      ),
      quotaStack,
      account.subscription_active_until ? el("div", { className: "subscription-line" },
        icon("shield-check", 14),
        el("span", { className: "subscription-copy", text: `订阅有效期 ${formatDateTime(account.subscription_active_until)}` }),
      ) : null,
      el("footer", { className: "card-footer" },
        el("span", { className: "card-time", text: account.usage_updated_at ? `配额更新 ${formatDateTime(account.usage_updated_at)}` : `最近使用 ${formatDateTime(account.last_used || account.created_at)}` }),
        el("div", { className: "card-actions" },
          creditCount > 0
            ? actionButton(resetConsumeBusy ? "loader-circle" : "ticket-check", "消耗重置额度", () => consumeResetCredit(account), { disabled: resetConsumeBusy, spinning: resetConsumeBusy })
            : null,
          actionButton(quotaBusy ? "loader-circle" : "gauge", "刷新配额", () => refreshQuota(account), { disabled: quotaBusy, spinning: quotaBusy }),
          actionButton(tokenBusy ? "loader-circle" : "key-round", "检查登录", () => refreshToken(account), { disabled: tokenBusy, spinning: tokenBusy }),
          actionButton(switchBusy ? "loader-circle" : (current ? "check" : "play"), current ? "当前账号" : "切换账号", () => switchAccount(account), {
            variant: current ? "current" : "switch", disabled: current || switchBusy, spinning: switchBusy,
          }),
          actionButton(deleteBusy ? "loader-circle" : "trash-2", "删除账号", () => deleteAccount(account), {
            variant: "danger", disabled: deleteBusy, spinning: deleteBusy,
          }),
        ),
      ),
    );
    return card;
  }

  function renderQuotaItem(item) {
    const tone = quotaTone(item.percentage);
    const known = item.percentage !== null;
    return el("div", { className: `quota-item ${known ? "" : "pending"}`.trim() },
      el("div", { className: "quota-head" },
        icon(item.icon, 14),
        el("span", { className: "quota-label", text: item.label }),
        el("span", { className: `quota-value ${tone}`, text: known ? `${Math.round(item.percentage)}%` : "--" }),
      ),
      el("div", { className: "quota-track" },
        el("div", { className: `quota-fill ${tone}`, style: { width: known ? `${item.percentage}%` : "0%" } }),
      ),
      item.reset || item.note ? el("span", { className: "quota-reset", text: item.reset ? formatResetTime(item.reset) : item.note }) : null,
    );
  }

  function needsQuotaAutoSync(account) {
    if (!account || state.busy.has(`quota:${account.id}`)) return false;
    if (account.requires_reauth || account.token_status?.accessAvailable === false || account.token_status?.expired) return false;
    if (!account.quota || account.quota_error || !accountHasQuotaData(account)) return true;
    const updatedAt = toDate(account.usage_updated_at)?.getTime() || 0;
    return !updatedAt || Date.now() - updatedAt > QUOTA_AUTO_SYNC_STALE_MS;
  }

  function queueQuotaAutoSync() {
    if (!API || state.loading || quotaAutoSyncPromise) return quotaAutoSyncPromise;
    if (Date.now() - lastQuotaAutoSyncAt < QUOTA_AUTO_SYNC_MIN_GAP_MS) return null;
    const accounts = state.accounts.filter(needsQuotaAutoSync);
    if (!accounts.length) return null;

    lastQuotaAutoSyncAt = Date.now();
    quotaAutoSyncPromise = syncQuotasInBackground(accounts).finally(() => {
      quotaAutoSyncPromise = null;
    });
    return quotaAutoSyncPromise;
  }

  async function syncQuotasInBackground(accounts) {
    accounts.forEach((account) => state.busy.add(`quota:${account.id}`));
    renderApp();
    const failed = [];
    for (const account of accounts) {
      try {
        expectData(await API.refreshQuota(account.id), "自动同步配额");
      } catch (error) {
        failed.push(error);
      } finally {
        state.busy.delete(`quota:${account.id}`);
      }
    }

    try {
      await loadState(false);
    } catch (error) {
      failed.push(error);
    }
    renderApp();

    if (failed.length && failed.length === accounts.length) {
      showToast("自动同步配额失败，可稍后手动刷新", "warning");
    }
  }

  async function reloadLocalData() {
    await runBusy("reload", async () => {
      await loadState(false);
      queueQuotaAutoSync();
    }, "本地数据已更新");
  }

  async function addAccount() {
    showToast("正在打开 OAuth 登录", "info");
    await runBusy("add", async () => {
      const account = expectData(await API.addAccount(), "添加账号");
      await loadState(false);
      queueQuotaAutoSync();
      showToast(`已添加 ${account.email}`, "success");
    });
  }

  async function switchAccount(account) {
    await runBusy(`switch:${account.id}`, async () => {
      expectData(await API.switchAccount(account.id), "切换账号");
      await loadState(false);
      queueQuotaAutoSync();
    }, `已切换到 ${account.email}`);
  }

  async function refreshQuota(account) {
    await runBusy(`quota:${account.id}`, async () => {
      expectData(await API.refreshQuota(account.id), "刷新配额");
      await loadState(false);
    }, `${account.email} 配额已更新`);
  }

  async function refreshToken(account) {
    await runBusy(`token:${account.id}`, async () => {
      const result = expectData(await API.refreshToken(account.id), "检查登录");
      if (!result?.ok) throw new Error(result?.error || "Token 刷新失败");
      await loadState(false);
      showToast(result.skipped ? `${account.email} 登录仍有效` : `${account.email} 登录已续期`, "success");
    });
  }

  async function deleteAccount(account) {
    const confirmed = await showConfirm({
      title: "删除账号",
      message: `确定删除 ${account.email}？此操作无法撤销。`,
      confirmLabel: "删除",
      destructive: true,
    });
    if (!confirmed) return;
    await runBusy(`delete:${account.id}`, async () => {
      expectData(await API.deleteAccount(account.id), "删除账号");
      await loadState(false);
    }, `已删除 ${account.email}`);
  }

  function renderQuotaView() {
    const withQuota = state.accounts.filter(accountHasQuotaData);
    const attention = state.accounts.filter(isAttention).length;
    const percentages = state.accounts.flatMap((account) => quotaItems(account)
      .filter((item) => item.percentage !== null)
      .map((item) => item.percentage));
    const average = percentages.length
      ? Math.round(percentages.reduce((sum, value) => sum + value, 0) / percentages.length)
      : null;
    const busy = state.busy.has("quota:all");
    const refreshButton = el("button", {
      type: "button", className: "button primary", "aria-busy": busy ? "true" : null,
      disabled: busy || !state.accounts.length, onClick: refreshAllQuotas,
    }, icon(busy ? "loader-circle" : "refresh-cw", 17, busy ? "spin" : ""), el("span", { text: "刷新全部" }));

    return el("main", { className: "workspace" },
      el("section", { className: "view" },
        viewHeading("配额总览", `已同步 ${withQuota.length}/${state.accounts.length}`, [refreshButton]),
        el("div", { className: "summary-band" },
          summaryItem("账号", state.accounts.length, ""),
          summaryItem("需要处理", attention, attention ? "warning" : "success"),
          summaryItem("平均剩余", average === null ? "--" : `${average}%`, average !== null && average > 30 ? "success" : "warning"),
        ),
        state.accounts.length
          ? el("div", { className: "account-grid" }, state.accounts.map(renderAccountCard))
          : el("div", { className: "empty-state" }, el("span", { className: "empty-state-icon" }, icon("gauge", 25)), el("h2", { text: "暂无配额数据" })),
      ),
    );
  }

  function summaryItem(label, value, tone) {
    return el("div", { className: "summary-item" },
      el("span", { className: "summary-label", text: label }),
      el("span", { className: `summary-value ${tone}`.trim(), text: value }),
    );
  }

  async function refreshAllQuotas() {
    await runBusy("quota:all", async () => {
      const results = expectData(await API.refreshAllQuotas(), "刷新全部配额") || [];
      await loadState(false);
      const failed = results.filter((item) => item.error).length;
      if (failed) showToast(`${results.length - failed} 个成功，${failed} 个失败`, "warning");
      else showToast(`${results.length} 个账号配额已更新`, "success");
    });
  }

  function renderAutoSwitchView() {
    const cfg = state.cfg || defaultConfig();
    const runBusyState = state.busy.has("autoswitch:tick");
    const runButton = el("button", {
      type: "button", className: "button primary", "aria-busy": runBusyState ? "true" : null,
      disabled: runBusyState || !state.accounts.length, onClick: runAutoSwitch,
    }, icon(runBusyState ? "loader-circle" : "play", 17, runBusyState ? "spin" : ""), el("span", { text: "立即检查" }));

    return el("main", { className: "workspace" },
      el("section", { className: "view" },
        viewHeading("自动切号", cfg.enabled ? "已启用" : "已停用", [runButton]),
        el("div", { className: "settings-grid" },
          el("section", { className: "setting-panel" },
            el("h2", { className: "panel-title" }, icon("power", 17), "状态"),
            el("div", { className: "setting-row" },
              el("span", { className: "setting-label", text: "自动切号" }),
              el("button", {
                type: "button", className: `toggle ${cfg.enabled ? "on" : ""}`, role: "switch",
                "aria-checked": cfg.enabled ? "true" : "false",
                "aria-label": "自动切号", onClick: () => updateConfig({ enabled: !cfg.enabled }),
              }),
            ),
            el("div", { className: "setting-row" },
              el("span", { className: "setting-label", text: "守护进程" }),
              el("span", { className: "setting-value", text: state.daemonRunning ? "运行中" : "已停止" }),
            ),
          ),
          el("section", { className: "setting-panel" },
            el("h2", { className: "panel-title" }, icon("gauge", 17), "切换阈值"),
            thresholdControl("5 小时配额", "primary_threshold", cfg.primary_threshold, "clock-3"),
            thresholdControl("周配额", "secondary_threshold", cfg.secondary_threshold, "calendar-days"),
          ),
          el("section", { className: "setting-panel full" },
            el("h2", { className: "panel-title" }, icon("list-filter", 17), "账号范围"),
            el("div", { className: "segmented" },
              segmentButton("全部账号", cfg.account_scope_mode !== "selected", () => updateConfig({ account_scope_mode: "all" })),
              segmentButton("指定账号", cfg.account_scope_mode === "selected", () => updateConfig({ account_scope_mode: "selected" })),
            ),
            cfg.account_scope_mode === "selected" ? renderAccountPicker(cfg) : null,
          ),
        ),
      ),
    );
  }

  function thresholdControl(label, key, value, iconName) {
    const output = el("span", { className: "threshold-output", text: `${value}%` });
    const input = el("input", {
      type: "range", min: 1, max: 100, step: 1, value, "aria-label": label,
      onInput: (event) => {
        const number = Number(event.target.value);
        state.cfg[key] = number;
        output.textContent = `${number}%`;
      },
      onChange: () => persistConfig(),
    });
    return el("div", { className: "threshold-control" },
      el("div", { className: "threshold-head" },
        el("span", { className: "threshold-label" }, icon(iconName, 15), label),
        output,
      ),
      input,
    );
  }

  function segmentButton(label, active, onClick) {
    return el("button", {
      type: "button", className: `segment-button ${active ? "active" : ""}`,
      "aria-pressed": active ? "true" : "false", onClick, text: label,
    });
  }

  function renderAccountPicker(cfg) {
    const selected = new Set(cfg.selected_account_ids || []);
    return el("div", { className: "account-picker" }, state.accounts.map((account) =>
      el("label", { className: "picker-row" },
        el("input", {
          type: "checkbox", checked: selected.has(account.id),
          onChange: (event) => {
            if (event.target.checked) selected.add(account.id);
            else selected.delete(account.id);
            state.cfg.selected_account_ids = Array.from(selected);
            persistConfig();
          },
        }),
        el("span", { className: "picker-email", text: account.email }),
        account.id === state.current?.id ? el("span", { className: "current-badge", text: "当前" }) : null,
      ),
    ));
  }

  async function updateConfig(patch) {
    Object.assign(state.cfg, patch);
    renderApp();
    await persistConfig();
  }

  async function persistConfig() {
    try {
      expectData(await API.saveAutoSwitchConfig(state.cfg), "保存自动切号配置");
    } catch (error) {
      showToast(error.message, "error");
      try {
        state.cfg = expectData(await API.getAutoSwitchConfig(), "重新读取配置") || defaultConfig();
      } catch {}
      renderApp();
    }
  }

  function autoSwitchReason(reason) {
    const labels = {
      no_accounts: "没有可用账号",
      no_monitored: "未选择监控账号",
      current_not_monitored: "当前账号不在监控范围",
      current_not_found: "未找到当前账号",
      no_quota_data: "当前账号无配额数据",
      quota_sufficient: "当前配额充足",
      no_candidates: "没有合适的候选账号",
      no_best_candidate: "无法选择候选账号",
    };
    return labels[reason] || reason || "无需切换";
  }

  async function runAutoSwitch() {
    await runBusy("autoswitch:tick", async () => {
      const result = expectData(await API.runAutoSwitchTick(), "自动切号检查");
      await loadState(false);
      if (result?.switched) showToast(`已切换到 ${result.to?.email || "新账号"}`, "success");
      else showToast(autoSwitchReason(result?.reason), "info");
    });
  }

  function renderSettingsView() {
    const tokenBusy = state.busy.has("token:all");
    const daemonBusy = state.busy.has("daemon");
    const codexBusy = state.busy.has("codex:status");
    const updateBusy = state.busy.has("update:check") || state.updateStatus?.status === "checking" || state.updateStatus?.status === "downloading";
    const installBusy = state.busy.has("update:install");
    const appInfo = state.appInfo || {};
    const updateStatus = state.updateStatus || {};
    const codexStatus = state.codexStatus || {};
    const appName = appInfo.name || "Codex Account Manager";
    const version = appInfo.version || "0.1.0-beta.1";
    return el("main", { className: "workspace" },
      el("section", { className: "view" },
        viewHeading("设置", `${releaseChannelLabel(appInfo.releaseChannel)} · ${state.accounts.length} 个账号`),
        el("div", { className: "settings-grid" },
          el("section", { className: "setting-panel" },
            el("h2", { className: "panel-title" }, icon("power", 17), "守护进程"),
            el("div", { className: "setting-row" },
              el("span", { className: "setting-label", text: "运行状态" }),
              el("button", {
                type: "button", className: `toggle ${state.daemonRunning ? "on" : ""} ${daemonBusy ? "busy" : ""}`.trim(), role: "switch",
                "aria-checked": state.daemonRunning ? "true" : "false", "aria-label": "守护进程", onClick: toggleDaemon,
                "aria-busy": daemonBusy ? "true" : null, disabled: daemonBusy,
              }),
            ),
            el("div", { className: "setting-row" },
              el("span", { className: "setting-label", text: "检查间隔" }),
              el("span", { className: "setting-value", text: "10 分钟" }),
            ),
          ),
          el("section", { className: "setting-panel" },
            el("h2", { className: "panel-title" }, icon("key-round", 17), "Token"),
            el("div", { className: "setting-row" },
              el("span", { className: "setting-label", text: "全部账号" }),
              el("button", {
                type: "button", className: "button secondary", "aria-busy": tokenBusy ? "true" : null,
                disabled: tokenBusy || !state.accounts.length, onClick: refreshAllTokens,
              }, icon(tokenBusy ? "loader-circle" : "refresh-cw", 16, tokenBusy ? "spin" : ""), "刷新"),
            ),
          ),
          el("section", { className: "setting-panel" },
            el("h2", { className: "panel-title" }, icon("badge-check", 17), "Codex 客户端"),
            settingRow("来源要求", "Microsoft Store 官方版"),
            el("div", { className: "setting-row" },
              el("span", { className: "setting-label", text: "检测状态" }),
              el("span", { className: `setting-value ${codexStatus.installed ? "success" : "danger"}`, text: codexStatusLabel(codexStatus) }),
            ),
            el("div", { className: "setting-row" },
              el("span", { className: "setting-label", text: codexStatus.appId || "AppID" }),
              el("button", {
                type: "button", className: "button secondary", disabled: codexBusy,
                "aria-busy": codexBusy ? "true" : null, onClick: refreshCodexStatus,
              }, icon(codexBusy ? "loader-circle" : "scan-search", 16, codexBusy ? "spin" : ""), "重新检测"),
            ),
          ),
          el("section", { className: "setting-panel" },
            el("h2", { className: "panel-title" }, icon("download-cloud", 17), "更新"),
            settingRow("发布通道", releaseChannelLabel(appInfo.releaseChannel)),
            el("div", { className: "setting-row" },
              el("span", { className: "setting-label", text: "状态" }),
              el("span", { className: `setting-value ${updateStatusTone(updateStatus)}`, text: updateStatusLabel(updateStatus) }),
            ),
            el("div", { className: "setting-row" },
              el("span", { className: "setting-label", text: updateStatus.percent === null || updateStatus.percent === undefined ? "安装包" : `下载 ${updateStatus.percent}%` }),
              updateStatus.status === "downloaded"
                ? el("button", {
                  type: "button", className: "button primary", disabled: installBusy,
                  "aria-busy": installBusy ? "true" : null, onClick: installUpdate,
                }, icon(installBusy ? "loader-circle" : "refresh-cw", 16, installBusy ? "spin" : ""), "重启安装")
                : el("button", {
                  type: "button", className: "button secondary", disabled: updateBusy || !updateStatus.enabled,
                  "aria-busy": updateBusy ? "true" : null, onClick: checkForUpdates,
                }, icon(updateBusy ? "loader-circle" : "refresh-cw", 16, updateBusy ? "spin" : ""), updateStatus.enabled ? "检查更新" : "手动更新"),
            ),
          ),
          el("section", { className: "setting-panel full" },
            el("h2", { className: "panel-title" }, icon("info", 17), "关于"),
            settingRow("应用", appName),
            settingRow("版本", version),
            settingRow("引擎", "codex-switch v4.0"),
            settingRow("仓库", appInfo.repository || "https://github.com/3xiaoshayu/codex-account-manager"),
          ),
        ),
      ),
    );
  }

  function releaseChannelLabel(channel) {
    return channel === "stable" ? "Stable 正式版" : "Beta 预览版";
  }

  function codexStatusLabel(status) {
    if (status?.installed) return status.name ? `已检测到 ${status.name}` : "已检测到";
    if (status?.reason === "windows-only") return "仅支持 Windows";
    if (status?.reason === "detection-failed") return "检测失败";
    return "未检测到";
  }

  function updateStatusLabel(status) {
    if (!status) return "未知";
    if (status.message) return status.message;
    const labels = {
      idle: "可检查更新",
      disabled: "Beta 阶段手动更新",
      checking: "正在检查更新",
      available: "发现新版本",
      downloading: "正在下载更新",
      downloaded: "更新已下载",
      "not-available": "当前已是最新版本",
      error: "检查更新失败",
    };
    return labels[status.status] || "未知";
  }

  function updateStatusTone(status) {
    if (status?.status === "error") return "danger";
    if (status?.status === "downloaded" || status?.status === "not-available") return "success";
    return "";
  }

  function settingRow(label, value) {
    return el("div", { className: "setting-row" },
      el("span", { className: "setting-label", text: label }),
      el("span", { className: "setting-value", text: value }),
    );
  }

  async function toggleDaemon() {
    const starting = !state.daemonRunning;
    await runBusy("daemon", async () => {
      const response = state.daemonRunning ? await API.stopDaemon() : await API.startDaemon();
      expectData(response, state.daemonRunning ? "停止守护进程" : "启动守护进程");
      await loadState(false);
    }, starting ? "守护进程已启动" : "守护进程已停止");
  }

  async function refreshAllTokens() {
    await runBusy("token:all", async () => {
      const result = expectData(await API.refreshAllTokens(false), "检查全部登录");
      await loadState(false);
      showToast(`${result.okCount || 0} 正常，${result.revivedCount || 0} 恢复，${result.deadCount || 0} 失效`, result.deadCount ? "warning" : "success");
    });
  }

  async function refreshCodexStatus() {
    await runBusy("codex:status", async () => {
      state.codexStatus = expectData(await API.getCodexStatus(), "检测 Codex 客户端");
    }, state.codexStatus?.installed ? "Codex 客户端检测完成" : "检测完成");
  }

  async function checkForUpdates() {
    await runBusy("update:check", async () => {
      const status = expectData(await API.checkForUpdates(), "检查更新");
      if (status) state.updateStatus = status;
      if (!status?.enabled) showToast(status?.message || "Beta 阶段使用 Releases 手动更新", "info");
    });
  }

  async function installUpdate() {
    await runBusy("update:install", async () => {
      const status = expectData(await API.installUpdate(), "安装更新");
      if (status) state.updateStatus = status;
    });
  }

  async function consumeResetCredit(account) {
    const confirmed = await showConfirm({
      title: "消耗重置额度",
      message: `确定为 ${account.email} 消耗 1 次重置额度？此操作会立即生效且无法撤销。`,
      confirmLabel: "确认消耗",
      destructive: true,
    });
    if (!confirmed) return;
    await runBusy(`reset:consume:${account.id}`, async () => {
      expectData(await API.consumeResetCredit(account.id), "消耗重置额度");
      await loadState(false);
    }, `${account.email} 已消耗 1 次重置额度`);
  }

  function showConfirm({ title, message, confirmLabel, destructive = false }) {
    return new Promise((resolve) => {
      const root = document.getElementById("dialog-root");
      const onKeydown = (event) => {
        if (event.key === "Escape") close(false);
      };
      const close = (result) => {
        document.removeEventListener("keydown", onKeydown);
        root.replaceChildren();
        resolve(result);
      };
      const dialog = el("div", { className: "dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
        el("div", { className: "dialog-header" },
          el("h2", { text: title }),
          el("button", { type: "button", className: "icon-button", title: "关闭", "aria-label": "关闭", onClick: () => close(false) }, icon("x", 17)),
        ),
        el("p", { text: message }),
        el("div", { className: "dialog-actions" },
          el("button", { type: "button", className: "button secondary", onClick: () => close(false), text: "取消" }),
          el("button", { type: "button", className: `button ${destructive ? "danger" : "primary"}`, onClick: () => close(true), text: confirmLabel }),
        ),
      );
      const backdrop = el("div", {
        className: "dialog-backdrop",
        onClick: (event) => { if (event.target === backdrop) close(false); },
      }, dialog);
      root.replaceChildren(backdrop);
      refreshIcons(root);
      document.addEventListener("keydown", onKeydown);
      dialog.querySelector("button")?.focus();
    });
  }

  async function retryLoad() {
    state.error = null;
    state.loading = true;
    renderApp();
    try {
      await Promise.all([loadState(false), loadStaticState()]);
      queueQuotaAutoSync();
    } catch (error) {
      state.error = error.message || String(error);
      state.loading = false;
    }
    renderApp();
  }

  function subscribeToMainEvents() {
    if (!API) return;
    API.onDaemonTick?.(() => {
      loadState(false)
        .then(() => {
          renderApp();
          queueQuotaAutoSync();
        })
        .catch((error) => showToast(error.message, "error"));
    });
    API.onDaemonError?.((payload) => showToast(payload?.message || "守护进程错误", "error"));
    API.onAutoSwitch?.((payload) => {
      if (payload?.switched) showToast(`自动切换到 ${payload.to?.email || "新账号"}`, "warning");
      loadState(false)
        .then(() => {
          renderApp();
          queueQuotaAutoSync();
        })
        .catch(() => {});
    });
    API.onUpdateStatus?.((payload) => {
      state.updateStatus = payload || state.updateStatus;
      if (payload?.status === "downloaded") showToast("更新已下载，重启后安装", "success");
      if (payload?.status === "error") showToast(payload.error || "检查更新失败", "error");
      renderApp();
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    renderApp();
    try {
      await Promise.all([loadState(false), loadStaticState()]);
      subscribeToMainEvents();
    } catch (error) {
      state.error = error.message || String(error);
      state.loading = false;
    }
    renderApp();
    queueQuotaAutoSync();
    window.setInterval(() => queueQuotaAutoSync(), QUOTA_AUTO_SYNC_STALE_MS);
  });
})();
