window.App = window.App || {};
App.Views = App.Views || {};

App.Views.QuotaMonitor = (function() {
  var autoRefreshTimer = null;

  function render(container) {
    container.innerHTML = '';
    container.appendChild(App.el('div', { style: 'max-width:800px;margin:0 auto;padding:24px;' },
      App.el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;' },
        App.el('h2', { style: 'font-size:20px;font-weight:600;color:hsl(var(--text-000));' }, '配额监控'),
        App.el('div', { style: 'display:flex;gap:8px;' },
          App.el('label', { style: 'font-size:12px;color:hsl(var(--text-400));display:flex;align-items:center;gap:4px;' },
            App.el('input', { type: 'checkbox', id: 'auto-refresh', onChange: function(e) { e.target.checked ? start() : stop(); } }),
            '自动刷新(30s)'
          ),
          App.el('button', { className: 'btn btn-sm btn-primary', onClick: refreshAll }, '🔄 刷新全部')
        )
      ),
      App.el('div', { id: 'quota-grid', style: 'display:flex;flex-direction:column;gap:16px;' })
    ));
    refreshAll();
    return function() { stop(); };
  }

  async function refreshAll() {
    var grid = document.getElementById('quota-grid');
    if (!grid) return;
    grid.innerHTML = '<div style="text-align:center;padding:40px;color:hsl(var(--text-400));">加载中...</div>';
    try {
      var r = await App.API.listAccounts();
      if (!r || !r.success) throw new Error(r.error);
      var accts = r.data || [];
      grid.innerHTML = '';
      if (accts.length === 0) { grid.innerHTML = '<div class="empty-state"><div class="empty-state-title">暂无账号</div></div>'; return; }
      accts.forEach(function(a) {
        var card = App.el('div', { className: 'detail-section', style: 'margin-bottom:0;' },
          App.el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:12px;' },
            App.el('div', { className: 'user-avatar', style: 'width:28px;height:28px;font-size:11px;' }, a.email[0].toUpperCase()),
            App.el('div', { style: 'flex:1;' },
              App.el('div', { style: 'font-weight:600;font-size:14px;color:hsl(var(--text-000));' }, a.email),
              App.el('div', { style: 'font-size:11px;color:hsl(var(--text-400));' }, (a.plan_type || 'PLUS').toUpperCase())
            ),
            App.el('button', { className: 'btn btn-sm', onClick: function() { refreshOne(a.id, card); } }, '刷新')
          ),
          App.el('div', { id: 'quota-content-' + a.id })
        );
        grid.appendChild(card);
        refreshOne(a.id, card);
      });
    } catch(e) { grid.innerHTML = '<div class="empty-state"><div class="empty-state-desc">加载失败: ' + e.message + '</div></div>'; }
  }

  async function refreshOne(id, card) {
    var content = card.querySelector('#quota-content-' + id);
    if (!content) return;
    content.innerHTML = '<div style="color:hsl(var(--text-400));font-size:12px;">获取中...</div>';
    try {
      var r = await App.API.refreshQuota(id);
      if (r && r.success && r.data) {
        var q = r.data;
        content.innerHTML = '';
        content.appendChild(App.QuotaBar.create(q.hourly_percentage, '5h'));
        if (q.weekly_window_present) content.appendChild(App.QuotaBar.create(q.weekly_percentage, '周'));
        if (q.hourly_reset_time) content.appendChild(App.el('div', { style: 'font-size:11px;color:hsl(var(--text-400));margin-top:6px;' }, '重置: ' + App.formatExpiry(q.hourly_reset_time)));
        if (q.reset_credits_available) content.appendChild(App.el('div', { style: 'font-size:12px;color:hsl(var(--brand-000));margin-top:4px;' }, '🎖 ' + q.reset_credits_available + ' 次重置'));
      } else { content.innerHTML = '<div style="color:hsl(var(--text-400));font-size:12px;">获取失败</div>'; }
    } catch(e) { content.innerHTML = '<div style="color:hsl(var(--danger-100));font-size:12px;">错误: ' + e.message + '</div>'; }
  }

  function start() { stop(); autoRefreshTimer = setInterval(refreshAll, 30000); }
  function stop() { if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; } }

  return { render: render };
})();
