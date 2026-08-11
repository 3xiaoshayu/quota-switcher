const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // 应用与发布
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getCodexStatus: () => ipcRenderer.invoke('codex:status'),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  getStorageDiagnostics: () => ipcRenderer.invoke('storage:diagnostics'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // 账号管理
  listAccounts: () => ipcRenderer.invoke('account:list'),
  getAccount: (id) => ipcRenderer.invoke('account:get', id),
  addAccount: () => ipcRenderer.invoke('account:add'),
  deleteAccount: (id) => ipcRenderer.invoke('account:delete', id),
  switchAccount: (id) => ipcRenderer.invoke('account:switch', id),
  getCurrentAccount: () => ipcRenderer.invoke('account:current'),
  getAuthState: () => ipcRenderer.invoke('account:authState'),
  adoptOfficialAccount: () => ipcRenderer.invoke('account:adoptOfficial'),
  reapplyManagedAccount: (id) => ipcRenderer.invoke('account:reapplyManaged', id),
  reauthorizeAccount: (id) => ipcRenderer.invoke('account:reauthorize', id),
  getOAuthStatus: () => ipcRenderer.invoke('oauth:status'),
  cancelOAuth: () => ipcRenderer.invoke('oauth:cancel'),
  completeOAuthManually: (callbackUrl) => ipcRenderer.invoke('oauth:completeManual', callbackUrl),

  // 配额
  refreshQuota: (id, force = true) => ipcRenderer.invoke('quota:refresh', id, force),
  refreshAllQuotas: () => ipcRenderer.invoke('quota:refreshAll'),

  // Token
  refreshToken: (id) => ipcRenderer.invoke('token:refresh', id),
  refreshAllTokens: (force) => ipcRenderer.invoke('token:refreshAll', force),
  getTokenStatus: (id) => ipcRenderer.invoke('token:status', id),

  // 自动切号
  getAutoSwitchConfig: () => ipcRenderer.invoke('autoswitch:config:get'),
  saveAutoSwitchConfig: (cfg) => ipcRenderer.invoke('autoswitch:config:save', cfg),
  runAutoSwitchTick: () => ipcRenderer.invoke('autoswitch:tick'),

  // 守护进程
  startDaemon: () => ipcRenderer.invoke('daemon:start'),
  stopDaemon: () => ipcRenderer.invoke('daemon:stop'),
  getDaemonStatus: () => ipcRenderer.invoke('daemon:status'),

  // 主进程推送事件
  onDaemonTick: (cb) => {
    const handler = (e, d) => cb(d);
    ipcRenderer.on('daemon:tick', handler);
    return () => ipcRenderer.removeListener('daemon:tick', handler);
  },
  onDaemonError: (cb) => {
    const handler = (e, d) => cb(d);
    ipcRenderer.on('daemon:error', handler);
    return () => ipcRenderer.removeListener('daemon:error', handler);
  },
  onAutoSwitch: (cb) => {
    const handler = (e, d) => cb(d);
    ipcRenderer.on('autoswitch:executed', handler);
    return () => ipcRenderer.removeListener('autoswitch:executed', handler);
  },
  onUpdateStatus: (cb) => {
    const handler = (e, d) => cb(d);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  onAuthConflict: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('auth:conflict', handler);
    return () => ipcRenderer.removeListener('auth:conflict', handler);
  },
};

contextBridge.exposeInMainWorld('codexDeskep', api);
contextBridge.exposeInMainWorld('codexAccountManager', api);
