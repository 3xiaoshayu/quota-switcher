window.App = window.App || {};

App.Theme = {
  KEY: 'codex-deskep-theme',
  init: function() {
    var stored = localStorage.getItem(this.KEY) || 'light';
    this.set(stored);
    return stored;
  },
  set: function(mode) {
    document.documentElement.className = mode === 'dark' ? 'darkTheme' : '';
    localStorage.setItem(this.KEY, mode);
  },
  toggle: function() {
    var current = document.documentElement.className === 'darkTheme' ? 'dark' : 'light';
    this.set(current === 'dark' ? 'light' : 'dark');
    return current === 'dark' ? 'light' : 'dark';
  },
  get: function() {
    return document.documentElement.className === 'darkTheme' ? 'dark' : 'light';
  },
};
