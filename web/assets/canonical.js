(() => {
  'use strict';

  const { protocol, pathname, search, hash } = window.location;
  if (protocol !== 'https:' && protocol !== 'http:') return;

  const home = new URL('../', document.currentScript.src);
  const aliases = ['index', 'index.html', 'index/'].map(path => home.pathname + path);
  if (!aliases.includes(pathname)) return;

  home.search = search;
  home.hash = hash;
  window.location.replace(home.href);
})();
