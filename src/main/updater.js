function getReleaseChannel(version) {
  return String(version || "").includes("-") ? "beta" : "stable";
}

function createUpdateService({ app, BrowserWindow }) {
  let autoUpdater = null;
  let updaterLoadError = null;

  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (error) {
    updaterLoadError = error;
  }

  const appInfo = {
    name: "Codex Account Manager",
    version: app.getVersion(),
    releaseChannel: getReleaseChannel(app.getVersion()),
    isPackaged: app.isPackaged,
    repository: "https://github.com/3xiaoshayu/codex-account-manager",
  };

  const updateEnabled = !!autoUpdater && app.isPackaged && appInfo.releaseChannel === "stable";
  let status = {
    status: updateEnabled ? "idle" : "disabled",
    enabled: updateEnabled,
    channel: appInfo.releaseChannel,
    percent: null,
    version: null,
    error: updaterLoadError ? updaterLoadError.message : null,
    message: updateEnabled
      ? "可检查更新"
      : (appInfo.releaseChannel === "beta" ? "Beta 阶段使用 Releases 手动更新" : "更新服务仅在正式安装包中启用"),
    updatedAt: Date.now(),
  };

  function publicStatus() {
    return { ...status };
  }

  function setStatus(patch) {
    status = { ...status, ...patch, updatedAt: Date.now() };
    BrowserWindow.getAllWindows()
      .forEach((win) => win.webContents.send("update:status", publicStatus()));
    return publicStatus();
  }

  if (autoUpdater) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("checking-for-update", () => setStatus({
      status: "checking",
      error: null,
      message: "正在检查更新",
    }));
    autoUpdater.on("update-available", (info) => setStatus({
      status: "available",
      version: info?.version || null,
      error: null,
      message: info?.version ? `发现 ${info.version}` : "发现新版本",
    }));
    autoUpdater.on("download-progress", (progress) => setStatus({
      status: "downloading",
      percent: Number.isFinite(progress?.percent) ? Math.round(progress.percent) : null,
      error: null,
      message: "正在下载更新",
    }));
    autoUpdater.on("update-downloaded", (info) => setStatus({
      status: "downloaded",
      version: info?.version || status.version,
      percent: 100,
      error: null,
      message: "更新已下载，重启后安装",
    }));
    autoUpdater.on("update-not-available", () => setStatus({
      status: "not-available",
      percent: null,
      error: null,
      message: "当前已是最新版本",
    }));
    autoUpdater.on("error", (error) => setStatus({
      status: "error",
      error: error?.message || String(error),
      message: "检查更新失败",
    }));
  }

  async function checkForUpdates() {
    if (!updateEnabled) return publicStatus();
    setStatus({ status: "checking", error: null, message: "正在检查更新" });
    await autoUpdater.checkForUpdates();
    return publicStatus();
  }

  function installUpdate() {
    if (!updateEnabled || status.status !== "downloaded") return publicStatus();
    autoUpdater.quitAndInstall(false, true);
    return publicStatus();
  }

  function startAutoCheck() {
    if (!updateEnabled) return;
    setTimeout(() => {
      checkForUpdates().catch((error) => {
        setStatus({
          status: "error",
          error: error?.message || String(error),
          message: "自动检查更新失败",
        });
      });
    }, 4000);
  }

  return {
    getAppInfo: () => ({ ...appInfo, updateEnabled }),
    getStatus: publicStatus,
    checkForUpdates,
    installUpdate,
    startAutoCheck,
  };
}

module.exports = {
  createUpdateService,
  getReleaseChannel,
};
