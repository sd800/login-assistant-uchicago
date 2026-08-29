(() => {
  'use strict';
  const visible = element => !!element && !element.hidden && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  // Exact Okta controls can be handled as soon as they enter the active DOM,
  // before layout has produced client rectangles. Hidden templates stay excluded.
  const exposed = element => {
    if (!element) return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
    }
    return true;
  };
  const normalizeLabel = value => String(value || '').normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  const text = element => normalizeLabel(element?.innerText || element?.textContent || element?.value);
  const usable = element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  const oktaInput = element => exposed(element) && !element.disabled && !element.readOnly && element.getAttribute('aria-disabled') !== 'true';
  const first = (root, selectors) => selectors.flatMap(selector => [...root.querySelectorAll(selector)]).find(oktaInput);
  function error(root) {
    // Okta's error containers keep their identity when their message is translated.
    if ([...root.querySelectorAll('.o-form-error-container, .infobox-error, [data-se="o-form-error-container"]')]
      .some(node => exposed(node) && text(node))) return true;
    return [...root.querySelectorAll('[role="alert"]')].some(node => visible(node) &&
      /incorrect|invalid|failed|locked|denied|unable|error|\u9519\u8bef|\u932f\u8aa4|\u5931\u8d25|\u5931\u6557|\u65e0\u6548|\u7121\u6548|\u9501\u5b9a|\u9396\u5b9a|\u62d2\u7edd|\u62d2\u7d55/i.test(text(node)));
  }
  function oktaSubmit(form) {
    const controls = [...form.querySelectorAll('input[type="submit"], input[type="button"], button, a.button, a.button-primary, [data-type="save"]')];
    const buttons = controls.filter(exposed);
    // Prefer the widget's save control or the form's native submit control. Do
    // not fall back to a translated label when structural matches are ambiguous.
    const primary = buttons.filter(node => node.getAttribute('id') === 'okta-signin-submit' ||
      node.getAttribute('data-type') === 'save' || node.matches('input[type="submit"]') || node.matches('button[type="submit"]'));
    if (primary.length) return primary.length === 1 ? primary[0] : undefined;
    const matches = buttons.filter(node => /^(next|sign\s*in|log\s*in|verify|continue|confirm|(?:continue|verify|sign in) (?:to|with) duo(?: security)?|\u4e0b\u4e00\u6b65|\u767b\u5f55|\u767b\u5165|\u9a8c\u8bc1|\u9a57\u8b49|\u7ee7\u7eed|\u7e7c\u7e8c|\u786e\u8ba4|\u78ba\u8a8d)$/i.test(text(node)));
    return matches.length === 1 ? matches[0] : undefined;
  }
  function detectOkta(root) {
    if (!globalThis.UChiLoginRoutes?.isOktaLoginUrl(location.href)) return null;
    if (error(root)) return { kind: 'error' };
    const containers = [...root.querySelectorAll('form, .o-form')];
    const widget = root.querySelector('#okta-sign-in');
    if (widget && !containers.length) containers.push(widget);
    const steps = [];
    for (const form of new Set(containers)) {
      if (!exposed(form)) continue;
      const heading = [...form.querySelectorAll('h1, h2, h3, .o-form-head, [data-se="o-form-head"]')].filter(exposed).map(text).join(' ');
      if (/(?:reset|change|new|forgot|set up|create|choose).*password|verification code|security code|recovery code|one.time|enter (?:a |the )?code|(?:\u91cd\u7f6e|\u91cd\u8bbe|\u91cd\u8a2d|\u66f4\u6539|\u4fee\u6539|\u53d8\u66f4|\u8b8a\u66f4|\u8bbe\u7f6e|\u8a2d\u5b9a|\u5efa\u7acb|\u5fd8\u8bb0|\u5fd8\u8a18|\u65b0).*\u5bc6[\u7801\u78bc]|\u9a8c\u8bc1\u7801|\u9a57\u8b49\u78bc|\u5b89\u5168[\u4ee3\u7801\u78bc]|\u5fa9\u539f\u78bc/i.test(heading)) continue;
      const excluded = ['input[autocomplete="new-password"]', 'input[autocomplete="one-time-code"]',
        'input[name="newPassword"]', 'input[name="confirmPassword"]', 'input[name="credentials.newPassword"]',
        'input[name="credentials.confirmPassword"]', 'input[name="credentials.confirmPasscode"]'];
      if (excluded.some(selector => [...form.querySelectorAll(selector)].some(exposed))) continue;
      const username = first(form, [
        '#okta-signin-username', 'input[name="identifier"]', 'input[name="username"]',
        'input[name="credentials.username"]', 'input[autocomplete="username"]'
      ]);
      let password = first(form, [
        '#okta-signin-password', 'input[name="credentials.passcode"][type="password"]',
        'input[name="credentials.password"][type="password"]', 'input[name="password"][type="password"]',
        'input[autocomplete="current-password"][type="password"]'
      ]);
      if (!password && /password|\u5bc6[\u7801\u78bc]/i.test(heading)) password = first(form, ['input[type="password"]']);
      const kind = username && password ? 'combined' : password ? 'password' : username ? 'username' :
        /duo\s*(security)?|duosecurity\.com/i.test(text(form)) ? 'duo' : null;
      if (!kind) continue;
      const submitButton = oktaSubmit(form);
      steps.push({ kind, form, username, password, submitButton, button: oktaInput(submitButton) ? submitButton : undefined });
    }
    return steps.length === 1 ? steps[0] : null;
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
      try {
        const url = new URL(e.getAttribute('href'), location.href), expected = new URL(target);
        return url.origin === expected.origin && url.pathname === expected.pathname &&
          !url.username && !url.password && !url.hash && !url.searchParams.toString();
      } catch { return false; }
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
  function duoMenuVisible(root) {
    if (duoIdentity(root) || duoAddHeading(root) || duoSetupHeading(root)) return false;
    const structural = visible(root.querySelector('select#device-filter')) &&
      visible(root.querySelector('ul.all-auth-methods-list')) &&
      !!root.querySelector('ul.all-auth-methods-list')?.querySelector('.auth-method');
    const heading = [...root.querySelectorAll('h1, h2, h3, [role="heading"]')].some(e => visible(e) &&
      /^(other (?:authentication )?options(?: to (?:log|sign) in)?|select an option to log in|choose (?:an authentication method|how to (?:log|sign) in)|\u5176\u4ed6\u9009\u9879|\u5176\u4ed6\u9a8c\u8bc1\u65b9\u5f0f|\u5176\u4ed6\u767b\u5f55\u9009\u9879|\u663e\u793a\u5176\u4ed6\u9009\u9879|\u67e5\u770b\u5176\u4ed6\u9009\u9879|\u5c1d\u8bd5\u5176\u4ed6\u65b9\u5f0f|\u5176\u4ed6\u9078\u9805|\u5176\u4ed6\u9a57\u8b49\u65b9\u5f0f|\u5176\u4ed6\u767b\u5165\u9078\u9805|\u9078\u64c7\u9a57\u8b49\u65b9\u5f0f|\u9078\u64c7\u767b\u5165\u65b9\u5f0f)$/i.test(text(e)));
    return structural || heading || (!duoIdentity(root) && !!duoControl(root, /^(manage devices|\u7ba1\u7406\u8bbe\u5907|\u7ba1\u7406\u88dd\u7f6e)$/i) &&
      !!duoControl(root, /^(security\s*key|\u5b89\u5168\u5bc6\u94a5|\u5b89\u5168\u91d1\u9470|\u5b89\u5168\u6027\u91d1\u9470)$/i));
  }
  function duoChoice(root) {
    return duoControl(root,
      /^(?:show )?(other options|other authentication options|try another method|\u5176\u4ed6\u9009\u9879|\u663e\u793a\u5176\u4ed6\u9009\u9879|\u67e5\u770b\u5176\u4ed6\u9009\u9879|\u5176\u4ed6\u9a8c\u8bc1\u65b9\u5f0f|\u5176\u4ed6\u767b\u5f55\u9009\u9879|\u5c1d\u8bd5\u5176\u4ed6\u65b9\u5f0f|\u5176\u4ed6\u9078\u9805|\u5176\u4ed6\u9a57\u8b49\u65b9\u5f0f|\u5176\u4ed6\u767b\u5165\u9078\u9805|\u5617\u8a66\u5176\u4ed6\u65b9\u5f0f)$/i);
  }
  const duoControls = root => [...root.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"], [role="link"], [role="menuitem"]')].filter(usable);
  const cleanLabel = value => normalizeLabel(value).replace(/[\u2190-\u21ff]/g, '').trim();
  function duoControl(root, pattern) {
    const matches = duoControls(root).filter(control => {
      const labelledBy = (control.getAttribute('aria-labelledby') || '').split(/\s+/)
        .map(id => text(root.getElementById(id))).join(' ');
      const labels = [control.getAttribute('aria-label'), labelledBy, control.getAttribute('title'), text(control),
        ...[...control.querySelectorAll('h2, h3, h4, strong, span, div, p')].filter(visible).map(text)];
      return labels.some(label => pattern.test(cleanLabel(label)));
    });
    // Nested labels may repeat the same control; unrelated matches are ambiguous.
    const targets = matches.filter(control => !matches.some(other => other !== control && control.contains(other)));
    return targets.length === 1 ? targets[0] : undefined;
  }
  const duoHeading = (root, pattern) => [...root.querySelectorAll('h1, h2, h3, [role="heading"]')]
    .some(node => visible(node) && pattern.test(text(node)));
  function duoIdentity(root) {
    return duoHeading(root, /verify your identity before managing devices|\u7ba1\u7406\u8bbe\u5907\u524d.*\u9a8c\u8bc1|\u9a8c\u8bc1.*\u4ee5\u7ee7\u7eed\u7ba1\u7406\u8bbe\u5907|\u7ba1\u7406\u88dd\u7f6e\u524d.*\u9a57\u8b49|\u9a57\u8b49.*\u4ee5\u7e7c\u7e8c\u7ba1\u7406\u88dd\u7f6e/i);
  }
  const duoAddHeading = root => duoHeading(root, /^(add (?:a |another )?device|\u6dfb\u52a0(?:\u4e00\u4e2a)?\u8bbe\u5907|\u65b0\u589e(?:\u4e00\u500b)?\u88dd\u7f6e)$/i) &&
    !!duoControl(root, /^(security\s*key|touch id|\u5b89\u5168\u5bc6\u94a5|\u5b89\u5168\u91d1\u9470|\u5b89\u5168\u6027\u91d1\u9470)$/i);
  const duoSetupHeading = root => duoHeading(root, /^(set up (?:a |your )?security key|\u8bbe\u7f6e(?:\u4e00\u4e2a|\u60a8\u7684)?\u5b89\u5168\u5bc6\u94a5|\u8a2d\u5b9a(?:\u4e00\u500b|\u60a8\u7684)?\u5b89\u5168(?:\u6027)?\u91d1\u9470)$/i);
  function duoAction(root, action) {
    if (duoIdentity(root)) return undefined;
    if (action === 'remember-device' && duoHeading(root, /^(is this your device|\u8fd9\u662f\u60a8\u7684\u8bbe\u5907\u5417|\u8fd9\u662f\u4f60\u7684\u8bbe\u5907\u5417|\u9019\u662f\u60a8\u7684\u88dd\u7f6e\u55ce|\u9019\u662f\u4f60\u7684\u88dd\u7f6e\u55ce)[?\uff1f]?$/i)) {
      return duoControl(root, /^(yes[,\uff0c]?\s*this is my device|\u662f\u7684?[,\uff0c]?\s*\u8fd9\u662f\u6211\u7684\u8bbe\u5907|\u662f[,\uff0c]?\s*\u9019\u662f\u6211\u7684\u88dd\u7f6e)[.\u3002]?$/i);
    }
    if (action === 'manage' && duoMenuVisible(root)) {
      const structural = [...root.querySelectorAll('.auth-method')].filter(control => usable(control) &&
        control.querySelector('.manage-devices-sub-description, .manage-devices-chevron'));
      if (structural.length === 1) return structural[0];
      return duoControl(root, /^(manage devices|\u7ba1\u7406\u8bbe\u5907|\u7ba1\u7406\u88dd\u7f6e)$/i);
    }
    if (action === 'add-device' && !duoAddHeading(root) && !duoSetupHeading(root)) return duoControl(root, /^(add (?:a |another )?device|\u6dfb\u52a0(?:\u4e00\u4e2a)?\u8bbe\u5907|\u65b0\u589e(?:\u4e00\u500b)?\u88dd\u7f6e)$/i);
    if ((action === 'security-key' && duoAddHeading(root)) || (action === 'login-key' && duoMenuVisible(root))) {
      return duoControl(root, /^(security\s*key(?:\s.*)?|use (?:a |your )?security key|\u5b89\u5168\u5bc6\u94a5(?:\s.*)?|\u5b89\u5168(?:\u6027)?\u91d1\u9470(?:\s.*)?)$/i);
    }
    if (action === 'register' && duoSetupHeading(root)) return duoControl(root, /^(continue|\u7ee7\u7eed|\u7e7c\u7e8c)$/i);
    if (action === 'back' && !duoAddHeading(root) && !duoSetupHeading(root)) return duoControl(root, /^(back to (?:log|sign)[ -]?in|\u8fd4\u56de\u767b\u5f55|\u8fd4\u56de\u767b\u5165|\u56de\u5230\u767b\u5165)$/i);
    return undefined;
  }
  function duoInventory(root) {
    if (duoIdentity(root) || duoAddHeading(root) || duoSetupHeading(root) ||
        !duoAction(root, 'add-device') || !duoAction(root, 'back') ||
        [...root.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible)) return null;
    const edits = duoControls(root).filter(node => /^edit$/i.test(cleanLabel(node.getAttribute('aria-label') || text(node))) ||
      /^(?:\u7f16\u8f91|\u7de8\u8f2f)$/.test(text(node)));
    // A verified account has an existing device. Wait for its cards to finish loading.
    if (!edits.length) return null;
    const cards = new Set();
    for (const edit of edits) {
      for (let node = edit.parentElement; node && node !== root.body; node = node.parentElement) {
        if (edits.filter(other => other === node || [...node.querySelectorAll('button, a, [role="button"]')].includes(other)).length > 1) break;
        const labels = [node, ...node.querySelectorAll('h2, h3, h4, p, small, span, div')].filter(visible);
        if (labels.some(label => /^(security\s*key(?:\s*\([^)]*\))?|\u5b89\u5168\u5bc6\u94a5|\u5b89\u5168(?:\u6027)?\u91d1\u9470)$/i.test(text(label)))) {
          cards.add(node); break;
        }
      }
    }
    return [...cards].map(card => text(card).slice(0, 2048)).sort();
  }
  function duoKeyRejected(root) {
    // Deliberately ignore broad failures such as cancellation, timeout, and
    // "something went wrong"; they do not establish credential revocation.
    return [...root.querySelectorAll('[role="alert"], .error-message, .error-text')].some(node => visible(node) &&
      /(?:this |your |the )?security key (?:is (?:not|no longer) registered|has been (?:removed|deleted))|(?:do not|don.t|does not|doesn.t) recognize (?:this|your|the) security key|\u6b64\u5b89\u5168\u5bc6\u94a5(?:\u672a\u6ce8\u518c|\u5df2\u88ab\u5220\u9664)|\u6b64\u5b89\u5168(?:\u6027)?\u91d1\u9470(?:\u672a\u8a3b\u518a|\u5df2\u88ab\u522a\u9664)/i.test(text(node)));
  }
  globalThis.UChiLoginDOM = { visible, exposed, text, error, detectOkta, studentEntry, fill,
    duoMenuVisible, duoChoice, duoIdentity, duoAction, duoInventory, duoKeyRejected };

})();
