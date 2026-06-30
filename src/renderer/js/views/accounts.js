window.App = window.App || {};

App.Views = App.Views || {};

App.Views.Accounts = (function() {
  function render(container) {
    var page = App.el('div', {});
    var grid = App.el('div', { className: 'card-grid' });
    page.appendChild(grid);

    var header = App.el('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:20px 24px;' },
      App.el('div', {},
        App.el('h2', { style: 'font-size:20px;font-weight:600;color:hsl(var(--text-000));' }, '账号管理'),
        App.el('p', { style: 'font-size:13px;color:hsl(var(--text-400));margin-top:4px;' }, '管理你的 Codex 账号，一键切换')
      ),
      App.el('div', { style: 'display:flex;gap:8px;' },
        App.el('button', { className: 'btn btn-brand', onClick: addAccount }, '+ 添加账号'),
        App.el('button', { className: 'btn btn-sm', onClick: loadAccounts }, '🔄 刷新')
      )
    );
    container.appendChild(header);
    container.appendChild(page);

    loadAccounts();
    var unsub1 = App.State.on('accounts', function() { renderGrid(grid); });
    var unsub2 = App.State.on('currentAccount', function() { renderGrid(grid); });
    return function() { unsub1(); unsub2(); };
  }

  async function loadAccounts() {
    try {
      var r = await App.API.listAccounts();
      if (r && r.success && Array.isArray(r.data)) {
        App.State.set('accounts', r.data);
      }
      try {
        var cur = await App.API.getCurrentAccount();
        if (cur && cur.success && cur.data) { App.State.set('currentAccount', cur.data); }
      } catch(e) {}
    } catch(e) {
      App.Toast.error('加载账号列表失败: ' + e.message);
    }
  }

  function renderGrid(grid) {
    var accts = App.State.get('accounts') || [];
    var cur = App.State.get('currentAccount');
    grid.innerHTML = '';
    if (accts.length === 0) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon">👤</div><div class="empty-state-title">暂无账号</div><div class="empty-state-desc">点击上方「添加账号」按钮通过 OAuth 登录你的 Codex 账号</div></div>';
      return;
    }
    accts.forEach(function(a) {
      grid.appendChild(App.AccountCard.create(a, cur && a.id === cur.id, handleSwitch, handleDelete));
    });
  }

  async function addAccount() {
    App.Toast.info('正在打开浏览器进行 OAuth 登录...');
    try {
      var r = await App.API.addAccount();
      if (r && r.success) {
        App.Toast.success('账号添加成功: ' + r.data.email);
        await loadAccounts();
      } else { throw new Error(r.error || '登录失败'); }
    } catch(e) { App.Toast.error('添加账号失败: ' + e.message); }
  }

  async function handleSwitch(acct) {
    try {
      App.Toast.info('正在切换到 ' + acct.email + '...');
      var r = await App.API.switchAccount(acct.id);
      if (r && r.success) {
        App.Toast.success('已切换到 ' + acct.email);
        await loadAccounts();
      } else { throw new Error(r.error || '切换失败'); }
    } catch(e) { App.Toast.error('切换失败: ' + e.message); }
  }

  async function handleDelete(acct) {
    if (!confirm('确定要删除账号 ' + acct.email + ' 吗？此操作不可撤销。')) return;
    try {
      var r = await App.API.deleteAccount(acct.id);
      if (r && r.success) { App.Toast.success('账号已删除'); await loadAccounts(); }
      else { throw new Error(r.error || '删除失败'); }
    } catch(e) { App.Toast.error('删除失败: ' + e.message); }
  }

  return { render: render };
})();
