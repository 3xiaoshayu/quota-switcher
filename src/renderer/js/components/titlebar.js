window.App = window.App || {};

App.Titlebar = {
  render: function(container) {
    var existing = container.querySelector('.titlebar');
    if (existing) return;
    var tb = App.el('header', { className: 'titlebar' },
      App.el('div', { className: 'titlebar-traffic' },
        App.el('div', { className: 'traffic-btn traffic-close', onClick: function() { App.API.closeWindow(); } }),
        App.el('div', { className: 'traffic-btn traffic-min', onClick: function() { App.API.minimizeWindow(); } }),
        App.el('div', { className: 'traffic-btn traffic-max', onClick: function() { App.API.toggleMaximize(); } })
      ),
      App.el('div', { className: 'titlebar-title' }, 'Codex Deskep'),
      App.el('div', { className: 'titlebar-actions' },
        App.el('button', { className: 'btn-icon', title: '切换主题', onClick: function() {
          App.Theme.toggle();
        }}, '🌓'),
        App.el('button', { className: 'btn-icon', title: '设置', onClick: function() {
          window.location.hash = '#settings';
        }}, '⚙')
      )
    );
    container.appendChild(tb);
  },
};
