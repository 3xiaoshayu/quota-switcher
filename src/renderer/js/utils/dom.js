window.App = window.App || {};
App.Utils = App.Utils || {};

App.$ = function(sel, ctx) { return (ctx || document).querySelector(sel); };
App.$$ = function(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); };
App.el = function(tag, attrs) {
  var e = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function(k) {
    var v = attrs[k];
    if (k === 'className') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, String(v));
  });
  for (var i = 2; i < arguments.length; i++) {
    var c = arguments[i];
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c instanceof Node) e.appendChild(c);
    else if (c != null) e.appendChild(document.createTextNode(String(c)));
  }
  return e;
};
App.escapeHtml = function(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
};
