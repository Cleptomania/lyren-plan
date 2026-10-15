// Classic (render-blocking) script: apply the saved theme before first paint to avoid a
// light flash for dark-mode users. Must stay in sync with web/src/lib/theme.ts.
(function () {
  var pref = 'system';
  try {
    var v = localStorage.getItem('lyren.theme');
    if (v === 'light' || v === 'dark' || v === 'system') pref = v;
  } catch (e) {}
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
})();
