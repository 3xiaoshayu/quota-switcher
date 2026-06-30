window.App = window.App || {};

App.TokenStatus = {
  create: function(acct) {
    if (!acct || !acct.tokens || !acct.tokens.access_token) {
      return App.el('span', { className: 'token-dot red' });
    }
    try {
      var parts = acct.tokens.access_token.split('.');
      if (parts.length !== 3) return App.el('span', { className: 'token-dot yellow' });
      var payload = JSON.parse(atob(parts[1]));
      if (!payload || !payload.exp) return App.el('span', { className: 'token-dot yellow' });
      var left = payload.exp - Math.floor(Date.now() / 1000);
      var cls = 'green';
      if (left < 0) cls = 'red';
      else if (left < 600) cls = 'yellow';
      var text = App.formatExpiry(payload.exp);
      return App.el('span', { style: 'display:inline-flex;align-items:center;gap:6px;font-size:13px;' },
        App.el('span', { className: 'token-dot ' + cls }),
        App.el('span', { style: 'color:' + (left < 0 ? 'hsl(var(--danger-000))' : left < 600 ? 'hsl(var(--brand-000))' : 'hsl(var(--text-000))') }, text)
      );
    } catch(e) {}
    return App.el('span', { className: 'token-dot yellow' });
  },
};
