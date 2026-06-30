window.App = window.App || {};

App.Modal = {
  show: function(opts) {
    var overlay = document.getElementById('modalOverlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    var panel = App.el('div', { className: 'modal-panel' },
      App.el('div', { className: 'modal-header' },
        App.el('span', { className: 'modal-title' }, opts.title || ''),
        App.el('button', { className: 'modal-close', onClick: function() { App.Modal.hide(); } }, '✕')
      ),
      App.el('div', { className: 'modal-body' },
        typeof opts.body === 'string' ? App.el('p', {}, opts.body) : (opts.body || '')
      ),
      opts.footer ? App.el('div', { className: 'modal-footer' }, opts.footer) : null
    );
    overlay.appendChild(panel);
    overlay.classList.add('open');
    overlay._onClose = opts.onClose || null;
    var self = this;
    overlay.addEventListener('click', function(e) { if (e.target === overlay) self.hide(); });
  },
  hide: function() {
    var overlay = document.getElementById('modalOverlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    if (overlay._onClose) { overlay._onClose(); overlay._onClose = null; }
  },
};
