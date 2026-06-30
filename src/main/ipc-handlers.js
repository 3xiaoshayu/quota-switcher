const path = require("node:path");
let engine = null;

function getEngine() {
    if (!engine) {
        engine = require(path.resolve(__dirname, "..", "..", "engine"));
    }
    return engine;
}

function ok(data) { return { success: true, data }; }
function fail(msg) { return { success: false, error: String(msg) }; }

function loadAcctById(eng, id) {
    if (!id) return null;
    let a = eng.loadAcct(id);
    if (a) return a;
    return eng.listAccts().find(x => x.email === id || x.id === id) || null;
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
        requires_reauth: !!account.requires_reauth,
        reauth_reason: account.reauth_reason || null,
        quota: publicQuota(account.quota),
        quota_error: account.quota_error ? {
            code: account.quota_error.code || null,
            message: account.quota_error.message || String(account.quota_error),
            timestamp: account.quota_error.timestamp || null,
        } : null,
        reset_credits: account.reset_credits ? {
            available_count: account.reset_credits.available_count || 0,
            next_expires_at: account.reset_credits.next_expires_at || null,
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

// ═══════════════ 注册所有 IPC ═══════════════
function registerIpcHandlers(engineInstance = null, services = {}) {
    const { ipcMain, BrowserWindow, app } = require("electron");
    if (engineInstance) engine = engineInstance;
    const eng = engineInstance || getEngine();
    const updateService = services.updateService || null;

    // 窗口
    ipcMain.handle("window:close", () => BrowserWindow.getFocusedWindow()?.close());
    ipcMain.handle("window:minimize", () => BrowserWindow.getFocusedWindow()?.minimize());
    ipcMain.handle("window:maximize", () => {
        const w = BrowserWindow.getFocusedWindow();
        if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
    });

    // 应用与发布状态
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
        message: "更新服务未初始化",
    }));

    ipcMain.handle("update:check", async () => {
        try {
            return ok(updateService ? await updateService.checkForUpdates() : null);
        } catch (e) { return fail(e.message); }
    });

    ipcMain.handle("update:install", () => {
        try {
            return ok(updateService ? updateService.installUpdate() : null);
        } catch (e) { return fail(e.message); }
    });

    ipcMain.handle("codex:status", () => {
        try {
            return ok(eng.getCodexInstallationStatus());
        } catch (e) { return fail(e.message); }
    });

    // 账号列表 — 直接返回 account 对象数组
    ipcMain.handle("account:list", () => {
        const accts = eng.listAccts();
        return ok(accts.map((account) => publicAccount(eng, account)));
    });

    ipcMain.handle("account:current", () => ok(publicAccount(eng, eng.currentAcct())));

    ipcMain.handle("account:get", (e, id) => {
        const a = eng.loadAcct(id);
        return a ? ok(publicAccount(eng, a)) : fail("账号不存在");
    });

    // OAuth 登录 — 打开浏览器 + 监听回调
    ipcMain.handle("account:add", async () => {
        try {
            const acct = await eng.oauthLoginFlow();
            if (!acct) return fail("登录已取消");
            eng.doSwitch(acct);
            return ok(publicAccount(eng, acct));
        } catch (e) { return fail(e.message); }
    });

    // 删除
    ipcMain.handle("account:delete", (e, id) => {
        try {
            const a = loadAcctById(eng, id);
            if (!a) return fail("账号不存在");
            const idx = eng.loadIdx();
            idx.accounts = idx.accounts.filter(x => x.id !== a.id);
            if (idx.current_account_id === a.id) idx.current_account_id = null;
            eng.saveIdx(idx);
            eng.deleteAcct(a.id);
            return ok(true);
        } catch (e) { return fail(e.message); }
    });

    // 切换
    ipcMain.handle("account:switch", (e, id) => {
        try {
            const a = loadAcctById(eng, id);
            if (!a) return fail("账号不存在: " + id);
            const result = eng.doSwitch(a);
            return ok({ ...result, account: publicAccount(eng, result.account) });
        } catch (e) { return fail(e.message); }
    });

    // 配额
    ipcMain.handle("quota:refresh", async (e, id) => {
        try {
            const a = loadAcctById(eng, id);
            if (!a) return fail("账号不存在");
            const q = await eng.refreshQuota(a);
            return ok(publicQuota(q));
        } catch (e) { return fail(e.message); }
    });

    ipcMain.handle("quota:refreshAll", async () => {
        const r = [];
        for (const a of eng.listAccts()) {
            try { r.push({ id: a.id, email: a.email, quota: publicQuota(await eng.refreshQuota(a)) }); }
            catch (e) { r.push({ id: a.id, email: a.email, error: e.message }); }
        }
        return ok(r);
    });

    // Token
    ipcMain.handle("token:refresh", async (e, id) => {
        try { const a = loadAcctById(eng, id); if (!a) return fail("账号不存在"); return ok(await eng.refreshOneTok(a)); }
        catch (e) { return fail(e.message); }
    });
    ipcMain.handle("token:refreshAll", async (e, force) => {
        try { return ok(await eng.refreshAll(!!force)); } catch (e) { return fail(e.message); }
    });
    ipcMain.handle("token:status", (e, id) => {
        const a = loadAcctById(eng, id);
        if (!a || !a.tokens?.access_token) return ok({ expired: true, refreshAvailable: false });
        const exp = eng.jwtExp(a.tokens.access_token);
        return ok({ expired: eng.isTokenExpired(a.tokens.access_token), refreshAvailable: !!a.tokens.refresh_token, expiryDate: exp, timeLeft: exp ? (exp - eng.ts()) : null });
    });

    // 重置额度
    ipcMain.handle("reset:fetch", async (e, id) => {
        try { const a = loadAcctById(eng, id); if (!a) return fail("账号不存在"); const s = await eng.fetchResetCredits(a); a.reset_credits = s; eng.saveAcct(a); return ok(s); }
        catch (e) { return fail(e.message); }
    });
    ipcMain.handle("reset:consume", async (e, id) => {
        try { const a = loadAcctById(eng, id); if (!a) return fail("账号不存在"); await eng.consumeResetCredit(a); return ok(true); }
        catch (e) { return fail(e.message); }
    });

    // 订阅
    ipcMain.handle("subscription:refresh", async (e, id, force) => {
        try { const a = loadAcctById(eng, id); if (!a) return fail("账号不存在"); const changed = await eng.refreshSubscription(a, !!force); return ok({ changed, plan_type: a.plan_type, subscription_active_until: a.subscription_active_until }); }
        catch (e) { return fail(e.message); }
    });

    // 自动切号
    ipcMain.handle("autoswitch:config:get", () => ok(eng.loadAutoSwitchCfg()));
    ipcMain.handle("autoswitch:config:save", (e, cfg) => { try { eng.saveAutoSwitchCfg(cfg); return ok(true); } catch (e) { return fail(e.message); } });
    ipcMain.handle("autoswitch:tick", async () => { try { return ok(publicAutoSwitchResult(eng, await eng.autoSwitchTick(eng.loadAutoSwitchCfg()))); } catch (e) { return fail(e.message); } });

    // 守护进程
    let daemonTimer = null;

    const runDaemon = async () => {
        try {
            const result = await eng.runDaemonWorker();
            const safeResult = {
                ...result,
                autoSwitchResult: publicAutoSwitchResult(eng, result.autoSwitchResult),
            };
            BrowserWindow.getAllWindows().forEach(w => w.webContents.send("daemon:tick", { ts: Date.now(), result: safeResult }));
            if (safeResult.autoSwitchResult?.switched) {
                BrowserWindow.getAllWindows().forEach(w => w.webContents.send("autoswitch:executed", safeResult.autoSwitchResult));
            }
        } catch (error) {
            BrowserWindow.getAllWindows().forEach(w => w.webContents.send("daemon:error", { message: error.message }));
        }
    };

    const startDaemon = () => {
        if (daemonTimer) return ok("已在运行");
        daemonTimer = setInterval(runDaemon, eng.getTickIntervalMs());
        return ok("已启动");
    };

    const stopDaemon = () => {
        if (!daemonTimer) return ok("未运行");
        clearInterval(daemonTimer); daemonTimer = null;
        return ok("已停止");
    };

    ipcMain.handle("daemon:start", startDaemon);
    ipcMain.handle("daemon:stop", stopDaemon);
    ipcMain.handle("daemon:status", () => ok({ running: daemonTimer !== null }));

    return { startDaemon, stopDaemon };
}

module.exports = { registerIpcHandlers };
