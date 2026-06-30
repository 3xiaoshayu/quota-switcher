window.App = window.App || {};

App.AccountCard = {
  create: function(acct, isActive, onSwitch, onDelete) {
    var pct = acct.quota ? Math.round(acct.quota.hourly_percentage) : null;
    var cls = 'account-card' + (isActive ? ' active' : '');
    var planBadge = (acct.plan_type || '').includes('pro') ? 'badge badge-pro' : 'badge badge-plus';
    var tokCls = getTokenCls(acct);

    var card = App.el('div', { className: cls },
      App.el('div', { className: 'card-header' },
        App.el('div', { className: 'card-avatar' }, (acct.email || '?')[0].toUpperCase()),
        App.el('div', { style: 'flex:1;min-width:0;' },
          App.el('div', { className: 'card-email', title: acct.email }, acct.email),
          App.el('div', { className: 'card-meta' },
            App.el('span', { className: planBadge }, (acct.plan_type || 'PLUS').toUpperCase()),
            App.el('span', { className: 'token-dot ' + tokCls }),
            App.el('span', {}, 'gen ' + acct.token_generation)
          )
        )
      ),
      pct != null ? quotaMini(pct) : App.el('div', { style: 'color:hsl(var(--text-400));font-size:12px;margin-top:4px;' }, '暂无配额数据 · 点击刷新'),
      App.el('div', { className: 'card-actions' },
        App.el('button', {
          className: isActive ? 'btn btn-sm' : 'btn btn-sm btn-primary',
          onClick: function(e) { e.stopPropagation(); if (onSwitch) onSwitch(acct); }
        }, isActive ? '☑ 当前' : '⇄ 切换'),
        App.el('button', {
          className: 'btn btn-sm',
          onClick: function(e) { e.stopPropagation(); if (onDelete) onDelete(acct); }
        }, '🗑 删除')
      )
    );

    card.addEventListener('click', function() {
      window.location.hash = '#detail/' + acct.id;
    });
    return card;
  },
};

function getTokenCls(acct) {
  if (acct.quota_error || acct.requires_reauth) return 'red';
  if (!acct.tokens || !acct.tokens.refresh_token) return 'red';
  if (acct.tokens.access_token) {
    try {
      var parts = acct.tokens.access_token.split('.');
      if (parts.length === 3) {
        var payload = JSON.parse(atob(parts[1]));
        if (payload && payload.exp) {
          var left = payload.exp - Math.floor(Date.now() / 1000);
          if (left < 0) return 'red';
          if (left < 600) return 'yellow';
          return 'green';
        }
      }
    } catch(e) {}
  }
  return 'yellow';
}

function quotaMini(pct) {
  var cls = pct > 50 ? 'high' : pct > 20 ? 'mid' : 'low';
  return App.el('div', { className: 'quota-section' },
    App.el('div', { className: 'quota-row' },
      App.el('span', { className: 'quota-label' }, '5h'),
      App.el('div', { className: 'quota-bar' },
        App.el('div', { className: 'quota-bar-fill ' + cls, style: 'width:' + pct + '%' })
      ),
      App.el('span', { className: 'quota-pct' }, pct + '%')
    )
  );
}
