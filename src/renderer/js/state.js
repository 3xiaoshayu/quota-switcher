window.App = window.App || {};

// 简单 pub/sub 状态管理
App.State = {
  _data: { accounts: [], currentAccount: null, daemonRunning: false, autoSwitchCfg: null, theme: 'light', loading: false },
  _listeners: {},
  get: function(key) { return key ? this._data[key] : this._data; },
  set: function(key, value) {
    var old = this._data[key];
    this._data[key] = value;
    if (old !== value && this._listeners[key]) {
      this._listeners[key].forEach(function(fn) { fn(value, old); });
    }
  },
  on: function(key, fn) {
    if (!this._listeners[key]) this._listeners[key] = [];
    this._listeners[key].push(fn);
    var self = this;
    return function() { self._listeners[key] = self._listeners[key].filter(function(f) { return f !== fn; }); };
  },
  off: function(key, fn) {
    if (this._listeners[key]) this._listeners[key] = this._listeners[key].filter(function(f) { return f !== fn; });
  },
};
