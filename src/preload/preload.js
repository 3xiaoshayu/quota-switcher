const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexDeskep', {
  // 窗口控制
  closeWindow: () => ipcRenderer.invoke('window:close'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:maximize'),

  // 主题

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
  fetchResetCredits: (id) => ipcRenderer.invoke('reset:fetch', id),
  consumeResetCredit: (id) => ipcRenderer.invoke('reset:consume', id),

  // 订阅
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
});
