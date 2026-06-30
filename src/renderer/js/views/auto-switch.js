window.App = window.App || {};
App.Views = App.Views || {};

App.Views.AutoSwitch = (function() {
  var _saveTimer = null;

  async function render(container) {
    container.innerHTML = '';
    container.appendChild(App.el('div', { className: 'settings-page' },
      App.el('h2', { className: 'settings-title' }, '自动切号配置'),
      App.el('div', { id: 'autoswitch-form' }, App.el('div', { style: 'color:hsl(var(--text-400));padding:20px;text-align:center;' }, '加载中...'))
    ));
    await loadConfig();
  }

  async function loadConfig() {
    var formEl = document.getElementById('autoswitch-form');
    if (!formEl) return;
    try {
      var r = await App.API.getAutoSwitchConfig();
      if (!r || !r.success) throw new Error(r.error);
      var cfg = r.data || {};
      formEl.innerHTML = '';

      formEl.appendChild(App.el('div', { className: 'setting-group' },
        App.el('div', { className: 'setting-group-label' }, '开关'),
        App.el('div', { className: 'setting-row' },
          App.el('div', {},
            App.el('div', { className: 'setting-label' }, '启用自动切号'),
            App.el('div', { className: 'setting-desc' }, '当前账号配额低于阈值时自动切换到配额充足的账号')
          ),
          App.Toggle.create(cfg.enabled, async function(on) { cfg.enabled = on; await save(cfg); })
        )
      ));

      formEl.appendChild(App.el('div', { className: 'setting-group' },
        App.el('div', { className: 'setting-group-label' }, '配额阈值'),
        App.el('div', { className: 'setting-row' },
          App.el('div', {}, App.el('div', { className: 'setting-label' }, '5h 配额阈值'), App.el('div', { className: 'setting-desc' }, '低于此百分比时触发自动切号')),
          App.el('div', { style: 'display:flex;align-items:center;gap:8px;' },
            App.el('input', { className: 'input', type: 'number', min: 1, max: 100, value: cfg.primary_threshold || 20, style: 'width:70px;', onChange: function(e) { cfg.primary_threshold = parseInt(e.target.value) || 20; save(cfg); } }),
            App.el('span', { style: 'font-size:13px;color:hsl(var(--text-400));' }, '%')
          )
        ),
        App.el('div', { className: 'setting-row' },
          App.el('div', {}, App.el('div', { className: 'setting-label' }, '周配额阈值'), App.el('div', { className: 'setting-desc' }, '低于此百分比时触发自动切号')),
          App.el('div', { style: 'display:flex;align-items:center;gap:8px;' },
            App.el('input', { className: 'input', type: 'number', min: 1, max: 100, value: cfg.secondary_threshold || 30, style: 'width:70px;', onChange: function(e) { cfg.secondary_threshold = parseInt(e.target.value) || 30; save(cfg); } }),
            App.el('span', { style: 'font-size:13px;color:hsl(var(--text-400));' }, '%')
          )
        )
      ));

      formEl.appendChild(App.el('div', { className: 'setting-group' },
        App.el('div', { className: 'setting-group-label' }, '账号范围'),
        App.el('div', { className: 'setting-row' },
          App.el('div', {},
            App.el('div', { className: 'setting-label' }, '监控范围'),
            App.el('div', { className: 'setting-desc' }, cfg.account_scope_mode === 'all' ? '监控所有账号' : '仅监控选定账号')
          ),
          App.el('select', { className: 'input', style: 'width:auto;', onChange: function(e) { cfg.account_scope_mode = e.target.value; save(cfg); } },
            App.el('option', { value: 'all', selected: cfg.account_scope_mode === 'all' ? 'selected' : undefined }, '全部账号'),
            App.el('option', { value: 'selected', selected: cfg.account_scope_mode === 'selected' ? 'selected' : undefined }, '选定账号')
          )
        )
      ));

      formEl.appendChild(App.el('div', { className: 'setting-group' },
        App.el('div', { className: 'setting-group-label' }, '操作'),
        App.el('button', { className: 'btn btn-primary', onClick: async function() {
          App.Toast.info('正在检查...');
          try {
            var res = await App.API.runAutoSwitchTick();
            if (res && res.success && res.data) {
              if (res.data.switched) App.Toast.success('已自动切换: ' + res.data.to.email);
              else App.Toast.info('无需切换: ' + (res.data.reason || ''));
            }
          } catch(e) { App.Toast.error('检查失败: ' + e.message); }
        }}, '🔄 立即检查一次')
      ));

    } catch(e) { formEl.innerHTML = '<div class="empty-state"><div class="empty-state-desc">加载配置失败: ' + e.message + '</div></div>'; }
  }

  async function save(cfg) {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async function() {
      try { await App.API.saveAutoSwitchConfig(cfg); } catch(e) { App.Toast.error('保存配置失败: ' + e.message); }
    }, 500);
  }

  return { render: render };
})();
