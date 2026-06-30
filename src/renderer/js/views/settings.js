window.App = window.App || {};
App.Views = App.Views || {};

App.Views.Settings = (function() {
  async function render(container) {
    container.innerHTML = '';
    container.appendChild(App.el('div', { className: 'settings-page' },
      App.el('h2', { className: 'settings-title' }, '设置')
    ));
    var page = container.querySelector('.settings-page');

    // 外观
    page.appendChild(App.el('div', { className: 'setting-group' },
      App.el('div', { className: 'setting-group-label' }, '外观'),
      App.el('div', { className: 'setting-row' },
        App.el('div', {},
          App.el('div', { className: 'setting-label' }, '深色主题'),
          App.el('div', { className: 'setting-desc' }, '切换亮色/暗色显示模式')
        ),
        App.Toggle.create(App.Theme.get() === 'dark', function(on) { App.Theme.set(on ? 'dark' : 'light'); })
      )
    ));

    // 守护进程
    var daemonStatus = { running: false };
    try {
      var ds = await App.API.getDaemonStatus();
      if (ds && ds.success) daemonStatus = ds.data || { running: false };
    } catch(e) {}

    page.appendChild(App.el('div', { className: 'setting-group' },
      App.el('div', { className: 'setting-group-label' }, '守护进程'),
      App.el('div', { className: 'setting-row' },
        App.el('div', {},
          App.el('div', { className: 'setting-label' }, '状态'),
          App.el('div', { className: 'setting-desc', id: 'daemon-status-text' }, daemonStatus.running ? '运行中' : '已停止')
        ),
        App.el('button', { className: 'btn btn-sm', id: 'daemon-btn', onClick: toggleDaemon }, daemonStatus.running ? '⏹ 停止' : '▶ 启动')
      ),
      App.el('div', { className: 'setting-row' },
        App.el('div', {},
          App.el('div', { className: 'setting-label' }, '自动刷新间隔'),
          App.el('div', { className: 'setting-desc' }, '守护进程每 10 分钟执行一次')
        ),
        App.el('span', { style: 'font-size:13px;color:hsl(var(--text-400));' }, '10 分钟')
      )
    ));

    // Token 刷新
    page.appendChild(App.el('div', { className: 'setting-group' },
      App.el('div', { className: 'setting-group-label' }, 'Token 管理'),
      App.el('button', { className: 'btn btn-primary', onClick: async function() {
        App.Toast.info('正在刷新所有 Token...');
        try {
          var r = await App.API.refreshAllTokens(true);
          if (r && r.success && r.data) {
            var d = r.data;
            App.Toast.success('刷新完成: ' + d.okCount + ' 正常, ' + d.revivedCount + ' 复活, ' + d.deadCount + ' 失效');
          }
        } catch(e) { App.Toast.error('刷新失败: ' + e.message); }
      }}, '🔄 刷新所有 Token')
    ));

    // 关于
    page.appendChild(App.el('div', { className: 'setting-group' },
      App.el('div', { className: 'setting-group-label' }, '关于'),
      App.el('div', { className: 'setting-row' }, App.el('span', { className: 'setting-label' }, 'Codex Deskep'), App.el('span', { style: 'font-size:13px;color:hsl(var(--text-400));' }, 'v1.0.0')),
      App.el('div', { className: 'setting-row' }, App.el('span', { className: 'setting-label' }, '设计系统'), App.el('span', { style: 'font-size:13px;color:hsl(var(--text-400));' }, 'Claude Desktop v1.17282')),
      App.el('div', { className: 'setting-row' }, App.el('span', { className: 'setting-label' }, '引擎'), App.el('span', { style: 'font-size:13px;color:hsl(var(--text-400));' }, 'codex-switch v4.0'))
    ));
  }

  async function toggleDaemon() {
    var btn = document.getElementById('daemon-btn');
    var statusEl = document.getElementById('daemon-status-text');
    try {
      var r = await App.API.getDaemonStatus();
      var running = r && r.success && r.data && r.data.running;
      if (running) {
        await App.API.stopDaemon();
        if (statusEl) statusEl.textContent = '已停止';
        if (btn) btn.textContent = '▶ 启动';
        App.Toast.info('守护进程已停止');
      } else {
        await App.API.startDaemon();
        if (statusEl) statusEl.textContent = '运行中';
        if (btn) btn.textContent = '⏹ 停止';
        App.Toast.info('守护进程已启动');
      }
    } catch(e) { App.Toast.error('操作失败: ' + e.message); }
  }

  return { render: render };
})();
