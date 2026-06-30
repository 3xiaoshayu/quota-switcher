window.App = window.App || {};

App.QuotaBar = {
  create: function(pct, label) {
    var cls = pct > 50 ? 'high' : pct > 20 ? 'mid' : 'low';
    return App.el('div', { className: 'quota-row' },
      App.el('span', { className: 'quota-label' }, label || '5h'),
      App.el('div', { className: 'quota-bar', style: 'flex:1;' },
        App.el('div', { className: 'quota-bar-fill ' + cls, style: 'width:' + Math.round(pct) + '%' })
      ),
      App.el('span', { className: 'quota-pct' }, Math.round(pct) + '%')
    );
  },
};
