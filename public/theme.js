/* Applies the saved colour theme before first paint (no flash). Falls back to the system preference. */
(function () {
  var theme = null;
  try { theme = JSON.parse(localStorage.getItem('otzaria:theme')); } catch (error) { /* storage unavailable */ }
  if (theme !== 'dark' && theme !== 'light') {
    theme = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = theme;
})();
