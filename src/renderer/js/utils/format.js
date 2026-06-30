window.App = window.App || {};
App.Utils = App.Utils || {};

App.formatDate = function(ts) {
  if (!ts) return '?';
  var d = new Date(ts * 1000);
  var now = new Date();
  var diff = Math.floor((now - d) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + '天前';
  return d.toISOString().slice(0, 10);
};

App.formatDuration = function(seconds) {
  if (!seconds || seconds <= 0) return '已过期';
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'min';
  return m + 'min';
};

App.formatPercentage = function(pct) {
  if (pct == null) return '—';
  return Math.round(pct) + '%';
};

App.formatExpiry = function(expTs) {
  if (!expTs) return '?';
  var now = Math.floor(Date.now() / 1000);
  var left = expTs - now;
  if (left < 0) return '已过期';
  if (left < 600) return Math.ceil(left / 60) + 'min';
  if (left < 3600) return Math.floor(left / 60) + 'min';
  if (left < 86400) return (left / 3600).toFixed(1) + 'h';
  return (left / 86400).toFixed(1) + '天';
};

App.planIcon = function(planType) {
  if (!planType) return '○';
  if (planType.includes('pro')) return '⬡ Pro';
  return '○ Plus';
};
