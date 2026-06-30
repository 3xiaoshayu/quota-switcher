window.App = window.App || {};

App.Toast = (function() {
  var id = 0;
  function show(message, type) {
    var container = document.getElementById('toastContainer');
    if (!container) return;
    var tid = 'toast-' + (++id);
    var t = App.el('div', { id: tid, className: 'toast toast-' + type }, message || '');
    t.addEventListener('click', function() { dismiss(tid); });
    container.appendChild(t);
    setTimeout(function() { dismiss(tid); }, 3000);
  }
  function dismiss(tid) {
    var el = document.getElementById(tid);
    if (el) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px)';
      el.style.transition = 'all 200ms';
      setTimeout(function() { el.remove(); }, 200);
    }
  }
  return {
    success: function(msg) { show(msg, 'success'); },
    error: function(msg) { show(msg, 'error'); },
    warning: function(msg) { show(msg, 'warning'); },
    info: function(msg) { show(msg, 'info'); },
  };
})();
