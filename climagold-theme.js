(function () {
  'use strict';
  var key = 'climagold-theme', root = document.documentElement;
  function valid(value) { return value === 'dark' ? 'dark' : 'light'; }
  function apply(value) {
    value = valid(value);
    root.dataset.theme = value;
    document.querySelectorAll('[data-cg-theme]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.cgTheme === value));
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = value === 'dark' ? '#141c25' : '#1d2832';
  }
  var saved = 'light';
  try { saved = localStorage.getItem(key); } catch (e) {}
  apply(saved);
  function control() {
    var group = document.createElement('div');
    group.className = 'cg-theme-switch';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Motyw strony');
    [{value:'light',label:'Jasny',icon:'☀'},{value:'dark',label:'Ciemny',icon:'☾'}].forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.dataset.cgTheme = item.value;
      button.innerHTML = '<span aria-hidden="true">'+item.icon+'</span> '+item.label;
      button.addEventListener('click', function () {
        apply(item.value);
        try { localStorage.setItem(key, item.value); } catch (e) {}
      });
      group.appendChild(button);
    });
    return group;
  }
  function mount() {
    var top = document.querySelector('.top');
    if (top && !top.querySelector('.cg-theme-switch')) {
      var actions = document.createElement('div');
      actions.className = 'cg-top-actions';
      actions.appendChild(control());
      var refresh = document.getElementById('refreshBtn');
      if (refresh && refresh.parentNode === top) actions.appendChild(refresh);
      top.appendChild(actions);
    }
    document.querySelectorAll('.login .box, main.box').forEach(function (box) {
      if (!box.querySelector('.cg-theme-switch')) {
        var row = document.createElement('div'); row.className = 'cg-theme-entry';
        row.appendChild(control()); box.insertBefore(row, box.firstChild);
      }
    });
    apply(root.dataset.theme);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  window.addEventListener('storage', function (event) {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
})();
