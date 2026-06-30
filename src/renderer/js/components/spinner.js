window.App = window.App || {};

App.Spinner = {
  show: function(el, text) {
    if (!el) return;
    el.innerHTML = '<span style="display:inline-block;width:16px;height:16px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.6s linear infinite;margin-right:6px;vertical-align:middle;"></span> ' + (text || '加载中...');
  },
  clear: function(el) {
    if (!el) return;
    el.innerHTML = '';
  },
};
