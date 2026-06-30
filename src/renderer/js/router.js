window.App = window.App || {};

App.Router = (function() {
  var views = {};
  var _currentCleanup = null;

  function parseRoute(hash) {
    var h = (hash || window.location.hash || '#accounts').replace(/^#/, '');
    var slashIdx = h.indexOf('/');
    if (slashIdx < 0) return [h, ''];
    return [h.slice(0, slashIdx), h.slice(slashIdx + 1)];
  }

  function navigate(hash) {
    var container = document.getElementById('viewContainer');
    if (!container) return;
    if (_currentCleanup) { try { _currentCleanup(); } catch(e) {} _currentCleanup = null; }
    container.innerHTML = '';
    var parsed = parseRoute(hash);
    var route = parsed[0], param = parsed[1];
    var view = views[route];
    if (view && view.render) {
      _currentCleanup = view.render(container, param) || function() {};
    } else {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-title">页面未找到</div></div>';
    }
    window.App.Sidebar.updateActiveNav();
  }

  return {
    register: function(name, viewModule) { views[name] = viewModule; },
    navigate: navigate,
    init: function() {
      var self = this;
      window.addEventListener('hashchange', function() { navigate(window.location.hash); });
      navigate(window.location.hash);
    },
  };
})();
