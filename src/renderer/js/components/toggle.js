window.App = window.App || {};

App.Toggle = {
  create: function(initialOn, onChange) {
    var btn = App.el('button', { className: 'toggle' + (initialOn ? ' on' : '') });
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var isOn = btn.classList.toggle('on');
      if (onChange) onChange(isOn);
    });
    return btn;
  },
};
