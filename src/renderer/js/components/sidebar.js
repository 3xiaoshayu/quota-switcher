window.App = window.App || {};

App.Sidebar = (function() {
  var NAV_ITEMS = [
    { id: 'accounts',    label: '账号管理', icon: '👤', hash: '#accounts' },
    { id: 'quota',       label: '配额监控', icon: '📊', hash: '#quota' },
    { id: 'autoswitch',  label: '自动切号', icon: '🔄', hash: '#autoswitch' },
    { id: 'settings',    label: '设置',     icon: '⚙',  hash: '#settings' },
  ];

  function updateFooter() {
    var footer = document.getElementById('sidebar-footer');
    if (!footer) return;
    var cur = App.State.get('currentAccount');
    if (cur && cur.email) {
      footer.innerHTML = '';
      var planBadge = (cur.plan_type || '').includes('pro') ? 'badge badge-pro' : 'badge badge-plus';
      footer.appendChild(App.el('div', { className: 'user-avatar' }, cur.email[0].toUpperCase()));
      footer.appendChild(App.el('div', { style: 'flex:1;min-width:0;' },
        App.el('div', { style: 'font-size:13px;font-weight:500;color:hsl(var(--text-000));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, cur.email),
        App.el('div', { style: 'font-size:11px;color:hsl(var(--text-400));' }, (cur.plan_type || 'PLUS').toUpperCase())
      ));
      footer.appendChild(App.el('span', { className: planBadge }, (cur.plan_type || 'PLUS').toUpperCase()));
    } else {
      footer.textContent = '';
    }
  }

  function updateActiveNav() {
    var hash = window.location.hash || '#accounts';
    document.querySelectorAll('.nav-item').forEach(function(el) {
      el.classList.toggle('active', el.getAttribute('href') === hash);
    });
  }

  return {
    NAV_ITEMS: NAV_ITEMS,
    render: function(container) {
      var existing = container.querySelector('.sidebar');
      if (existing) existing.remove();
      var navItems = NAV_ITEMS.map(function(item) {
        return App.el('a', { className: 'nav-item', href: item.hash, 'data-nav': item.id },
          App.el('span', { className: 'nav-icon-emoji' }, item.icon),
          item.label
        );
      });
      var sidebar = App.el('aside', { className: 'sidebar' },
        App.el('div', { className: 'sidebar-header' },
          App.el('div', { className: 'sidebar-logo-area' },
            App.el('div', { className: 'sidebar-logo' }, App.el('span', {}, 'C')),
            App.el('span', { className: 'sidebar-brand' }, 'Codex Deskep')
          )
        ),
        App.el('nav', { className: 'sidebar-nav' },
          navItems[0], navItems[1], navItems[2], navItems[3]
        ),
        App.el('div', { className: 'sidebar-footer', id: 'sidebar-footer' })
      );
      container.appendChild(sidebar);
      updateFooter();
      updateActiveNav();
      App.State.on('accounts', updateFooter);
      App.State.on('currentAccount', updateFooter);
    },
    updateActiveNav: updateActiveNav,
    updateFooter: updateFooter,
  };
})();
