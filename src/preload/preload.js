const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // 应用与发布
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  notifyUiReady: () => ipcRenderer.invoke('app:uiReady'),
  getCodexStatus: () => ipcRenderer.invoke('codex:status'),
  getCursorStatus: () => ipcRenderer.invoke('cursor:status'),
  getAntigravityStatus: () => ipcRenderer.invoke('antigravity:status'),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  getStorageDiagnostics: () => ipcRenderer.invoke('storage:diagnostics'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  showMainWindow: () => ipcRenderer.invoke('window:showMain'),
  showFloatWindow: (product) => ipcRenderer.invoke('float:show', product),
  hideFloatWindow: () => ipcRenderer.invoke('float:hide'),
  setFloatProduct: (product) => ipcRenderer.invoke('float:setProduct', product),
  setFloatAlwaysOnTop: (value) => ipcRenderer.invoke('float:setAlwaysOnTop', value),
  getFloatState: () => ipcRenderer.invoke('float:getState'),
  setFloatHeight: (height) => ipcRenderer.invoke('float:setHeight', height),

  // 账号管理
  listAccounts: () => ipcRenderer.invoke('account:list'),
  getAccount: (id) => ipcRenderer.invoke('account:get', id),
  addAccount: () => ipcRenderer.invoke('account:add'),
  deleteAccount: (id) => ipcRenderer.invoke('account:delete', id),
  switchAccount: (id) => ipcRenderer.invoke('account:switch', id),
  getCurrentAccount: () => ipcRenderer.invoke('account:current'),
  getAuthState: () => ipcRenderer.invoke('account:authState'),
  getDesktopSnapshot: (options) => ipcRenderer.invoke('desktop:snapshot', options),
  adoptOfficialAccount: () => ipcRenderer.invoke('account:adoptOfficial'),
  reapplyManagedAccount: (id) => ipcRenderer.invoke('account:reapplyManaged', id),
  reauthorizeAccount: (id) => ipcRenderer.invoke('account:reauthorize', id),
  getOAuthStatus: () => ipcRenderer.invoke('oauth:status'),
  cancelOAuth: () => ipcRenderer.invoke('oauth:cancel'),
  completeOAuthManually: (callbackUrl) => ipcRenderer.invoke('oauth:completeManual', callbackUrl),
  listCursorAccounts: (options) => ipcRenderer.invoke('cursor:list', options),
  getCurrentCursorAccount: (options) => ipcRenderer.invoke('cursor:current', options),
  importLocalCursorAccount: () => ipcRenderer.invoke('cursor:importLocal'),
  addCursorAccount: () => ipcRenderer.invoke('cursor:add'),
  reauthorizeCursorAccount: (id) => ipcRenderer.invoke('cursor:reauthorize', id),
  getCursorOAuthStatus: () => ipcRenderer.invoke('cursor:oauthStatus'),
  cancelCursorOAuth: () => ipcRenderer.invoke('cursor:oauthCancel'),
  deleteCursorAccount: (id) => ipcRenderer.invoke('cursor:delete', id),
  switchCursorAccount: (id) => ipcRenderer.invoke('cursor:switch', id),
  refreshCursorQuota: (id, force = true) => ipcRenderer.invoke('cursor:refreshQuota', id, force),
  refreshAllCursorQuotas: () => ipcRenderer.invoke('cursor:refreshAllQuotas'),
  refreshCursorToken: (id) => ipcRenderer.invoke('cursor:refreshToken', id),
  refreshAllCursorTokens: (force = false) => ipcRenderer.invoke('cursor:refreshAllTokens', force),
  listAntigravityAccounts: (options) => ipcRenderer.invoke('antigravity:list', options),
  getCurrentAntigravityAccount: (options) => ipcRenderer.invoke('antigravity:current', options),
  importLocalAntigravityAccount: () => ipcRenderer.invoke('antigravity:importLocal'),
  addAntigravityAccount: () => ipcRenderer.invoke('antigravity:add'),
  reauthorizeAntigravityAccount: (id) => ipcRenderer.invoke('antigravity:reauthorize', id),
  getAntigravityOAuthStatus: () => ipcRenderer.invoke('antigravity:oauthStatus'),
  cancelAntigravityOAuth: () => ipcRenderer.invoke('antigravity:oauthCancel'),
  deleteAntigravityAccount: (id) => ipcRenderer.invoke('antigravity:delete', id),
  switchAntigravityAccount: (id) => ipcRenderer.invoke('antigravity:switch', id),
  refreshAntigravityQuota: (id, force = true) => ipcRenderer.invoke('antigravity:refreshQuota', id, force),
  refreshAllAntigravityQuotas: () => ipcRenderer.invoke('antigravity:refreshAllQuotas'),
  refreshAntigravityToken: (id) => ipcRenderer.invoke('antigravity:refreshToken', id),
  refreshAllAntigravityTokens: (force = false) => ipcRenderer.invoke('antigravity:refreshAllTokens', force),

  // 配额
  refreshQuota: (id, force = true) => ipcRenderer.invoke('quota:refresh', id, force),
  refreshAllQuotas: () => ipcRenderer.invoke('quota:refreshAll'),

  // Token
  refreshToken: (id) => ipcRenderer.invoke('token:refresh', id),
  refreshAllTokens: (force) => ipcRenderer.invoke('token:refreshAll', force),
  getTokenStatus: (id) => ipcRenderer.invoke('token:status', id),

  // 守护进程
  getDaemonConfig: () => ipcRenderer.invoke('daemon:config:get'),
  saveDaemonConfig: (cfg) => ipcRenderer.invoke('daemon:config:save', cfg),
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
  onFloatProduct: (cb) => {
    const handler = (_event, product) => cb(product);
    ipcRenderer.on('float:product', handler);
    return () => ipcRenderer.removeListener('float:product', handler);
  },
  onQuotaUpdated: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('quota:updated', handler);
    return () => ipcRenderer.removeListener('quota:updated', handler);
  },
  onAccountUpdated: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('account:updated', handler);
    return () => ipcRenderer.removeListener('account:updated', handler);
  },
};

contextBridge.exposeInMainWorld('codexDeskep', api);
contextBridge.exposeInMainWorld('codexAccountManager', api);
