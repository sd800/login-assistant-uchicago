(() => {
  'use strict';
  // Shared by isolated content scripts and the trusted service worker.
  const OKTA_ORIGIN = 'https://uchicago.okta.com';
  const PORTAL_ORIGIN = 'https://portal.uchicago.edu';
  const MY_ORIGIN = 'https://my.uchicago.edu';
  const COURSES_ORIGIN = 'https://courses.uchicago.edu';
  const CANVAS_LOGIN_URL = 'https://canvas.uchicago.edu/login/1';
  const STUDENT_LOGIN_URL = 'https://ais92hbprd.ais.uchicago.edu/psc/hbprd/EMPLOYEE/EMPL/s/WEBLIB_REDIRECT.ISCRIPT2.FieldFormula.IScript_redirect';
  function https(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
    } catch { return null; }
  }
  function isOktaLoginUrl(value) {
    const url = https(value);
    if (url?.origin !== OKTA_ORIGIN) return false;
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return false; }
    if (/\/(?:admin|enduser|settings|UserHome|reset_password|forgot-password|reset-password|change-password)(?:\/|$)/i.test(path)) return false;
    return /^\/(?:app|login|signin|oauth2|idp|sso)(?:\/|$)/i.test(path);
  }
  function entryForUrl(value) {
    const url = https(value);
    if (url?.origin === MY_ORIGIN && url.pathname === '/') return 'myuchicago';
    if (url?.origin === PORTAL_ORIGIN && /^\/ais\/?$/.test(url.pathname)) return 'portal';
    if (url?.origin === COURSES_ORIGIN && url.pathname === '/') return 'courses';
    return null;
  }
  function entryTarget(kind) {
    return ['portal', 'myuchicago'].includes(kind) ? STUDENT_LOGIN_URL : kind === 'courses' ? CANVAS_LOGIN_URL : null;
  }
  function isEntryTransit(kind, value) {
    const url = https(value);
    const target = entryTarget(kind);
    if (!url || !target) return false;
    const expected = new URL(target);
    return url.origin === expected.origin && url.pathname === expected.pathname;
  }
  globalThis.UChiLoginRoutes = Object.freeze({
    OKTA_ORIGIN, MY_ORIGIN, PORTAL_ORIGIN, COURSES_ORIGIN, CANVAS_LOGIN_URL, STUDENT_LOGIN_URL,
    isOktaLoginUrl, entryForUrl, entryTarget, isEntryTransit
  });
})();
