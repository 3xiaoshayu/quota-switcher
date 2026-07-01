const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // 窗口控制
  closeWindow: () => ipcRenderer.invoke('window:close'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:maximize'),

  // 应用与发布
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getCodexStatus: () => ipcRenderer.invoke('codex:status'),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // 账号管理
  listAccounts: () => ipcRenderer.invoke('account:list'),
  getAccount: (id) => ipcRenderer.invoke('account:get', id),
  addAccount: () => ipcRenderer.invoke('account:add'),
  deleteAccount: (id) => ipcRenderer.invoke('account:delete', id),
  switchAccount: (id) => ipcRenderer.invoke('account:switch', id),
  getCurrentAccount: () => ipcRenderer.invoke('account:current'),

  // 配额
  refreshQuota: (id) => ipcRenderer.invoke('quota:refresh', id),
  refreshAllQuotas: () => ipcRenderer.invoke('quota:refreshAll'),

  // Token
  refreshToken: (id) => ipcRenderer.invoke('token:refresh', id),
  refreshAllTokens: (force) => ipcRenderer.invoke('token:refreshAll', force),
  getTokenStatus: (id) => ipcRenderer.invoke('token:status', id),

  // 重置额度
  consumeResetCredit: (id) => ipcRenderer.invoke('reset:consume', id),
  refreshSubscription: (id, force) => ipcRenderer.invoke('subscription:refresh', id, force),

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
};

contextBridge.exposeInMainWorld('codexDeskep', api);
contextBridge.exposeInMainWorld('codexAccountManager', api);
