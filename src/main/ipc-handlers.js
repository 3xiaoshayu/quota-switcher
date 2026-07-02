const path = require("node:path");
let engine = null;

function getEngine() {
    if (!engine) engine = require(path.resolve(__dirname, "..", "..", "engine"));
    return engine;
}

function ok(data) { return { success: true, data }; }
function fail(message) { return { success: false, error: String(message) }; }

function loadAcctById(eng, id) {
    if (!id) return null;
    return eng.loadAcct(id) || eng.listAccts().find(account => account.email === id || account.id === id) || null;
}

function publicQuota(quota) {
    if (!quota) return null;
    const { raw_data, ...safeQuota } = quota;
    return safeQuota;
}

function publicAccount(eng, account) {
    if (!account) return null;
    const accessToken = account.tokens?.access_token || null;
    const expiryDate = accessToken ? eng.jwtExp(accessToken) : null;
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
        quota: publicQuota(account.quota),
        quota_error: account.quota_error ? {
            code: account.quota_error.code || null,
            message: account.quota_error.message || String(account.quota_error),
            timestamp: account.quota_error.timestamp || null,
        } : null,
        reset_credits: account.reset_credits ? {
            available_count: account.reset_credits.available_count ?? 0,
            next_expires_at: account.reset_credits.next_expires_at || null,
        } : null,
        reset_credits_error: account.reset_credits_error ? {
            message: account.reset_credits_error.message || String(account.reset_credits_error),
            timestamp: account.reset_credits_error.timestamp || null,
        } : null,
        token_status: {
            accessAvailable: !!accessToken,
            refreshAvailable: !!account.tokens?.refresh_token,
            expired: accessToken ? eng.isTokenExpired(accessToken) : true,
            expiryDate,
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
    const { ipcMain, BrowserWindow, app, shell } = require("electron");
    if (engineInstance) engine = engineInstance;
    const eng = engineInstance || getEngine();
    const updateService = services.updateService || null;

    ipcMain.handle("app:info", () => ok(updateService?.getAppInfo?.() || {
        name: "Codex Account Manager",
        version: app.getVersion(),
        releaseChannel: String(app.getVersion()).includes("-") ? "beta" : "stable",
        isPackaged: app.isPackaged,
        updateEnabled: false,
        repository: "https://github.com/3xiaoshayu/codex-account-manager",
    }));
    ipcMain.handle("update:status", () => ok(updateService?.getStatus?.() || {
        status: "disabled",
        enabled: false,
        channel: String(app.getVersion()).includes("-") ? "beta" : "stable",
        message: "Update service is not initialized",
    }));
    ipcMain.handle("update:check", async () => {
        try { return ok(updateService ? await updateService.checkForUpdates() : null); }
        catch (error) { return fail(error.message); }
    });
    ipcMain.handle("update:install", () => {
        try { return ok(updateService ? updateService.installUpdate() : null); }
        catch (error) { return fail(error.message); }
    });
    ipcMain.handle("app:openExternal", async (event, url) => {
        try {
            const target = String(url || "");
            if (!/^https?:\/\//i.test(target)) return fail("Unsupported external URL");
            await shell.openExternal(target);
            return ok(true);
        } catch (error) { return fail(error.message); }
    });
    ipcMain.handle("app:openLogs", async () => {
        try {
            const error = await shell.openPath(eng.getLogDir());
            return error ? fail(error) : ok(true);
        } catch (openError) { return fail(openError.message); }
    });
    ipcMain.handle("storage:diagnostics", () => ok(eng.getStorageDiagnostics()));

    ipcMain.handle("codex:status", () => {
        try { return ok(eng.getCodexInstallationStatus()); }
        catch (error) { return fail(error.message); }
    });

    ipcMain.handle("account:list", () => ok(eng.listAccts().map(account => publicAccount(eng, account))));
    ipcMain.handle("account:current", () => ok(publicAccount(eng, eng.currentAcct())));
    ipcMain.handle("account:get", (event, id) => {
        const account = eng.loadAcct(id);
        return account ? ok(publicAccount(eng, account)) : fail("Account does not exist");
    });
    ipcMain.handle("account:authState", () => {
        try { return ok(eng.inspectAuthState()); }
        catch (error) { return fail(error.message); }
    });
    ipcMain.handle("account:adoptOfficial", () => {
        try { return ok(publicAccount(eng, eng.adoptOfficialAuth())); }
        catch (error) { return fail(error.message); }
    });
    ipcMain.handle("account:reapplyManaged", async (event, id) => {
        try {
            const result = await eng.reapplyManagedAuth(id || null);
            return ok({ ...result, account: publicAccount(eng, result.account) });
        } catch (error) { return fail(error.message); }
    });

    ipcMain.handle("account:add", async () => {
        try {
            const result = await eng.oauthLoginFlow();
            return ok({
                account: publicAccount(eng, result.account),
                mismatch: !!result.mismatch,
                targetAccountId: result.targetAccountId || null,
            });
        } catch (error) { return fail(error.message); }
    });
    ipcMain.handle("account:reauthorize", async (event, id) => {
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
    ipcMain.handle("oauth:status", () => ok(eng.getOAuthStatus()));
    ipcMain.handle("oauth:cancel", () => {
        try { return ok(eng.cancelOAuth()); }
        catch (error) { return fail(error.message); }
    });
    ipcMain.handle("oauth:completeManual", (event, callbackUrl) => {
        try { return ok(eng.completeOAuthManually(callbackUrl)); }
        catch (error) { return fail(error.message); }
    });

    ipcMain.handle("account:delete", async (event, id) => {
        try {
            return await withFreshAccount(eng, id, async account => {
                const index = eng.loadIdx();
                if (index.current_account_id === account.id) {
                    return fail("Switch to another account before deleting the current account.");
                }
                index.accounts = index.accounts.filter(item => item.id !== account.id);
                eng.saveIdx(index);
                eng.deleteAcct(account.id);
                return ok(true);
            });
        } catch (error) { return fail(error.message); }
    });
    ipcMain.handle("account:switch", async (event, id) => {
        try {
            return await eng.withAccountLocks(["__switch__", id], async () => {
                const account = loadAcctById(eng, id);
                if (!account) return fail("Account does not exist");
                const result = await eng.doSwitch(account);
                return ok({ ...result, account: publicAccount(eng, result.account) });
            });
        } catch (error) { return fail(error.message); }
    });

    ipcMain.handle("quota:refresh", async (event, id, force = true) => {
        try {
            return await withFreshAccount(eng, id, async account => {
                const quota = await eng.refreshQuota(account, { force: force !== false });
                return ok(publicQuota(quota));
            });
        } catch (error) { return fail(error.message); }
    });
    ipcMain.handle("quota:refreshAll", async () => {
        const results = [];
        for (const listed of eng.listAccts()) {
            try {
                await eng.withAccountLock(listed.id, async () => {
                    const account = eng.loadAcct(listed.id);
                    if (!account) return;
                    const quota = await eng.refreshQuota(account, { force: true });
                    results.push({ id: account.id, email: account.email, quota: publicQuota(quota) });
                });
            } catch (error) {
                results.push({ id: listed.id, email: listed.email, error: error.message });
            }
        }
        return ok(results);
    });

    ipcMain.handle("token:refresh", async (event, id) => {
        try { return await withFreshAccount(eng, id, async account => ok(await eng.refreshOneTok(account))); }
        catch (error) { return fail(error.message); }
    });
    ipcMain.handle("token:refreshAll", async (event, force) => {
        try { return ok(await eng.refreshAll(!!force)); }
        catch (error) { return fail(error.message); }
    });
    ipcMain.handle("token:status", (event, id) => {
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
    ipcMain.handle("reset:consume", async (event, id) => {
        try {
            return await withFreshAccount(eng, id, async account => {
                await eng.consumeResetCredit(account);
                return ok(true);
            });
        } catch (error) { return fail(error.message); }
    });
    ipcMain.handle("subscription:refresh", async (event, id, force) => {
        try {
            return await withFreshAccount(eng, id, async account => {
                const changed = await eng.refreshSubscription(account, !!force);
                return ok({
                    changed,
                    plan_type: account.plan_type,
                    subscription_active_until: account.subscription_active_until,
                });
            });
        } catch (error) { return fail(error.message); }
    });

    let daemonTimer = null;
    let daemonInFlight = false;
    const daemonRuntimeState = {
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: null,
        pausedReason: null,
    };
    const daemonIntervalMinutes = () => typeof eng.getTickIntervalMinutes === "function"
        ? eng.getTickIntervalMinutes()
        : Math.max(1, Math.round(eng.getTickIntervalMs() / 60000));

    const runDaemon = async () => {
        if (daemonInFlight) return;
        daemonInFlight = true;
        try {
            const result = await eng.runDaemonWorker();
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
            daemonRuntimeState.lastRunAt = Date.now();
            daemonRuntimeState.lastError = error.message;
            BrowserWindow.getAllWindows().forEach(window => window.webContents.send("daemon:error", { message: error.message }));
        } finally {
            daemonInFlight = false;
        }
    };

    const startDaemonTimer = () => {
        daemonTimer = setInterval(runDaemon, eng.getTickIntervalMs());
    };
    const restartDaemonTimer = () => {
        if (!daemonTimer) return;
        clearInterval(daemonTimer);
        startDaemonTimer();
    };
    const startDaemon = () => {
        if (daemonTimer) return ok("Already running");
        startDaemonTimer();
        void runDaemon();
        return ok("Started");
    };
    const stopDaemon = () => {
        if (!daemonTimer) return ok("Not running");
        clearInterval(daemonTimer);
        daemonTimer = null;
        return ok("Stopped");
    };

    ipcMain.handle("autoswitch:config:get", () => ok(eng.loadAutoSwitchCfg()));
    ipcMain.handle("autoswitch:config:save", (event, config) => {
        try {
            eng.saveAutoSwitchCfg(config);
            restartDaemonTimer();
            return ok(true);
        } catch (error) { return fail(error.message); }
    });
    ipcMain.handle("autoswitch:tick", async () => {
        try { return ok(publicAutoSwitchResult(eng, await eng.autoSwitchTick(eng.loadAutoSwitchCfg()))); }
        catch (error) { return fail(error.message); }
    });
    ipcMain.handle("daemon:start", startDaemon);
    ipcMain.handle("daemon:stop", stopDaemon);
    ipcMain.handle("daemon:status", () => ok({
        running: daemonTimer !== null,
        syncIntervalMinutes: daemonIntervalMinutes(),
        ...daemonRuntimeState,
    }));

    return { startDaemon, stopDaemon, runDaemon };
}

module.exports = { registerIpcHandlers };
