const path = require("node:path");
const { logError, sanitizeMessage } = require("../../engine/logger");
const { describeCaughtError } = require("../../engine/sqlite-native");
const { APP_DISPLAY_NAME, APP_GITHUB_URL } = require("../../engine/app-brand");
let engine = null;

const SWITCH_CHANNELS = new Set(["cursor:switch", "antigravity:switch"]);

function getEngine() {
    if (!engine) engine = require(path.resolve(__dirname, "..", "..", "engine"));
    return engine;
}

function ok(data) { return { success: true, data }; }
function fail(message) { return { success: false, error: String(message) }; }

function tokenRefreshResponse(result) {
    if (result?.ok || result?.reauthRequired) return ok(result);
    return fail(result?.error || "Token refresh failed");
}

function reauthorizationRequiredMessage(operation) {
    return `Account requires reauthorization before ${operation}.`;
}

const BATCH_CONCURRENCY = 5;

function runMapped(eng, items, mapper) {
    if (typeof eng.mapLimit === "function") return eng.mapLimit(items, BATCH_CONCURRENCY, mapper);
    return Promise.all(Array.from(items || []).map((item, index) => mapper(item, index)));
}

function listedCannotRefreshQuota(listed) {
    if (!listed?.banned && !listed?.requires_reauth) return false;
    if (listed.has_access === true || listed.tokens?.access_token) return false;
    return true;
}

function skippedQuotaResult(listed, reason, extra = {}) {
    return {
        id: listed.id,
        email: listed.email,
        skipped: true,
        reason,
        ...extra,
    };
}

function quotaRetryPending(eng, account) {
    const retryAt = Number(account?.quota_next_retry_at || 0);
    if (!Number.isFinite(retryAt) || retryAt <= 0) return false;
    const now = typeof eng.ts === "function" ? eng.ts() : Math.floor(Date.now() / 1000);
    return retryAt > now;
}

async function refreshAccountQuota(eng, account, force) {
    if (account.banned || account.requires_reauth) {
        if (typeof eng.canProbeUsageWithoutRefresh === "function"
            && typeof eng.probeUsageOnly === "function"
            && eng.canProbeUsageWithoutRefresh(account)) {
            return eng.probeUsageOnly(account, { force });
        }
        if (account.banned) {
            const error = new Error("The target account is banned and cannot refresh quotas");
            error.code = "account_banned";
            throw error;
        }
        const error = new Error(reauthorizationRequiredMessage("quotas can be refreshed"));
        error.code = "reauthorization_required";
        throw error;
    }
    return eng.refreshQuota(account, { force });
}

function loadAcctById(eng, id) {
    if (!id) return null;
    try {
        const account = eng.loadAcct(id);
        if (account) return account;
    } catch {}
    const listed = typeof eng.listAccts === "function"
        ? eng.listAccts({ secrets: false }).find((account) => account.email === id || account.id === id)
        : null;
    if (!listed?.id) return null;
    try {
        return eng.loadAcct(listed.id);
    } catch {
        return null;
    }
}

function publicQuota(eng, quota) {
    if (!quota) return null;
    // Re-classify windows saved by older versions before stripping raw data.
    const normalized = typeof eng.normalizeQuota === "function" ? eng.normalizeQuota(quota) : quota;
    const { raw_data, ...safeQuota } = normalized;
    return safeQuota;
}

function publicTokenStatus(eng, account) {
    const accessToken = account.tokens?.access_token || null;
    const refreshToken = account.tokens?.refresh_token || null;
    const storedExp = Number(account.token_exp || account.tokens?.expiry_timestamp || 0);
    const jwtExp = typeof eng.jwtExp === "function" ? eng.jwtExp.bind(eng) : () => null;
    const jwtPayload = typeof eng.jwtPayload === "function" ? eng.jwtPayload.bind(eng) : () => null;
    const now = typeof eng.ts === "function" ? eng.ts() : Math.floor(Date.now() / 1000);
    const expiryDate = accessToken
        ? jwtExp(accessToken)
        : (Number.isFinite(storedExp) && storedExp > 0 ? storedExp : null);
    const issuedAt = accessToken
        ? (jwtPayload(accessToken)?.iat ?? null)
        : (account.token_iat != null ? Number(account.token_iat) : null);
    const accessAvailable = !!accessToken || account.has_access === true;
    const refreshAvailable = !!refreshToken || account.has_refresh === true;
    const expired = accessToken
        ? (typeof eng.isTokenExpired === "function" ? eng.isTokenExpired(accessToken) : !expiryDate)
        : (typeof eng.isExpiryStale === "function" ? eng.isExpiryStale(expiryDate) : !expiryDate);
    return {
        accessAvailable,
        refreshAvailable,
        expired: accessAvailable ? !!expired : true,
        expiryDate: expiryDate || null,
        issuedAt: typeof issuedAt === "number" ? issuedAt : null,
        timeLeft: expiryDate ? expiryDate - now : null,
    };
}

function publicAccount(eng, account) {
    if (!account) return null;
    return {
        id: account.id,
        email: account.email,
        plan_type: account.plan_type,
        subscription_active_until: account.subscription_active_until,
        auth_mode: account.auth_mode,
        token_source_mode: account.token_source_mode,
        token_generation: account.token_generation,
        token_updated_at: account.token_updated_at,
        created_at: account.created_at,
        last_used: account.last_used,
        usage_updated_at: account.usage_updated_at,
        quota_last_attempt_at: account.quota_last_attempt_at || null,
        quota_next_retry_at: account.quota_next_retry_at || null,
        requires_reauth: !!account.requires_reauth,
        reauth_reason: account.reauth_reason || null,
        banned: !!account.banned,
        probe: account.probe ? {
            status: account.probe.status || null,
            error_code: account.probe.error_code || null,
            http_status: account.probe.http_status || null,
            checked_at: account.probe.checked_at || null,
        } : null,
        quota: publicQuota(eng, account.quota),
        quota_error: account.quota_error ? {
            code: account.quota_error.code || null,
            message: account.quota_error.message || String(account.quota_error),
            timestamp: account.quota_error.timestamp || null,
        } : null,
        token_status: publicTokenStatus(eng, account),
    };
}

async function inspectAuthStateWithBusyTimeout(eng, accountId) {
    let cancelled = false;
    let busyTimer = null;
    const inspectPromise = eng.withAccountLock(accountId, async () => {
        if (cancelled) return null;
        return eng.inspectAuthState({ migrateProjection: false });
    });
    inspectPromise.catch(() => {});
    try {
        const state = await Promise.race([
            inspectPromise,
            new Promise((_, reject) => {
                busyTimer = setTimeout(() => {
                    cancelled = true;
                    reject(new Error("Authentication state is busy"));
                }, 1500);
            }),
        ]);
        if (!state) {
            const error = new Error("Authentication state is busy");
            throw error;
        }
        return state;
    } finally {
        if (busyTimer) clearTimeout(busyTimer);
    }
}

async function inspectAuthStateForBackground(eng) {
    const index = typeof eng.loadIdx === "function" ? eng.loadIdx() : null;
    const currentId = index?.current_account_id;
    if (currentId && typeof eng.withAccountLock === "function") {
        return inspectAuthStateWithBusyTimeout(eng, currentId);
    }
    return eng.inspectAuthState({ migrateProjection: false });
}

function listedCurrent(listed, currentId, fallbackLoad) {
    if (!currentId) return null;
    return listed.find((account) => account.id === currentId)
        || (typeof fallbackLoad === "function" ? fallbackLoad(currentId) : null);
}

function listedAccountRef(listed, id, options = {}) {
    if (!id || !Array.isArray(listed)) return null;
    return listed.find((account) => account.id === id
        || (options.allowEmail === true && account.email === id)) || null;
}

function publicAutoSwitchResult(eng, result) {
    if (!result) return result;
    return {
        ...result,
        from: publicAccount(eng, result.from),
        to: publicAccount(eng, result.to),
    };
}

async function withFreshAccount(eng, id, task) {
    return eng.withAccountLock(id, async () => {
        const account = loadAcctById(eng, id);
        if (!account) return fail("Account does not exist");
        return task(account);
    });
}

async function foldListedAccounts(eng, lockId, collapse) {
    if (typeof collapse !== "function") return;
    try {
        await eng.withAccountLock(lockId, async () => collapse());
    } catch (error) {
        if (typeof eng.logWarn === "function") {
            eng.logWarn(`Account fold skipped: ${error.message}`);
        }
    }
}

function registerIpcHandlers(engineInstance = null, services = {}) {
    const { ipcMain, BrowserWindow, app, shell } = services.electron || require("electron");
    if (engineInstance) engine = engineInstance;
    const eng = engineInstance || getEngine();
    const updateService = services.updateService || null;
    const setDaemonInterval = services.setInterval || setInterval;
    const clearDaemonInterval = services.clearInterval || clearInterval;
    const trustedSenderIds = services.trustedSenderIds instanceof Set
        ? services.trustedSenderIds
        : null;
    const isTrustedSender = (event) => {
        if (!trustedSenderIds) return true;
        return trustedSenderIds.has(event?.sender?.id);
    };
    const handle = (channel, listener) => {
        ipcMain.handle(channel, async (event, ...args) => {
            if (!isTrustedSender(event)) return fail("Untrusted IPC sender");
            try {
                return await listener(event, ...args);
            } catch (error) {
                if (SWITCH_CHANNELS.has(channel)) {
                    logError(`IPC ${channel} failed ${sanitizeMessage(describeCaughtError(error))}`);
                }
                return fail(error?.message || error);
            }
        });
    };

    const broadcast = (channel, payload) => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
            try { window.webContents.send(channel, payload); } catch {}
        }
    };
    const emitAccountUpdated = (product, account, extra = {}) => {
        if (!account) return;
        try { broadcast("account:updated", { product, account, ...extra }); } catch {}
    };
    const emitQuotaUpdated = (product, account) => {
        if (!account) return;
        try { broadcast("quota:updated", { product, account, quota: account.quota || null }); } catch {}
    };
    if (typeof eng.setOAuthAccountSavedHandler === "function") {
        eng.setOAuthAccountSavedHandler((result) => {
            const published = publicAccount(eng, result.account);
            emitAccountUpdated("codex", published, { current: !result.switchError });
        });
    }

    async function withTimeout(task, ms, fallback = null) {
        let timer = null;
        try {
            return await Promise.race([
                Promise.resolve().then(task),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve(fallback), ms);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    handle("app:uiReady", () => {
        try { services.onUiReady?.(); } catch (error) {
            console.error("Startup housekeeping failed:", error);
        }
        return ok(true);
    });
    handle("app:info", () => ok(updateService?.getAppInfo?.() || {
        name: APP_DISPLAY_NAME,
        version: app.getVersion(),
        releaseChannel: String(app.getVersion()).includes("-") ? "beta" : "stable",
        isPackaged: app.isPackaged,
        updateEnabled: false,
        repository: APP_GITHUB_URL,
    }));
    handle("update:status", () => ok(updateService?.getStatus?.() || {
        status: "disabled",
        enabled: false,
        channel: String(app.getVersion()).includes("-") ? "beta" : "stable",
        message: "Update service is not initialized",
    }));
    handle("update:check", async () => {
        try { return ok(updateService ? await updateService.checkForUpdates() : null); }
        catch (error) { return fail(error.message); }
    });
    handle("update:install", () => {
        try { return ok(updateService ? updateService.installUpdate() : null); }
        catch (error) { return fail(error.message); }
    });
    handle("app:openExternal", async (event, url) => {
        try {
            const target = String(url || "");
            if (!/^https?:\/\//i.test(target)) return fail("Unsupported external URL");
            await shell.openExternal(target);
            return ok(true);
        } catch (error) { return fail(error.message); }
    });
    handle("app:openLogs", async () => {
        try {
            const error = await shell.openPath(eng.getLogDir());
            return error ? fail(error) : ok(true);
        } catch (openError) { return fail(openError.message); }
    });

    handle("window:minimize", (event) => {
        if (typeof services.minimizeMainWindow === "function") {
            services.minimizeMainWindow();
            return ok(true);
        }
        BrowserWindow.fromWebContents(event.sender)?.minimize();
        return ok(true);
    });
    handle("window:toggleMaximize", (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            if (win.isMaximized()) win.unmaximize();
            else win.maximize();
        }
        return ok(true);
    });
    handle("window:close", (event) => {
        BrowserWindow.fromWebContents(event.sender)?.close();
        return ok(true);
    });
    handle("window:showMain", () => {
        if (typeof services.showMainWindow === "function") services.showMainWindow();
        return ok(true);
    });
    handle("float:show", (event, product) => {
        if (!services.floatWindow) {
            return ok({ exists: false, visible: false, alwaysOnTop: false, product: product === "cursor" ? "cursor" : "codex" });
        }
        services.floatWindow.show(product);
        return ok(services.floatWindow.inspect());
    });
    handle("float:hide", () => {
        services.floatWindow?.hide();
        return ok(true);
    });
    handle("float:setProduct", (event, product) => {
        if (!services.floatWindow) {
            return ok({ visible: false, alwaysOnTop: false, product: product === "cursor" ? "cursor" : "codex" });
        }
        services.floatWindow.setProduct(product);
        return ok(services.floatWindow.getState());
    });
    handle("float:setAlwaysOnTop", (event, value) => {
        services.floatWindow?.setAlwaysOnTop(!!value);
        return ok(true);
    });
    handle("float:getState", () => ok(services.floatWindow?.getState() || {
        visible: false,
        alwaysOnTop: false,
        product: "codex",
    }));
    handle("float:setHeight", (event, height) => {
        services.floatWindow?.setHeight(height);
        return ok(true);
    });
    handle("storage:diagnostics", () => ok(eng.getStorageDiagnostics()));

    function publicCursorQuota(quota) {
        if (!quota) return null;
        const { raw_data, ...safeQuota } = quota;
        return safeQuota;
    }

    function publicCursorAccount(account) {
        if (!account) return null;
        return {
            id: account.id,
            platform: "cursor",
            email: account.email,
            plan_type: account.plan_type,
            auth_id: account.auth_id || null,
            subscription_status: account.subscription_status || null,
            auth_mode: account.auth_mode,
            token_source_mode: account.token_source_mode,
            token_generation: account.token_generation,
            token_updated_at: account.token_updated_at,
            created_at: account.created_at,
            last_used: account.last_used,
            usage_updated_at: account.usage_updated_at,
            requires_reauth: !!account.requires_reauth,
            reauth_reason: account.reauth_reason || null,
            banned: false,
            probe: account.probe ? {
                status: account.probe.status || null,
                error_code: account.probe.error_code || null,
                http_status: account.probe.http_status || null,
                checked_at: account.probe.checked_at || null,
            } : null,
            quota: publicCursorQuota(account.quota),
            quota_error: account.quota_error ? {
                code: account.quota_error.code || null,
                message: account.quota_error.message || String(account.quota_error),
                timestamp: account.quota_error.timestamp || null,
            } : null,
            token_status: publicTokenStatus(eng, account),
        };
    }

    async function withFreshCursorAccount(id, task) {
        return eng.withAccountLocks(["__cursor_switch__", id], async () => {
            const account = eng.loadCursorAcct(id);
            if (!account) return fail("Account does not exist");
            return task(account);
        });
    }

    handle("codex:status", async () => {
        try {
            const detect = typeof eng.getCodexInstallationStatusAsync === "function"
                ? eng.getCodexInstallationStatusAsync()
                : Promise.resolve(eng.getCodexInstallationStatus());
            return ok(await detect);
        }
        catch (error) { return fail(error.message); }
    });

    handle("cursor:status", async () => {
        try {
            const detect = typeof eng.getCursorInstallationStatusAsync === "function"
                ? eng.getCursorInstallationStatusAsync()
                : Promise.resolve(eng.getCursorInstallationStatus());
            return ok(await detect);
        }
        catch (error) { return fail(error.message); }
    });
    handle("cursor:list", async (event, options) => {
        if (!options?.skipOfficialSync) await eng.syncCurrentCursorFromOfficial();
        return ok(eng.listCursorAccts({ secrets: false }).map((account) => publicCursorAccount(account)));
    });
    handle("cursor:current", async (event, options) => {
        if (!options?.skipOfficialSync) await eng.syncCurrentCursorFromOfficial();
        const listed = eng.listCursorAccts({ secrets: false });
        const currentId = typeof eng.loadCursorIdx === "function"
            ? eng.loadCursorIdx()?.current_cursor_account_id
            : null;
        return ok(publicCursorAccount(listedCurrent(
            listed,
            currentId,
            typeof eng.loadCursorAcct === "function" ? (id) => eng.loadCursorAcct(id) : null,
        )));
    });
    handle("cursor:importLocal", async () => {
        return eng.withAccountLock("__cursor_switch__", async () => {
            const result = await eng.importLocalCursorAccount();
            return ok({
                found: !!result.found,
                account: publicCursorAccount(result.account),
                mismatch: !!result.mismatch,
                updated: !!result.updated,
                stalePossible: !!result.stalePossible,
            });
        });
    });
    handle("cursor:add", async () => {
        const result = await eng.cursorLoginFlow();
        return ok({
            account: publicCursorAccount(result.account),
            mismatch: !!result.mismatch,
            targetAccountId: result.targetAccountId || null,
        });
    });
    handle("cursor:reauthorize", async (event, id) => {
        const target = listedAccountRef(eng.listCursorAccts({ secrets: false }), id);
        if (!target) return fail("Account does not exist");
        const result = await eng.cursorLoginFlow({ targetAccountId: target.id });
        return ok({
            account: publicCursorAccount(result.account),
            mismatch: !!result.mismatch,
            targetAccountId: target.id,
        });
    });
    handle("cursor:oauthStatus", () => ok(eng.getCursorOAuthStatus()));
    handle("cursor:oauthCancel", () => ok(eng.cancelCursorOAuth()));
    handle("cursor:delete", async (event, id) => {
        const target = listedAccountRef(eng.listCursorAccts({ secrets: false }), id);
        if (!target) return fail("Account does not exist");
        return eng.withAccountLocks(["__cursor_switch__", target.id], async () => {
            return ok(eng.deleteCursorAcct(target.id, { allowCurrent: false }));
        });
    });
    handle("cursor:switch", async (event, id) => {
        const target = listedAccountRef(eng.listCursorAccts({ secrets: false }), id);
        if (!target) return fail("Account does not exist");
        const currentId = typeof eng.loadCursorIdx === "function"
            ? eng.loadCursorIdx()?.current_cursor_account_id
            : null;
        const lockIds = ["__cursor_switch__", target.id];
        if (currentId && currentId !== target.id) lockIds.push(currentId);
        return eng.withAccountLocks(lockIds, async () => {
            const account = eng.loadCursorAcct(target.id);
            if (!account) return fail("Account does not exist");
                const result = await eng.doCursorSwitch(account);
                const publicResult = publicCursorAccount(result.account);
                emitAccountUpdated("cursor", publicResult, { current: true });
                return ok({
                    ...result,
                    account: publicResult,
                });
        });
    });
    handle("cursor:refreshQuota", async (event, id, force = true) => {
        return withFreshCursorAccount(id, async (account) => {
            const quota = await eng.refreshCursorQuota(account, { force: force !== false });
            const fresh = publicCursorAccount(account);
            emitQuotaUpdated("cursor", fresh);
            emitAccountUpdated("cursor", fresh);
            return ok(publicCursorQuota(quota));
        });
    });
    handle("cursor:refreshAllQuotas", async () => {
        const listedAccounts = eng.listCursorAccts({ secrets: false });
        const results = await runMapped(eng, listedAccounts, async (listed) => {
            try {
                return await eng.withAccountLock(listed.id, async () => {
                    if (listed.requires_reauth) {
                        return skippedQuotaResult(listed, "reauthorization_required");
                    }
                    if (quotaRetryPending(eng, listed)) {
                        return skippedQuotaResult(listed, "quota_retry_pending");
                    }
                    const account = eng.loadCursorAcct(listed.id);
                    if (!account) return null;
                    if (account.requires_reauth) {
                        return {
                            id: account.id,
                            email: account.email,
                            skipped: true,
                            reason: "reauthorization_required",
                        };
                    }
                    if (quotaRetryPending(eng, account)) {
                        return {
                            id: account.id,
                            email: account.email,
                            skipped: true,
                            reason: "quota_retry_pending",
                        };
                    }
                    const quota = await eng.refreshCursorQuota(account, { force: true });
                    const fresh = account;
                    if (fresh.requires_reauth || fresh.quota_error?.code === "reauthorization_required") {
                        return {
                            id: account.id,
                            email: account.email,
                            skipped: true,
                            reason: "reauthorization_required",
                        };
                    }
                    if (fresh.quota_error) {
                        return {
                            id: account.id,
                            email: account.email,
                            error: fresh.quota_error.message,
                            reason: fresh.quota_error.code,
                        };
                    }
                    const published = publicCursorAccount(fresh);
                    emitQuotaUpdated("cursor", published);
                    emitAccountUpdated("cursor", published);
                    return { id: account.id, email: account.email, quota: publicCursorQuota(quota) };
                });
            } catch (error) {
                return {
                    id: listed.id,
                    email: listed.email,
                    error: error.message,
                    reason: error.code || undefined,
                };
            }
        });
        return ok(results.filter(Boolean));
    });
    handle("cursor:refreshToken", async (event, id) => {
        return withFreshCursorAccount(id, async (account) => {
            const result = await eng.refreshCursorToken(account, { force: true });
            return tokenRefreshResponse(result);
        });
    });
    handle("cursor:refreshAllTokens", async (event, force) => {
        try { return ok(await eng.refreshAllCursorTokens(!!force)); }
        catch (error) { return fail(error.message); }
    });

    function publicAntigravityQuota(quota) {
        if (!quota) return null;
        const { raw_data, ...safeQuota } = quota;
        return safeQuota;
    }

    function publicAntigravityAccount(account) {
        if (!account) return null;
        return {
            id: account.id,
            platform: "antigravity",
            email: account.email,
            plan_type: account.plan_type,
            auth_id: account.auth_id || null,
            auth_mode: account.auth_mode,
            token_source_mode: account.token_source_mode,
            token_generation: account.token_generation,
            token_updated_at: account.token_updated_at,
            created_at: account.created_at,
            last_used: account.last_used,
            usage_updated_at: account.usage_updated_at,
            requires_reauth: !!account.requires_reauth,
            reauth_reason: account.reauth_reason || null,
            banned: false,
            probe: account.probe ? {
                status: account.probe.status || null,
                error_code: account.probe.error_code || null,
                http_status: account.probe.http_status || null,
                checked_at: account.probe.checked_at || null,
            } : null,
            quota: publicAntigravityQuota(account.quota),
            quota_error: account.quota_error ? {
                code: account.quota_error.code || null,
                message: account.quota_error.message || String(account.quota_error),
                timestamp: account.quota_error.timestamp || null,
            } : null,
            token_status: publicTokenStatus(eng, account),
        };
    }

    async function withFreshAntigravityAccount(id, task) {
        return eng.withAccountLocks(["__antigravity_switch__", id], async () => {
            const account = eng.loadAntigravityAcct(id);
            if (!account) return fail("Account does not exist");
            return task(account);
        });
    }

    handle("antigravity:status", async () => {
        try {
            const detect = typeof eng.getAntigravityInstallationStatusAsync === "function"
                ? eng.getAntigravityInstallationStatusAsync()
                : Promise.resolve(eng.getAntigravityInstallationStatus());
            return ok(await detect);
        }
        catch (error) { return fail(error.message); }
    });
    handle("antigravity:list", async (event, options) => {
        if (!options?.skipOfficialSync) await eng.syncCurrentAntigravityFromOfficial();
        return ok(eng.listAntigravityAccts({ secrets: false }).map((account) => publicAntigravityAccount(account)));
    });
    handle("antigravity:current", async (event, options) => {
        if (!options?.skipOfficialSync) await eng.syncCurrentAntigravityFromOfficial();
        const listed = eng.listAntigravityAccts({ secrets: false });
        const currentId = typeof eng.loadAntigravityIdx === "function"
            ? eng.loadAntigravityIdx()?.current_antigravity_account_id
            : null;
        return ok(publicAntigravityAccount(listedCurrent(
            listed,
            currentId,
            typeof eng.loadAntigravityAcct === "function" ? (id) => eng.loadAntigravityAcct(id) : null,
        )));
    });
    handle("antigravity:importLocal", async () => {
        return eng.withAccountLock("__antigravity_switch__", async () => {
            const result = await eng.importLocalAntigravityAccount();
            return ok({
                found: !!result.found,
                account: publicAntigravityAccount(result.account),
                mismatch: !!result.mismatch,
                updated: !!result.updated,
                stalePossible: !!result.stalePossible,
            });
        });
    });
    handle("antigravity:add", async () => {
        const result = await eng.antigravityLoginFlow();
        return ok({
            account: publicAntigravityAccount(result.account),
            mismatch: !!result.mismatch,
            targetAccountId: result.targetAccountId || null,
        });
    });
    handle("antigravity:reauthorize", async (event, id) => {
        const target = listedAccountRef(eng.listAntigravityAccts({ secrets: false }), id);
        if (!target) return fail("Account does not exist");
        const result = await eng.antigravityLoginFlow({ targetAccountId: target.id });
        return ok({
            account: publicAntigravityAccount(result.account),
            mismatch: !!result.mismatch,
            targetAccountId: target.id,
        });
    });
    handle("antigravity:oauthStatus", () => ok(eng.getAntigravityOAuthStatus()));
    handle("antigravity:oauthCancel", () => ok(eng.cancelAntigravityOAuth()));
    handle("antigravity:delete", async (event, id) => {
        const target = listedAccountRef(eng.listAntigravityAccts({ secrets: false }), id);
        if (!target) return fail("Account does not exist");
        return eng.withAccountLocks(["__antigravity_switch__", target.id], async () => {
            return ok(eng.deleteAntigravityAcct(target.id, { allowCurrent: false }));
        });
    });
    handle("antigravity:switch", async (event, id) => {
        const target = listedAccountRef(eng.listAntigravityAccts({ secrets: false }), id);
        if (!target) return fail("Account does not exist");
        const currentId = typeof eng.loadAntigravityIdx === "function"
            ? eng.loadAntigravityIdx()?.current_antigravity_account_id
            : null;
        const lockIds = ["__antigravity_switch__", target.id];
        if (currentId && currentId !== target.id) lockIds.push(currentId);
        return eng.withAccountLocks(lockIds, async () => {
            const account = eng.loadAntigravityAcct(target.id);
            if (!account) return fail("Account does not exist");
            const result = await eng.doAntigravitySwitch(account);
            const publicResult = publicAntigravityAccount(result.account);
            emitAccountUpdated("antigravity", publicResult, { current: true });
            return ok({
                ...result,
                account: publicResult,
            });
        });
    });
    handle("antigravity:refreshQuota", async (event, id, force = true) => {
        return withFreshAntigravityAccount(id, async (account) => {
            const quota = await eng.refreshAntigravityQuota(account, { force: force !== false });
            const fresh = publicAntigravityAccount(account);
            emitQuotaUpdated("antigravity", fresh);
            emitAccountUpdated("antigravity", fresh);
            return ok(publicAntigravityQuota(quota));
        });
    });
    handle("antigravity:refreshAllQuotas", async () => {
        const listedAccounts = eng.listAntigravityAccts({ secrets: false });
        const results = await runMapped(eng, listedAccounts, async (listed) => {
            try {
                return await eng.withAccountLock(listed.id, async () => {
                    if (listed.requires_reauth) {
                        return skippedQuotaResult(listed, "reauthorization_required");
                    }
                    if (quotaRetryPending(eng, listed)) {
                        return skippedQuotaResult(listed, "quota_retry_pending");
                    }
                    const account = eng.loadAntigravityAcct(listed.id);
                    if (!account) return null;
                    if (account.requires_reauth) {
                        return {
                            id: account.id,
                            email: account.email,
                            skipped: true,
                            reason: "reauthorization_required",
                        };
                    }
                    if (quotaRetryPending(eng, account)) {
                        return {
                            id: account.id,
                            email: account.email,
                            skipped: true,
                            reason: "quota_retry_pending",
                        };
                    }
                    const quota = await eng.refreshAntigravityQuota(account, { force: true });
                    const fresh = account;
                    if (fresh.requires_reauth || fresh.quota_error?.code === "reauthorization_required") {
                        return {
                            id: account.id,
                            email: account.email,
                            skipped: true,
                            reason: "reauthorization_required",
                        };
                    }
                    if (fresh.quota_error) {
                        return {
                            id: account.id,
                            email: account.email,
                            error: fresh.quota_error.message,
                            reason: fresh.quota_error.code,
                        };
                    }
                    const published = publicAntigravityAccount(fresh);
                    emitQuotaUpdated("antigravity", published);
                    emitAccountUpdated("antigravity", published);
                    return { id: account.id, email: account.email, quota: publicAntigravityQuota(quota) };
                });
            } catch (error) {
                return {
                    id: listed.id,
                    email: listed.email,
                    error: error.message,
                    reason: error.code || undefined,
                };
            }
        });
        return ok(results.filter(Boolean));
    });
    handle("antigravity:refreshToken", async (event, id) => {
        return withFreshAntigravityAccount(id, async (account) => {
            const result = await eng.refreshAntigravityToken(account, { force: true });
            return tokenRefreshResponse(result);
        });
    });
    handle("antigravity:refreshAllTokens", async (event, force) => {
        try { return ok(await eng.refreshAllAntigravityTokens(!!force)); }
        catch (error) { return fail(error.message); }
    });

    handle("account:list", async () => {
        return ok(eng.listAccts({ secrets: false }).map(account => publicAccount(eng, account)));
    });
    handle("account:current", () => {
        const listed = eng.listAccts({ secrets: false });
        const currentId = typeof eng.loadIdx === "function" ? eng.loadIdx()?.current_account_id : null;
        return ok(publicAccount(eng, listedCurrent(
            listed,
            currentId,
            typeof eng.loadAcct === "function" ? (id) => eng.loadAcct(id) : null,
        )));
    });
    handle("account:get", (event, id) => {
        const listed = listedAccountRef(eng.listAccts({ secrets: false }), id);
        const account = listed
            || (typeof eng.loadAcct === "function" ? eng.loadAcct(id) : null);
        return account ? ok(publicAccount(eng, account)) : fail("Account does not exist");
    });
    handle("account:authState", async () => {
        try {
            // inspectAuthState may write the current account file (official
            // token rotation sync); serialize it against in-flight refreshes.
            // If the daemon already holds that lock for a quota HTTP call,
            // do not keep the first dashboard paint waiting on chatgpt.com.
            const index = eng.loadIdx();
            const state = index.current_account_id
                ? await inspectAuthStateWithBusyTimeout(eng, index.current_account_id)
                : eng.inspectAuthState({ migrateProjection: false });
            return ok(state);
        } catch (error) { return fail(error.message); }
    });
    handle("account:adoptOfficial", async () => {
        try {
            const result = await eng.adoptOfficialAuth();
            const account = result?.account || result;
            return ok({ ...publicAccount(eng, account), updated: !!result?.updated });
        }
        catch (error) { return fail(error.message); }
    });
    handle("account:reapplyManaged", async (event, id) => {
        try {
            const result = await eng.reapplyManagedAuth(id || null);
            return ok({ ...result, account: publicAccount(eng, result.account) });
        } catch (error) { return fail(error.message); }
    });

    handle("account:add", async () => {
        try {
            const result = await eng.oauthLoginFlow();
            return ok({
                account: publicAccount(eng, result.account),
                mismatch: !!result.mismatch,
                targetAccountId: result.targetAccountId || null,
            });
        } catch (error) { return fail(error.message); }
    });
    handle("account:reauthorize", async (event, id) => {
        try {
            const target = listedAccountRef(eng.listAccts({ secrets: false }), id, { allowEmail: true });
            if (!target) return fail("Account does not exist");
            const result = await eng.oauthLoginFlow({ targetAccountId: target.id });
            return ok({
                account: publicAccount(eng, result.account),
                mismatch: !!result.mismatch,
                targetAccountId: target.id,
            });
        } catch (error) { return fail(error.message); }
    });
    handle("oauth:status", () => ok(eng.getOAuthStatus()));
    handle("oauth:cancel", () => {
        try { return ok(eng.cancelOAuth()); }
        catch (error) { return fail(error.message); }
    });
    handle("oauth:completeManual", async (event, callbackUrl) => {
        try {
            const result = await eng.completeOAuthManually(callbackUrl);
            return ok({
                account: publicAccount(eng, result.account),
                mismatch: !!result.mismatch,
                targetAccountId: result.targetAccountId || null,
            });
        }
        catch (error) { return fail(error.message); }
    });

    handle("account:delete", async (event, id) => {
        try {
            const target = listedAccountRef(eng.listAccts({ secrets: false }), id, { allowEmail: true });
            if (!target) return fail("Account does not exist");
            return await eng.withAccountLock(target.id, async () => {
                return ok(eng.deleteAcct(target.id, { allowCurrent: false }));
            });
        } catch (error) { return fail(error.message); }
    });
    handle("account:switch", async (event, id) => {
        try {
            // Resolve the canonical id before locking (the renderer contract
            // also accepts emails) and hold the outgoing current account's
            // lock too, so a token refresh cannot rotate its credentials in
            // the middle of the transaction and get destroyed by a rollback.
            const target = listedAccountRef(eng.listAccts({ secrets: false }), id, { allowEmail: true });
            if (!target) return fail("Account does not exist");
            const currentId = eng.loadIdx().current_account_id;
            const lockIds = ["__switch__", target.id];
            if (currentId && currentId !== target.id) lockIds.push(currentId);
            return await eng.withAccountLocks(lockIds, async () => {
                const account = eng.loadAcct(target.id);
                if (!account) return fail("Account does not exist");
                const result = await eng.doSwitch(account);
                const published = publicAccount(eng, result.account);
                emitAccountUpdated("codex", published, { current: true });
                return ok({ ...result, account: published });
            });
        } catch (error) { return fail(error.message); }
    });

    handle("quota:refresh", async (event, id, force = true) => {
        try {
            if (force === false) {
                const authState = await inspectAuthStateForBackground(eng);
                if (authState.requiresResolution) {
                    return fail(authState.message || "Automatic quota sync is paused until authentication is resolved");
                }
            }
            return await withFreshAccount(eng, id, async account => {
                const quota = await refreshAccountQuota(eng, account, force !== false);
                const published = publicAccount(eng, account);
                emitQuotaUpdated("codex", published);
                emitAccountUpdated("codex", published);
                return ok(publicQuota(eng, quota));
            });
        } catch (error) { return fail(error.message); }
    });
    handle("quota:refreshAll", async () => {
        const listedAccounts = eng.listAccts({ secrets: false });
        const results = await runMapped(eng, listedAccounts, async (listed) => {
            try {
                return await eng.withAccountLock(listed.id, async () => {
                    if (quotaRetryPending(eng, listed)) {
                        return skippedQuotaResult(listed, "quota_retry_pending");
                    }
                    if (listedCannotRefreshQuota(listed)) {
                        return skippedQuotaResult(listed, listed.banned ? "account_banned" : "reauthorization_required", {
                            banned: !!listed.banned,
                        });
                    }
                    const account = eng.loadAcct(listed.id);
                    if (!account) return null;
                    try {
                        if (quotaRetryPending(eng, account)) {
                            return {
                                id: account.id,
                                email: account.email,
                                skipped: true,
                                reason: "quota_retry_pending",
                            };
                        }
                        if (account.banned || account.requires_reauth) {
                            if (typeof eng.canProbeUsageWithoutRefresh === "function"
                                && typeof eng.probeUsageOnly === "function"
                                && eng.canProbeUsageWithoutRefresh(account)) {
                                const quota = await eng.probeUsageOnly(account, { force: true });
                                const published = publicAccount(eng, account);
                                emitQuotaUpdated("codex", published);
                                emitAccountUpdated("codex", published);
                                return { id: account.id, email: account.email, quota: publicQuota(eng, quota) };
                            }
                            return {
                                id: account.id,
                                email: account.email,
                                skipped: true,
                                reason: account.banned ? "account_banned" : "reauthorization_required",
                                banned: !!account.banned,
                            };
                        }
                        const quota = await eng.refreshQuota(account, { force: true });
                        const published = publicAccount(eng, account);
                        emitQuotaUpdated("codex", published);
                        emitAccountUpdated("codex", published);
                        return { id: account.id, email: account.email, quota: publicQuota(eng, quota) };
                    } catch (error) {
                        return {
                            id: account.id,
                            email: account.email,
                            error: error.message,
                            banned: !!account.banned,
                            reason: error.code || undefined,
                        };
                    }
                });
            } catch (error) {
                return {
                    id: listed.id,
                    email: listed.email,
                    error: error.message,
                    banned: !!listed.banned,
                    reason: error.code || undefined,
                };
            }
        });
        return ok(results.filter(Boolean));
    });

    handle("token:refresh", async (event, id) => {
        try {
            return await withFreshAccount(eng, id, async account => {
                if (account.banned) {
                    return fail("The target account is banned and token refresh is skipped");
                }
                const result = await eng.refreshOneTok(account);
                return tokenRefreshResponse(result);
            });
        }
        catch (error) { return fail(error.message); }
    });
    handle("token:refreshAll", async (event, force) => {
        try { return ok(await eng.refreshAll(!!force)); }
        catch (error) { return fail(error.message); }
    });
    handle("token:status", (event, id) => {
        const account = loadAcctById(eng, id);
        if (!account?.tokens?.access_token) return ok({ expired: true, refreshAvailable: false });
        const expiryDate = eng.jwtExp(account.tokens.access_token);
        return ok({
            expired: eng.isTokenExpired(account.tokens.access_token),
            refreshAvailable: !!account.tokens.refresh_token,
            expiryDate,
            timeLeft: expiryDate ? expiryDate - eng.ts() : null,
        });
    });
    let daemonTimer = null;
    let daemonInFlight = false;
    let daemonRunRequested = false;
    let daemonGeneration = 0;
    const daemonRuntimeState = {
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: null,
        pausedReason: null,
    };
    const daemonIntervalMinutes = () => typeof eng.getTickIntervalMinutes === "function"
        ? eng.getTickIntervalMinutes()
        : Math.max(1, Math.round(eng.getTickIntervalMs() / 60000));
    const bumpDaemonGeneration = () => {
        daemonGeneration += 1;
        return daemonGeneration;
    };

    const runDaemon = async () => {
        if (daemonInFlight) {
            if (daemonTimer !== null) daemonRunRequested = true;
            return;
        }
        const runGeneration = daemonGeneration;
        const isCancelled = () => runGeneration !== daemonGeneration || daemonTimer === null;
        daemonInFlight = true;
        try {
            const result = await eng.runDaemonWorker({ isCancelled });
            if (runGeneration !== daemonGeneration) {
                daemonRuntimeState.lastRunAt = result.completedAt || Date.now();
                daemonRuntimeState.pausedReason = result.pausedReason || "stopped";
                daemonRuntimeState.lastError = null;
                return;
            }
            daemonRuntimeState.lastRunAt = result.completedAt || Date.now();
            daemonRuntimeState.pausedReason = result.pausedReason || null;
            daemonRuntimeState.lastError = result.failures?.length
                ? result.failures.map(item => item.message).join("; ")
                : null;
            if (!result.pausedReason && !result.failures?.length) {
                daemonRuntimeState.lastSuccessAt = result.completedAt || Date.now();
            }
            const safeResult = {
                ...result,
                autoSwitchResult: publicAutoSwitchResult(eng, result.autoSwitchResult),
            };
            broadcast("daemon:tick", {
                ts: Date.now(),
                result: safeResult,
            });
            if (safeResult.autoSwitchResult?.switched) {
                broadcast("autoswitch:executed", safeResult.autoSwitchResult);
            }
            if (safeResult.pausedReason === "auth_conflict") {
                broadcast("auth:conflict", safeResult.authState);
            }
            if (safeResult.failures?.length) {
                broadcast("daemon:error", {
                    message: safeResult.failures.map(item => item.message).join("; "),
                    failures: safeResult.failures,
                });
            }
        } catch (error) {
            if (runGeneration !== daemonGeneration) return;
            daemonRuntimeState.lastRunAt = Date.now();
            daemonRuntimeState.lastError = error.message;
            broadcast("daemon:error", { message: error.message });
        } finally {
            daemonInFlight = false;
            if (daemonRunRequested && daemonTimer !== null) {
                daemonRunRequested = false;
                queueMicrotask(() => {
                    if (daemonTimer !== null) void runDaemon();
                });
            }
        }
    };

    const startDaemonTimer = () => {
        daemonTimer = setDaemonInterval(() => void runDaemon(), eng.getTickIntervalMs());
    };
    const reloadDaemonTimer = () => {
        if (!daemonTimer) return;
        clearDaemonInterval(daemonTimer);
        startDaemonTimer();
    };
    const startDaemon = () => {
        if (daemonTimer) return ok("Already running");
        bumpDaemonGeneration();
        startDaemonTimer();
        void runDaemon();
        return ok("Started");
    };
    const stopDaemon = () => {
        if (!daemonTimer) return ok("Not running");
        clearDaemonInterval(daemonTimer);
        daemonTimer = null;
        daemonRunRequested = false;
        bumpDaemonGeneration();
        daemonRuntimeState.pausedReason = "stopped";
        daemonRuntimeState.lastError = null;
        return ok("Stopped");
    };

    handle("autoswitch:config:get", () => ok(eng.loadAutoSwitchCfg()));
    handle("autoswitch:config:save", (event, config) => {
        try {
            const previousInterval = daemonIntervalMinutes();
            const wasEnabled = !!eng.loadAutoSwitchCfg().enabled;
            eng.saveAutoSwitchCfg(config);
            if (daemonIntervalMinutes() !== previousInterval) reloadDaemonTimer();
            // Mirror the startup behavior: enabling auto-switch must pull the
            // daemon up, or the feature silently does nothing until a restart.
            // Disabling does not stop the daemon (it still owns periodic sync).
            const isEnabled = !!eng.loadAutoSwitchCfg().enabled;
            if (isEnabled && !wasEnabled && !daemonTimer) startDaemon();
            return ok(true);
        } catch (error) { return fail(error.message); }
    });
    handle("autoswitch:tick", async () => {
        try {
            const result = publicAutoSwitchResult(eng, await eng.autoSwitchTick(eng.loadAutoSwitchCfg()));
            const completedAt = Date.now();
            const failedReason = result?.reason === "current_quota_refresh_failed" || result?.reason === "auth_conflict";
            const completedSuccessfully = !!result?.switched ||
                result?.reason === "quota_sufficient" ||
                result?.reason === "no_candidates";
            daemonRuntimeState.lastRunAt = completedAt;
            daemonRuntimeState.lastError = failedReason
                ? result.error || result.reason
                : null;
            if (completedSuccessfully) daemonRuntimeState.lastSuccessAt = completedAt;
            return ok(result);
        } catch (error) {
            daemonRuntimeState.lastRunAt = Date.now();
            daemonRuntimeState.lastError = error.message;
            return fail(error.message);
        }
    });
    handle("daemon:start", startDaemon);
    handle("daemon:stop", stopDaemon);
    handle("daemon:status", () => ok({
        running: daemonTimer !== null,
        syncIntervalMinutes: daemonIntervalMinutes(),
        ...daemonRuntimeState,
    }));

    handle("desktop:snapshot", async (event, options) => {
        const skipOfficialSync = !!options?.skipOfficialSync;
        if (!skipOfficialSync) {
            try { await eng.syncCurrentCursorFromOfficial(); } catch {}
            try { await eng.syncCurrentAntigravityFromOfficial(); } catch {}
        }
        let authState = null;
        let authError = null;
        try {
            authState = await inspectAuthStateForBackground(eng);
        } catch (error) {
            authError = error?.message || String(error);
        }
        const [codexStatus, cursorStatus, antigravityStatus] = await Promise.all([
            withTimeout(async () => {
                if (typeof eng.getCodexInstallationStatusAsync === "function") {
                    return eng.getCodexInstallationStatusAsync();
                }
                return typeof eng.getCodexInstallationStatus === "function" ? eng.getCodexInstallationStatus() : null;
            }, 2500, null),
            withTimeout(async () => {
                if (typeof eng.getCursorInstallationStatusAsync === "function") {
                    return eng.getCursorInstallationStatusAsync();
                }
                return typeof eng.getCursorInstallationStatus === "function" ? eng.getCursorInstallationStatus() : null;
            }, 2500, null),
            withTimeout(async () => {
                if (typeof eng.getAntigravityInstallationStatusAsync === "function") {
                    return eng.getAntigravityInstallationStatusAsync();
                }
                return typeof eng.getAntigravityInstallationStatus === "function" ? eng.getAntigravityInstallationStatus() : null;
            }, 2500, null),
        ]);
        const accounts = eng.listAccts({ secrets: false });
        const cursorAccounts = eng.listCursorAccts({ secrets: false });
        const antigravityAccounts = eng.listAntigravityAccts({ secrets: false });
        const currentAccountId = typeof eng.loadIdx === "function" ? eng.loadIdx()?.current_account_id : null;
        const currentCursorId = typeof eng.loadCursorIdx === "function"
            ? eng.loadCursorIdx()?.current_cursor_account_id
            : null;
        const currentAntigravityId = typeof eng.loadAntigravityIdx === "function"
            ? eng.loadAntigravityIdx()?.current_antigravity_account_id
            : null;
        return ok({
            accounts: accounts.map((account) => publicAccount(eng, account)),
            currentAccount: publicAccount(eng, listedCurrent(
                accounts,
                currentAccountId,
                typeof eng.loadAcct === "function" ? (id) => eng.loadAcct(id) : null,
            )),
            cursorAccounts: cursorAccounts.map((account) => publicCursorAccount(account)),
            currentCursorAccount: publicCursorAccount(listedCurrent(
                cursorAccounts,
                currentCursorId,
                typeof eng.loadCursorAcct === "function" ? (id) => eng.loadCursorAcct(id) : null,
            )),
            antigravityAccounts: antigravityAccounts.map((account) => publicAntigravityAccount(account)),
            currentAntigravityAccount: publicAntigravityAccount(listedCurrent(
                antigravityAccounts,
                currentAntigravityId,
                typeof eng.loadAntigravityAcct === "function" ? (id) => eng.loadAntigravityAcct(id) : null,
            )),
            daemon: {
                running: daemonTimer !== null,
                syncIntervalMinutes: daemonIntervalMinutes(),
                ...daemonRuntimeState,
            },
            config: typeof eng.loadAutoSwitchCfg === "function" ? eng.loadAutoSwitchCfg() : null,
            appInfo: updateService?.getAppInfo?.() || {
                name: APP_DISPLAY_NAME,
                version: app.getVersion(),
                releaseChannel: String(app.getVersion()).includes("-") ? "beta" : "stable",
                isPackaged: app.isPackaged,
                updateEnabled: false,
                repository: APP_GITHUB_URL,
            },
            oauthStatus: typeof eng.getOAuthStatus === "function" ? eng.getOAuthStatus() : null,
            cursorOAuthStatus: typeof eng.getCursorOAuthStatus === "function" ? eng.getCursorOAuthStatus() : null,
            antigravityOAuthStatus: typeof eng.getAntigravityOAuthStatus === "function" ? eng.getAntigravityOAuthStatus() : null,
            authState,
            authError,
            updateStatus: updateService?.getStatus?.() || {
                status: "disabled",
                enabled: false,
                channel: String(app.getVersion()).includes("-") ? "beta" : "stable",
                message: "Update service is not initialized",
            },
            storageDiagnostics: typeof eng.getStorageDiagnostics === "function" ? eng.getStorageDiagnostics() : [],
            codexStatus,
            cursorStatus,
            antigravityStatus,
        });
    });

    return { startDaemon, stopDaemon, runDaemon };
}

module.exports = { registerIpcHandlers, tokenRefreshResponse, inspectAuthStateWithBusyTimeout };
