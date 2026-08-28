(() => {
  'use strict';
  const visible = element => !!element && !element.hidden && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  const text = element => (element?.innerText || element?.textContent || element?.value || '').replace(/\s+/g, ' ').trim();
  const usable = element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  const first = (root, selectors) => selectors.flatMap(selector => [...root.querySelectorAll(selector)]).find(e => usable(e) && !e.readOnly);
  // Match both English and Chinese labels used by the school sign-in pages.
  function error(root) {
    return [...root.querySelectorAll('.o-form-error-container, .infobox-error, [data-se="o-form-error-container"], [role="alert"]')].some(e => visible(e) && /incorrect|invalid|failed|locked|denied|unable|error|\u9519\u8bef|\u5931\u8d25|\u65e0\u6548|\u9501\u5b9a/i.test(text(e)));
  }
  function detectOkta(root) {
    if (!globalThis.UChiLoginRoutes?.isOktaLoginUrl(location.href)) return null;
    if (error(root)) return { kind: 'error' };
    const containers = [...root.querySelectorAll('form, .o-form')];
    const widget = root.querySelector('#okta-sign-in');
    if (widget && !containers.length) containers.push(widget);
    for (const form of new Set(containers)) {
      if (!visible(form)) continue;
      const heading = [...form.querySelectorAll('h1, h2, h3, .o-form-head, [data-se="o-form-head"]')].map(text).join(' ');
      if (/reset password|change password|new password|forgot password|verification code|security code|recovery code|one.time|enter (?:a |the )?code|\u91cd\u7f6e\u5bc6\u7801|\u66f4\u6539\u5bc6\u7801|\u9a8c\u8bc1\u7801/i.test(heading)) continue;
      if (first(form, ['input[autocomplete="new-password"]', 'input[name="newPassword"]', 'input[name="confirmPassword"]'])) continue;
      const username = first(form, [
        '#okta-signin-username', 'input[name="identifier"]', 'input[name="username"]',
        'input[name="credentials.username"]', 'input[autocomplete="username"]'
      ]);
      let password = first(form, [
        '#okta-signin-password', 'input[name="credentials.passcode"][type="password"]',
        'input[name="credentials.password"][type="password"]', 'input[name="password"][type="password"]',
        'input[autocomplete="current-password"][type="password"]'
      ]);
      if (!password && /password|\u5bc6\u7801/i.test(heading)) password = first(form, ['input[type="password"]']);
      const kind = username && password ? 'combined' : password ? 'password' : username ? 'username' :
        /duo\s*(security)?|duosecurity\.com/i.test(text(form)) ? 'duo' : null;
      if (!kind) continue;
      const buttons = [...form.querySelectorAll('input[type="submit"], input[type="button"], button, [data-type="save"], a.button, a.button-primary')];
      const button = buttons.find(e => usable(e) && /^(next|sign\s*in|log\s*in|verify|continue|confirm|(?:continue|verify|sign in) (?:to|with) duo(?: security)?|\u4e0b\u4e00\u6b65|\u767b\u5f55|\u767b\u5165|\u9a8c\u8bc1|\u7ee7\u7eed|\u786e\u8ba4)$/i.test(text(e)));
      return { kind, username, password, button };
    }
    return null;
  }
  function studentEntry(root) {
    const tab = [...root.querySelectorAll('[role="tab"]')].find(e => usable(e) && /^students?$/i.test(text(e)));
    if (!tab) return null;
    const reference = tab.getAttribute('aria-controls') || tab.getAttribute('href')?.replace(/^#/, '');
    const panel = reference && root.getElementById(reference);
    if (!panel) return null;
    const target = globalThis.UChiLoginRoutes.STUDENT_LOGIN_URL;
    const button = [...panel.querySelectorAll('a[href]')].find(e => {
      if (!/^my\.uchicago$/i.test(text(e)) || e.getAttribute('aria-disabled') === 'true') return false;
      try { return new URL(e.getAttribute('href'), location.href).href === target; } catch { return false; }
    });
    return button ? { tab, button } : null;
  }
  function fill(input, value) {
    if (!input || typeof value !== 'string') return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function duoChoice(root) {
    const candidates = [...root.querySelectorAll('button, a, input[type="submit"]')].filter(usable);
    return candidates.find(e => /^(use (a )?(passkey|security key)|passkey|security key|\u901a\u884c\u5bc6\u94a5|\u5b89\u5168\u5bc6\u94a5|\u4f7f\u7528\u901a\u884c\u5bc6\u94a5|\u4f7f\u7528\u5b89\u5168\u5bc6\u94a5)$/i.test(text(e))) ||
      candidates.find(e => /^(other options|other authentication options|try another method|\u5176\u4ed6\u9009\u9879|\u5176\u4ed6\u9a8c\u8bc1\u65b9\u5f0f)$/i.test(text(e)));
  }
  globalThis.UChiLoginDOM = { visible, text, error, detectOkta, studentEntry, fill, duoChoice };
})();
