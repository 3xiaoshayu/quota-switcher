// Codex Deskep — 应用入口
// 在 sandboxed 浏览器环境中，所有模块通过 App 全局命名空间访问

window.App = window.App || {};

(function() {
  var API = App.API;

  function init() {
    // 主题
    App.Theme.init();

    // 标题栏
    App.Titlebar.render(document.getElementById('app'));

    // 侧边栏
    App.Sidebar.render(document.getElementById('app'));

    // 注册所有视图到路由
    var R = App.Router;
    R.register('accounts', App.Views.Accounts);
    R.register('detail', App.Views.AccountDetail);
    R.register('quota', App.Views.QuotaMonitor);
    R.register('autoswitch', App.Views.AutoSwitch);
    R.register('settings', App.Views.Settings);

    // 初始数据加载
    loadInitialData();

    // 启动路由
    R.init();

    // 守护进程事件
    try {
      API.onDaemonTick(function(data) {
        loadInitialData();
      });
      API.onDaemonError(function(data) {
        console.error('[daemon:error]', data);
      });
      API.onAutoSwitch(function(data) {
        if (data && data.switched) {
          App.Toast.warning('自动切换: ' + (data.from ? data.from.email : '?') + ' → ' + (data.to ? data.to.email : '?'));
          loadInitialData();
        }
      });
    } catch(e) {
      console.warn('Daemon events not available:', e.message);
    }

    console.log('Codex Deskep v1.0.0 — 就绪');
  }

  async function loadInitialData() {
    try {
      var r = await API.listAccounts();
      if (r && r.success && Array.isArray(r.data)) { App.State.set('accounts', r.data); }
    } catch(e) {}
    try {
      var cur = await API.getCurrentAccount();
      if (cur && cur.success && cur.data) { App.State.set('currentAccount', cur.data); }
    } catch(e) {}
    try {
      var cfg = await API.getAutoSwitchConfig();
      if (cfg && cfg.success && cfg.data) { App.State.set('autoSwitchCfg', cfg.data); }
    } catch(e) {}
    try {
      var ds = await API.getDaemonStatus();
      if (ds && ds.success && ds.data) { App.State.set('daemonRunning', ds.data.running || false); }
    } catch(e) {}
  }

  // Escape 关闭模态
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { App.Modal.hide(); }
  });

  // DOM Ready
  document.addEventListener('DOMContentLoaded', init);
})();
