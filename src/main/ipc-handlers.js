const path = require("node:path");
let engine = null;

function getEngine() {
    if (!engine) engine = require(path.resolve(__dirname, "..", "..", "engine"));
    return engine;
}

function ok(data) { return { success: true, data }; }
function fail(message) { return { success: false, error: String(message) }; }

function tokenRefreshResponse(result) {
    return result?.ok ? ok(result) : fail(result?.error || "Token refresh failed");
}

function reauthorizationRequiredMessage(operation) {
    return `Account requires reauthorization before ${operation}.`;
}

function loadAcctById(eng, id) {
    if (!id) return null;
    try {
        const account = eng.loadAcct(id);
        if (account) return account;
    } catch {}
    return eng.listAccts().find(account => account.email === id || account.id === id) || null;
}

function publicQuota(eng, quota) {
    if (!quota) return null;
    // Re-classify windows saved by older versions before stripping raw data.
    const normalized = typeof eng.normalizeQuota === "function" ? eng.normalizeQuota(quota) : quota;
    const { raw_data, ...safeQuota } = normalized;
    return safeQuota;
}

function publicAccount(eng, account) {
    if (!account) return null;
    const accessToken = account.tokens?.access_token || null;
    const expiryDate = accessToken ? eng.jwtExp(accessToken) : null;
    const issuedAt = accessToken ? (eng.jwtPayload(accessToken)?.iat ?? null) : null;
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
        quota: publicQuota(eng, account.quota),
        quota_error: account.quota_error ? {
            code: account.quota_error.code || null,
            message: account.quota_error.message || String(account.quota_error),
            timestamp: account.quota_error.timestamp || null,
        } : null,
        token_status: {
            accessAvailable: !!accessToken,
            refreshAvailable: !!account.tokens?.refresh_token,
            expired: accessToken ? eng.isTokenExpired(accessToken) : true,
            expiryDate,
            issuedAt: typeof issuedAt === "number" ? issuedAt : null,
            timeLeft: expiryDate ? expiryDate - eng.ts() : null,
        },
    };
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

function registerIpcHandlers(engineInstance = null, services = {}) {
    const { ipcMain, BrowserWindow, app, shell } = services.electron || require("electron");
    if (engineInstance) engine = engineInstance;
    const eng = engineInstance || getEngine();
    const updateService = services.updateService || null;
    const setDaemonInterval = services.setInterval || setInterval;
    const clearDaemonInterval = services.clearInterval || clearInterval;
    const trustedWebContentsId = Number.isInteger(services.trustedWebContentsId)
        ? services.trustedWebContentsId
        : null;
    const isTrustedSender = (event) => {
        if (trustedWebContentsId == null) return true;
        return event?.sender?.id === trustedWebContentsId;
    };
    const handle = (channel, listener) => {
        ipcMain.handle(channel, async (event, ...args) => {
            if (!isTrustedSender(event)) return fail("Untrusted IPC sender");
            try {
                return await listener(event, ...args);
            } catch (error) {
                return fail(error?.message || error);
            }
        });
    };

    handle("app:info", () => ok(updateService?.getAppInfo?.() || {
        name: "Codex Account Manager",
        version: app.getVersion(),
        releaseChannel: String(app.getVersion()).includes("-") ? "beta" : "stable",
        isPackaged: app.isPackaged,
        updateEnabled: false,
        repository: "https://github.com/3xiaoshayu/codex-account-manager",
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
    handle("storage:diagnostics", () => ok(eng.getStorageDiagnostics()));

    handle("codex:status", () => {
        try { return ok(eng.getCodexInstallationStatus()); }
        catch (error) { return fail(error.message); }
    });

    handle("account:list", () => ok(eng.listAccts().map(account => publicAccount(eng, account))));
    handle("account:current", () => ok(publicAccount(eng, eng.currentAcct())));
    handle("account:get", (event, id) => {
        const account = eng.loadAcct(id);
        return account ? ok(publicAccount(eng, account)) : fail("Account does not exist");
    });
    handle("account:authState", () => {
        try { return ok(eng.inspectAuthState()); }
        catch (error) { return fail(error.message); }
    });
    handle("account:adoptOfficial", () => {
        try { return ok(publicAccount(eng, eng.adoptOfficialAuth())); }
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
            const target = loadAcctById(eng, id);
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
            return await withFreshAccount(eng, id, async account => {
                return ok(eng.deleteAcct(account.id, { allowCurrent: false }));
            });
        } catch (error) { return fail(error.message); }
    });
    handle("account:switch", async (event, id) => {
        try {
            return await eng.withAccountLocks(["__switch__", id], async () => {
                const account = loadAcctById(eng, id);
                if (!account) return fail("Account does not exist");
                const result = await eng.doSwitch(account);
                return ok({ ...result, account: publicAccount(eng, result.account) });
            });
        } catch (error) { return fail(error.message); }
    });

    handle("quota:refresh", async (event, id, force = true) => {
        try {
            if (force === false) {
                const authState = eng.inspectAuthState({ migrateProjection: false });
                if (authState.requiresResolution) {
                    return fail(authState.message || "Automatic quota sync is paused until authentication is resolved");
                }
            }
            return await withFreshAccount(eng, id, async account => {
                if (account.requires_reauth) {
                    return fail(reauthorizationRequiredMessage("quotas can be refreshed"));
                }
                const quota = await eng.refreshQuota(account, { force: force !== false });
                return ok(publicQuota(eng, quota));
            });
        } catch (error) { return fail(error.message); }
    });
    handle("quota:refreshAll", async () => {
        const results = [];
        for (const listed of eng.listAccts()) {
            try {
                await eng.withAccountLock(listed.id, async () => {
                    const account = eng.loadAcct(listed.id);
                    if (!account) return;
                    if (account.requires_reauth) {
                        results.push({
                            id: account.id,
                            email: account.email,
                            skipped: true,
                            reason: "reauthorization_required",
                        });
                        return;
                    }
                    const quota = await eng.refreshQuota(account, { force: true });
                    results.push({ id: account.id, email: account.email, quota: publicQuota(eng, quota) });
                });
            } catch (error) {
                results.push({ id: listed.id, email: listed.email, error: error.message });
            }
        }
        return ok(results);
    });

    handle("token:refresh", async (event, id) => {
        try {
            return await withFreshAccount(eng, id, async account => {
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
            BrowserWindow.getAllWindows().forEach(window => window.webContents.send("daemon:tick", {
                ts: Date.now(),
                result: safeResult,
            }));
            if (safeResult.autoSwitchResult?.switched) {
                BrowserWindow.getAllWindows().forEach(window => window.webContents.send("autoswitch:executed", safeResult.autoSwitchResult));
            }
            if (safeResult.pausedReason === "auth_conflict") {
                BrowserWindow.getAllWindows().forEach(window => window.webContents.send("auth:conflict", safeResult.authState));
            }
            if (safeResult.failures?.length) {
                BrowserWindow.getAllWindows().forEach(window => window.webContents.send("daemon:error", {
                    message: safeResult.failures.map(item => item.message).join("; "),
                    failures: safeResult.failures,
                }));
            }
        } catch (error) {
            if (runGeneration !== daemonGeneration) return;
            daemonRuntimeState.lastRunAt = Date.now();
            daemonRuntimeState.lastError = error.message;
            BrowserWindow.getAllWindows().forEach(window => window.webContents.send("daemon:error", { message: error.message }));
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
            eng.saveAutoSwitchCfg(config);
            if (daemonIntervalMinutes() !== previousInterval) reloadDaemonTimer();
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

    return { startDaemon, stopDaemon, runDaemon };
}

module.exports = { registerIpcHandlers, tokenRefreshResponse };
