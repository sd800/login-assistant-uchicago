import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Element, element as e, documentWith } from './dom-fixture.mjs';
import { fixture, sender, ui, DUO, creation } from './helpers.mjs';
import { STUDENT_LOGIN_URL, CANVAS_LOGIN_URL, DUO_MATCH } from '../extension/core/policy.js';

const scripts = Object.fromEntries(await Promise.all(['routes', 'dom', 'entry', 'okta', 'duo'].map(async name =>
  [name, await readFile(new URL('../extension/content/' + name + '.js', import.meta.url), 'utf8')]
)));
const appUrl = 'https://uchicago.okta.com/app/uchicago_canvas_1/example/sso/saml?SAMLRequest=synthetic-test';
const portalUrl = 'https://portal.uchicago.edu/ais/';
const coursesUrl = 'https://courses.uchicago.edu/';
function context(document, url = appUrl, extra = {}) {
  const value = { document, location: new URL(url), URL, Event, HTMLInputElement: Element, getComputedStyle: node => ({ visibility: 'visible', display: 'block', ...node.style }), ...extra };
  vm.createContext(value);
  vm.runInContext(scripts.routes, value);
  vm.runInContext(scripts.dom, value);
  return value;
}
function accountForm({ combined = false, password = false, heading = 'Sign in', buttonType, buttonText = 'Next' } = {}) {
  const username = e('input', { name: 'identifier', autocomplete: 'username' });
  const secret = e('input', { name: 'credentials.passcode', type: 'password', autocomplete: 'current-password' });
  const button = e('button', buttonType ? { type: buttonType } : {}, buttonText);
  const form = e('form', { 'data-se': 'o-form' }, e('h2', {}, heading), ...(password ? [] : [username]), ...(combined || password ? [secret] : []), button);
  return { form, username, secret, button };
}
function studentPage(hidden = false) {
  const studentLink = e('a', { href: STUDENT_LOGIN_URL }, 'my.UChicago\u00a0');
  const staffLink = e('a', { href: STUDENT_LOGIN_URL }, 'my.UChicago');
  const panel = e('div', { id: 'tab1' }, studentLink);
  panel.hidden = hidden;
  const studentTab = e('a', { role: 'tab', 'aria-controls': 'tab1', href: '#tab1' }, 'Students');
  studentTab.onClick = () => { panel.hidden = false; };
  const document = documentWith(
    studentTab, e('a', { role: 'tab', 'aria-controls': 'tab2' }, 'Staff'),
    panel, e('div', { id: 'tab2' }, staffLink)
  );
  return { document, studentLink, staffLink, studentTab };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function adapter(name, document, url, f = fixture(), documentId = 'okta-document') {
  const timers = [], listeners = [], calls = [], navigations = [];
  const from = { ...sender(new URL(url).origin, 7, documentId), url };
  f.frames.set(7, { url, documentId: from.documentId });
  const location = new URL(url);
  location.assign = target => navigations.push(target);
  const events = new Map(), mutations = [];
  const window = { addEventListener: (type, listener) => events.set(type, listener), postMessage() {} }; window.top = window;
  class MutationObserver {
    constructor(callback) { this.callback = callback; mutations.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const sendToTab = f.api.tabs.sendMessage;
  f.api.tabs.sendMessage = async (id, message, options) => {
    await sendToTab(id, message, options);
    if (id === from.tab.id && f.frames.get(id)?.documentId === from.documentId &&
        (!options?.documentId || options.documentId === from.documentId)) {
      for (const listener of listeners) listener(message);
    }
  };
  const runtime = {
    onMessage: { addListener: listener => listeners.push(listener) },
    async sendMessage(message) {
      calls.push(message);
      try { return { ok: true, result: await f.controller.dispatch(message, from) }; }
      catch (error) { return { ok: false, error: error.message }; }
    }
  };
  const c = context(document, url, { location, window, chrome: { runtime }, MutationObserver, Date: { now: f.clock }, crypto, TextEncoder, Uint8Array, setInterval: fn => timers.push(fn) });
  vm.runInContext(scripts[name], c);
  await flush();
  return { f, c, calls, navigations, from, listeners, events,
    mutate() { for (const observer of mutations) if (observer.connected) observer.callback(); },
    async tick() { await timers[0](); await flush(); } };
}

test('Canvas app SAML pages recognize delayed identifier, password, and combined forms', () => {
  for (const options of [{}, { password: true, heading: 'Verify with your password' }, { combined: true }]) {
    const { form, button, username, secret } = accountForm(options);
    const document = documentWith(e('form', { id: 'x509_login', hidden: true }), form);
    const result = context(document).UChiLoginDOM.detectOkta(document);
    assert.equal(result.kind, options.combined ? 'combined' : options.password ? 'password' : 'username');
    assert.equal(result.button, button);
    if (!options.password) assert.equal(result.username, username);
    if (options.password || options.combined) assert.equal(result.password, secret);
  }
});

test('Okta accepts a button without type and whitespace in its label', () => {
  const { form, button } = accountForm({ buttonText: '\n Sign \n in  ' });
  const document = documentWith(form);
  assert.equal(context(document).UChiLoginDOM.detectOkta(document).button, button);
  button.disabled = true;
  assert.equal(context(document).UChiLoginDOM.detectOkta(document).button, undefined);
});

test('Okta prefers a unique structural submit control regardless of its translated label', () => {
  for (const attrs of [{ id: 'okta-signin-submit', type: 'button' }, { 'data-type': 'save' }, { type: 'submit' }]) {
    const { form, button } = accountForm({ combined: true, heading: '\u5e33\u6236\u9a57\u8b49', buttonText: '\u7acb\u5373\u7e7c\u7e8c\u767b\u5165' });
    for (const [key, value] of Object.entries(attrs)) button.setAttribute(key, value);
    form.append(e('button', { type: 'button' }, 'Next'));
    const document = documentWith(form), dom = context(document).UChiLoginDOM;
    assert.equal(dom.detectOkta(document).button, button);
    button.disabled = true;
    assert.equal(dom.detectOkta(document).submitButton, button);
    assert.equal(dom.detectOkta(document).button, undefined);
    button.disabled = false;
    form.append(e('button', { type: 'submit' }, 'Continue'));
    assert.equal(dom.detectOkta(document).submitButton, undefined);
  }
});

test('Okta does not guess between multiple active structural forms', () => {
  const first = accountForm({ buttonType: 'submit' });
  const second = accountForm({ buttonType: 'submit' });
  const document = documentWith(first.form, second.form);
  assert.equal(context(document).UChiLoginDOM.detectOkta(document), null);
});

test('Okta handles exact active controls before layout creates client rectangles', async () => {
  const { form, username, secret, button } = accountForm({ combined: true, buttonType: 'submit' });
  for (const node of [form, username, secret, button]) node.getClientRects = () => [];
  const document = documentWith(form), dom = context(document).UChiLoginDOM;
  assert.equal(dom.visible(form), false);
  assert.equal(dom.exposed(form), true);
  assert.equal(dom.detectOkta(document).button, button);
  const a = await adapter('okta', document, appUrl);
  await a.f.approve(a.f.prompt()); await flush();
  assert.equal(username.value, 'test-student');
  assert.equal(secret.value, 'test-only-password');
  assert.equal(button.clicks, 1);
  form.setAttribute('aria-hidden', 'true');
  assert.equal(dom.detectOkta(document), null);
});

test('Chinese Okta recovery, code fields, and populated error containers are not sign-in forms', () => {
  for (const heading of ['\u8bbe\u7f6e\u5bc6\u7801', '\u8a2d\u5b9a\u5bc6\u78bc', '\u91cd\u8a2d\u5bc6\u78bc', '\u8f93\u5165\u9a8c\u8bc1\u7801', '\u8f38\u5165\u9a57\u8b49\u78bc']) {
    const { form } = accountForm({ password: true, heading, buttonType: 'submit' });
    const document = documentWith(form);
    assert.equal(context(document).UChiLoginDOM.detectOkta(document), null);
  }
  for (const autocomplete of ['new-password', 'one-time-code']) {
    const { form, secret } = accountForm({ password: true, heading: 'Continue', buttonType: 'submit' });
    secret.setAttribute('autocomplete', autocomplete);
    const document = documentWith(form);
    assert.equal(context(document).UChiLoginDOM.detectOkta(document), null);
  }
  const { form } = accountForm();
  const error = e('div', { 'data-se': 'o-form-error-container' }, '\u8acb\u7a0d\u5f8c\u518d\u8a66');
  const document = documentWith(form, error), dom = context(document).UChiLoginDOM;
  assert.equal(dom.detectOkta(document).kind, 'error');
  error.textContent = '';
  assert.equal(dom.detectOkta(document).kind, 'username');
});

test('Chinese Okta steps run on confirmation and rerender without waiting for polling', async () => {
  for (const labels of [['\u767b\u5f55', '\u901a\u8fc7\u5bc6\u7801\u9a8c\u8bc1', '\u4f7f\u7528 Duo Security \u8fdb\u884c\u9a8c\u8bc1', '\u4e0b\u4e00\u6b65'],
    ['\u767b\u5165', '\u4f7f\u7528\u5bc6\u78bc\u9a57\u8b49', '\u4f7f\u7528 Duo Security \u9a57\u8b49', '\u7e7c\u7e8c']]) {
    const { form, username, secret, button } = accountForm({ heading: labels[0], buttonType: 'submit', buttonText: labels[3] });
    const document = documentWith(form);
    button.onClick = () => {
      if (button.clicks === 1) form.replaceChildren(e('h2', {}, labels[1]), secret, button);
      else if (button.clicks === 2) form.replaceChildren(e('h2', {}, labels[2]), button);
      else document.body.replaceChildren(e('h1', {}, 'Redirecting'));
    };
    const a = await adapter('okta', document, appUrl);
    await a.f.approve(a.f.prompt()); await flush();
    assert.equal(button.clicks, 3);
    assert.equal(username.value, 'test-student'); assert.equal(secret.value, 'test-only-password');
    assert.equal(a.calls.filter(message => message.type === 'LOGIN_DETECTED').length, 1);
    a.mutate(); await flush(); assert.equal(button.clicks, 3);
  }
});

test('Duo redirect forms continue without filling account credentials', () => {
  const button = e('input', { type: 'submit', value: 'Verify' });
  const document = documentWith(e('form', {}, e('h2', {}, 'Duo Security'), 'You will be redirected to Duo Security.', button));
  const result = context(document).UChiLoginDOM.detectOkta(document);
  assert.equal(result.kind, 'duo');
  assert.equal(result.button, button);
  assert.equal(result.password, undefined);
});

test('password recovery, OTP, hidden fields, and account-management pages are excluded', () => {
  for (const heading of ['Reset password', 'New password', 'Enter a code', 'Verification code']) {
    const { form } = accountForm({ password: true, heading });
    const document = documentWith(form);
    assert.equal(context(document).UChiLoginDOM.detectOkta(document), null, heading);
  }
  const { form, secret } = accountForm({ password: true });
  secret.hidden = true;
  const document = documentWith(form);
  assert.equal(context(document).UChiLoginDOM.detectOkta(document), null);
  secret.hidden = false;
  for (const path of ['/', '/app/UserHome', '/enduser/settings', '/signin/forgot-password']) {
    assert.equal(context(document, 'https://uchicago.okta.com' + path).UChiLoginDOM.detectOkta(document), null);
  }
});

test('the Student link is selected by its panel and exact destination, not its duplicate Staff label', () => {
  const page = studentPage();
  const c = context(page.document, portalUrl);
  assert.equal(c.UChiLoginDOM.studentEntry(page.document).button, page.studentLink);
  page.studentLink.setAttribute('href', 'https://example.com/');
  assert.equal(c.UChiLoginDOM.studentEntry(page.document), null);
});

test('portal confirmation uses the fixed AIS endpoint without waiting for page rendering', async () => {
  const document = documentWith(); document.body.remove(); document.body = null;
  const a = await adapter('entry', document, portalUrl);
  assert.ok(a.f.prompt()); assert.equal(a.navigations.length, 0);
  await a.f.approve(a.f.prompt()); await flush();
  assert.deepEqual(a.navigations, [STUDENT_LOGIN_URL]);
  assert.ok(a.calls.every(message => !message.type.startsWith('LOGIN_')));
});

test('Courses waits for confirmation before using the fixed Canvas endpoint', async () => {
  const a = await adapter('entry', documentWith(), coursesUrl);
  assert.equal(a.navigations.length, 0);
  await a.f.approve(a.f.prompt());
  await a.tick();
  await a.tick();
  assert.deepEqual(a.navigations, [CANVAS_LOGIN_URL]);
});

test('Courses can prompt and continue before the page body loads', async () => {
  const document = documentWith(); document.body.remove(); document.body = null;
  const a = await adapter('entry', document, coursesUrl);
  assert.ok(a.f.prompt()); assert.equal(a.navigations.length, 0);
  await a.f.approve(a.f.prompt()); await flush();
  assert.deepEqual(a.navigations, [CANVAS_LOGIN_URL]);
  assert.equal(a.calls.filter(message => message.type === 'ENTRY_DETECTED').length, 1);
});

test('canceling an entry prompt does not navigate or prompt repeatedly', async () => {
  const a = await adapter('entry', documentWith(), coursesUrl);
  const p = a.f.prompt();
  await a.f.controller.dispatch({ type: 'PROMPT_DECIDE', id: p.id, action: 'cancel' }, ui('confirm.html?id=' + p.id));
  await a.tick(); await a.tick();
  assert.equal(a.navigations.length, 0);
  assert.equal(a.f.prompt(), undefined);
});

test('portal ignores rendered links and permits only the fixed controller target', async () => {
  const page = studentPage();
  page.studentLink.setAttribute('href', 'https://example.com/');
  const a = await adapter('entry', page.document, portalUrl);
  await a.f.approve(a.f.prompt()); await flush();
  assert.deepEqual(a.navigations, [STUDENT_LOGIN_URL]);
  assert.equal(page.studentLink.clicks, 0);
  assert.equal(page.staffLink.clicks, 0);
});

test('an Okta app form mounted after initial page load is filled only after confirmation', async () => {
  const document = documentWith();
  const a = await adapter('okta', document, appUrl);
  assert.equal(a.f.state(), undefined);
  const { form, username, secret, button } = accountForm({ combined: true });
  document.body.append(form);
  a.mutate(); await flush();
  assert.ok(a.f.prompt());
  assert.equal(secret.value, '');
  await a.f.approve(a.f.prompt());
  await flush();
  assert.equal(username.value, 'test-student');
  assert.equal(secret.value, 'test-only-password');
  assert.deepEqual(secret.events, ['input', 'change']);
  assert.equal(button.clicks, 1);
  a.f.advance(11_000); await a.tick();
  assert.equal(button.clicks, 1);
});


test('Duo menu detection ignores hidden headings and never chooses a verification method', () => {
  const hidden = e('h1', { hidden: true }, 'Other options to log in');
  const passkey = e('button', {}, 'Use a passkey');
  const securityKey = e('button', {}, 'Security key');
  const options = e('a', {}, 'Other options');
  const document = documentWith(hidden, passkey, securityKey, options);
  const dom = context(document, DUO).UChiLoginDOM;
  assert.equal(dom.duoMenuVisible(document), false);
  assert.equal(dom.duoChoice(document), options);
  options.hidden = true;
  assert.equal(dom.duoChoice(document), undefined);
  for (const title of ['Other options', 'Other options to log in', '\u5176\u4ed6\u9009\u9879']) {
    hidden.hidden = false;
    hidden.textContent = title;
    assert.equal(dom.duoMenuVisible(document), true);
  }
});

test('Duo recognizes its method-list structure and Chinese method labels additively', () => {
  const security = e('button', { class: 'auth-method' }, e('span', {}, '\u5b89\u5168\u91d1\u9470'));
  const manage = e('button', { class: 'auth-method' }, e('span', {}, '\u7ba1\u7406\u88dd\u7f6e'),
    e('div', { class: 'manage-devices-sub-description' }, '\u9a57\u8b49\u8eab\u5206'));
  const methods = e('ul', { class: 'all-auth-methods-list' }, e('li', {}, security), e('li', {}, manage));
  const document = documentWith(e('h1', {}, '\u9078\u64c7\u767b\u5165\u65b9\u5f0f'),
    e('select', { id: 'device-filter' }, e('option', {}, '\u6240\u6709\u88dd\u7f6e')), methods);
  const dom = context(document, DUO).UChiLoginDOM;
  assert.equal(dom.duoMenuVisible(document), true);
  assert.equal(dom.duoAction(document, 'login-key'), security);
  assert.equal(dom.duoAction(document, 'manage'), manage);
});

test('Other options authorization survives a replaced button and records only the displayed menu', async () => {
  const f = fixture(); await f.start({ setup: true }); const from = await f.toDuo();
  const document = documentWith(e('h1', {}, 'Use Touch ID'));
  const a = await adapter('duo', document, from.url, f, from.documentId);
  const old = e('a', {}, 'Other options'), fresh = e('a', {}, 'Other options');
  const send = a.c.chrome.runtime.sendMessage;
  let replaced = false;
  a.c.chrome.runtime.sendMessage = async message => {
    const response = await send(message);
    if (!replaced && message.type === 'DUO_MENU' && message.open === true) {
      replaced = true; document.body.replaceChildren(e('h1', {}, 'Use Touch ID'), fresh);
    }
    return response;
  };
  document.body.append(old); a.mutate(); await flush();
  assert.equal(old.clicks, 0); assert.equal(fresh.clicks, 1);
  assert.equal(f.state().flows[7].duoMenuHandled, undefined);
  assert.equal(f.state().flows[7].duo.phase, 'start');
  await a.tick(); assert.equal(fresh.clicks, 1);
  document.body.replaceChildren(e('h1', {}, 'Select an option to log in'), e('button', {}, 'Duo Push'));
  a.mutate(); await flush();
  assert.equal(f.state().flows[7].duoMenuHandled, true);
  const later = e('a', {}, 'Other options');
  document.body.replaceChildren(e('h1', {}, 'Verify your identity before managing devices'), later);
  a.mutate(); await a.tick(); assert.equal(later.clicks, 0);
});

test('the English options link is clicked before a status poll or any passkey request', async () => {
  for (const label of ['Other options', 'Show other options']) {
    const f = fixture(); await f.start({ setup: true }); const from = await f.toDuo();
    const button = e('a', {}, label), document = documentWith(e('h1', {}, 'Use Touch ID'), button);
    const a = await adapter('duo', document, from.url, f, from.documentId);
    assert.equal(button.clicks, 1);
    assert.equal(a.calls[0].type, 'DUO_MENU');
    assert.equal(a.calls.some(call => call.type === 'PK_BEGIN'), false);
    await a.tick(); assert.equal(button.clicks, 1);
  }
});

test('Duo opens the menu once and leaves later Push and device verification untouched', async () => {
  const f = fixture(); await f.start({ setup: true }); const from = await f.toDuo();
  const options = e('button', {}, 'Other options');
  const passkey = e('button', {}, 'Use a passkey');
  const push = e('button', {}, 'Duo Push');
  const laterOptions = e('button', {}, 'Other options');
  const document = documentWith(passkey, options);
  options.onClick = () => document.body.replaceChildren(e('h1', {}, 'Other options to log in'), passkey, push);
  const a = await adapter('duo', document, from.url, f, from.documentId);
  await a.tick(); await a.tick();
  assert.equal(options.clicks, 1);
  assert.equal(passkey.clicks, 0);
  push.click();
  document.body.replaceChildren(e('h1', {}, 'Verify your identity before managing devices'), laterOptions,
    e('div', { role: 'alert' }, 'Duo Push failed. Try again.'));
  await a.tick(); await a.tick();
  assert.equal(laterOptions.clicks, 0);
  assert.equal(push.clicks, 1);
  assert.equal(a.calls.some(message => message.type === 'FLOW_ERROR'), false);
  assert.equal(f.state().flows[7].status, 'active');
});

test('a displayed Duo menu stops navigation even without an automatic click', async () => {
  for (const seenBy of ['initial render', 'mutation', 'user click']) {
    const f = fixture(); await f.start({ setup: true }); const from = await f.toDuo();
    const document = documentWith();
    const showMenu = () => document.body.replaceChildren(e('h1', {}, 'Other options to log in'), e('button', {}, 'Duo Push'));
    if (seenBy === 'initial render') showMenu();
    const a = await adapter('duo', document, from.url, f, from.documentId);
    if (seenBy !== 'initial render') {
      showMenu();
      if (seenBy === 'mutation') a.mutate();
      else a.events.get('click')({ isTrusted: true, target: document.body });
    }
    const options = e('button', {}, 'Other options');
    document.body.replaceChildren(e('h1', {}, 'Verify your identity before managing devices'), options);
    await flush(); await a.tick();
    assert.equal(options.clicks, 0, seenBy);
    assert.equal(f.state().flows[7].duoMenuHandled, true, seenBy);
    assert.ok(a.calls.some(message => (message.type === 'DUO_MENU' && message.open === false) || (message.type === 'DUO_STEP' && message.step === 'identity')), seenBy);
  }
});

function rememberDevicePage() {
  const yes = e('button', {}, 'Yes, this is my device');
  const no = e('a', {}, 'No, other people use this device');
  const heading = e('h1', {}, 'Is this your device?');
  return { yes, no, heading, document: documentWith(heading, yes, no) };
}

test('Duo device remembering requires its specific visible question and affirmative choice', () => {
  const { document, heading, yes } = rememberDevicePage();
  const dom = context(document, DUO).UChiLoginDOM;
  assert.equal(dom.duoAction(document, 'remember-device'), yes);
  heading.textContent = 'IS THIS YOUR DEVICE?';
  yes.textContent = '  YES,\n this is my device  ';
  assert.equal(dom.duoAction(document, 'remember-device'), yes);
  heading.textContent = '\u8fd9\u662f\u60a8\u7684\u8bbe\u5907\u5417\uff1f';
  yes.textContent = '\u662f\u7684\uff0c\u8fd9\u662f\u6211\u7684\u8bbe\u5907';
  assert.equal(dom.duoAction(document, 'remember-device'), yes);
  yes.disabled = true;
  assert.equal(dom.duoAction(document, 'remember-device'), undefined);
  yes.disabled = false; heading.hidden = true;
  assert.equal(dom.duoAction(document, 'remember-device'), undefined);
  heading.hidden = false; heading.textContent = 'Delete this device?';
  assert.equal(dom.duoAction(document, 'remember-device'), undefined);
  heading.textContent = 'Is this your device?'; yes.textContent = 'Yes';
  assert.equal(dom.duoAction(document, 'remember-device'), undefined);
  yes.textContent = 'Yes, this is my device';
  document.body.append(e('button', {}, 'Yes, this is my device'));
  assert.equal(dom.duoAction(document, 'remember-device'), undefined);
});

test('Duo selects Yes once after verification, including manual mode, without changing the flow phase', async () => {
  for (const phase of ['authenticating', 'manual']) {
    const f = fixture();
    if (phase === 'manual') f.api.storage.local.data.settings.automaticLogin = false;
    await f.start(); const from = await f.toDuo();
    await f.controller.exclusive(() => { f.controller.state.flows[7].duo.phase = phase; });
    const page = rememberDevicePage();
    const a = await adapter('duo', page.document, from.url, f, from.documentId);
    await a.tick(); a.mutate(); await a.tick();
    assert.equal(page.yes.clicks, 1);
    assert.equal(page.no.clicks, 0);
    assert.equal(f.state().flows[7].duo.phase, phase);
    assert.equal(f.state().flows[7].status, 'active');
    assert.equal(a.calls.filter(message => message.step === 'remember-device').length, 1);
  }
});

test('the optional device prompt can appear later or be skipped entirely', async () => {
  const f = fixture(); await f.start(); const from = await f.toDuo();
  await f.controller.exclusive(() => { f.controller.state.flows[7].duo.phase = 'authenticating'; });
  const document = documentWith(e('h1', {}, 'Success! Logging you in...'));
  const a = await adapter('duo', document, from.url, f, from.documentId);
  f.advance(10_000); await a.tick();
  assert.equal(a.calls.some(message => message.step === 'remember-device' || message.type === 'FLOW_ERROR'), false);
  assert.equal(f.state().flows[7].duo.phase, 'authenticating');
  const { heading, yes, no } = rememberDevicePage();
  document.body.replaceChildren(heading, yes, no); a.mutate(); await a.tick();
  assert.equal(yes.clicks, 1);
});

test('a changed device-confirmation button is rechecked and the replacement remains retryable', async () => {
  const f = fixture(); await f.start(); const from = await f.toDuo();
  const document = documentWith();
  const a = await adapter('duo', document, from.url, f, from.documentId);
  const { heading, yes, no } = rememberDevicePage();
  const replacement = e('button', {}, 'Yes, this is my device');
  document.body.replaceChildren(heading, yes, no);
  const send = a.c.chrome.runtime.sendMessage;
  let replaced = false;
  a.c.chrome.runtime.sendMessage = async message => {
    const result = await send(message);
    if (!replaced && message.step === 'remember-device') {
      document.body.replaceChildren(heading, replacement, no); replaced = true;
    }
    return result;
  };
  await a.tick(); assert.equal(yes.clicks, 0);
  await a.tick(); await a.tick();
  assert.equal(replacement.clicks, 1);
  assert.equal(no.clicks, 0);
});

function deviceList(...keys) {
  const card = (name, type) => e('article', {}, e('header', {}, e('h3', {}, name), e('button', {}, 'Edit')), e('p', {}, type));
  return [e('a', {}, 'Back to login \u2192'), card('This computer', 'Touch ID (Chrome)'),
    ...keys.map(key => card(key, 'Security Key')), e('button', {}, e('h3', {}, 'Add a device'))];
}

test('Duo device inventory recognizes cards without confusing the add-device tile with a wizard', () => {
  const document = documentWith(...deviceList('Travel key'));
  const dom = context(document).UChiLoginDOM;
  assert.equal(dom.duoInventory(document).length, 1);
  assert.match(dom.duoInventory(document)[0], /Travel key/);
  document.body.append(e('div', { role: 'progressbar' }));
  assert.equal(dom.duoInventory(document), null);
  document.body.replaceChildren(e('h1', {}, 'Verify your identity'), e('button', {}, 'Security key'));
  assert.equal(dom.duoIdentity(document), false);
  document.body.replaceChildren(e('h1', {}, 'Verify your identity before managing devices'), e('button', {}, 'Other options'));
  assert.equal(dom.duoIdentity(document), true);
  assert.equal(dom.duoAction(document, 'manage'), undefined);
});

test('Duo adapter completes the enrollment screens without interrupting manual verification', async () => {
  const f = fixture(); f.permissions.add(DUO_MATCH); await f.start({ setup: true }); const from = await f.toDuo();
  const options = e('button', {}, 'Other options');
  const manage = e('a', {}, 'Manage devices');
  const identityOptions = e('button', {}, 'Other options');
  const document = documentWith(e('h1', {}, 'Check Duo Mobile'), options);
  options.onClick = () => document.body.replaceChildren(e('h1', {}, 'Other options to log in'), manage);
  manage.onClick = () => document.body.replaceChildren(e('h1', {}, 'Verify your identity before managing devices'), identityOptions);
  const first = await adapter('duo', document, from.url, f, from.documentId);
  await first.tick(); await first.tick();
  assert.equal(options.clicks, 1); assert.equal(manage.clicks, 1);
  await first.tick(); await first.tick();
  assert.equal(identityOptions.clicks, 0);
  const url = 'https://uw1.devicemanagement.duosecurity.com/frame/device-management/portal';
  f.frames.set(7, { url, documentId: 'manager' });
  await f.controller.navigation({ tabId: 7, frameId: 0, url, documentId: 'manager', transitionType: 'link', transitionQualifiers: ['server_redirect'] });
  const managerDocument = documentWith(...deviceList('Existing key'));
  const add = managerDocument.body.children.at(-1);
  const security = e('button', {}, e('strong', {}, 'Security key'), e('span', {}, 'Use a security key'));
  const proceed = e('button', {}, 'Continue');
  add.onClick = () => managerDocument.body.replaceChildren(e('h1', {}, 'Add a device'), security);
  security.onClick = () => managerDocument.body.replaceChildren(e('h1', {}, 'Set up security key'), proceed);
  const manager = await adapter('duo', managerDocument, url, f, 'manager');
  f.advance(700); await manager.tick(); await flush();
  assert.deepEqual([add.clicks, security.clicks, proceed.clicks], [1, 1, 1]);
  const callsBefore = manager.calls.length;
  await flush(); await flush();
  assert.equal(manager.calls.length, callsBefore, 'A pending registration must not busy-loop.');
  await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation() }, manager.from);
  await f.approve(f.prompt());
  managerDocument.body.replaceChildren(...deviceList('Existing key', 'New key'));
  const back = managerDocument.body.children[0];
  await manager.tick(); f.advance(700); await manager.tick(); await flush();
  assert.equal(back.clicks, 1);
  assert.equal(f.state().flows[7].duo.phase, 'returning');
  assert.equal((await f.vault.read()).credentials[0].registrationPending, false);
  const returnUrl = DUO + '/frame/v4/auth';
  f.frames.set(7, { url: returnUrl, documentId: 'returning' });
  await f.controller.navigation({ tabId: 7, frameId: 0, url: returnUrl, documentId: 'returning', transitionType: 'link', transitionQualifiers: ['server_redirect'] });
  const menu = e('button', {}, 'Other options'), useKey = e('button', {}, 'Security Key');
  const returnDocument = documentWith(menu);
  menu.onClick = () => returnDocument.body.replaceChildren(e('h1', {}, 'Other options to log in'), useKey);
  const last = await adapter('duo', returnDocument, returnUrl, f, 'returning');
  await last.tick(); await last.tick(); await last.tick();
  assert.equal(menu.clicks, 1); assert.equal(useKey.clicks, 1);
});


test('only explicit visible unregistered-key messages qualify as a rejection', () => {
  for (const [text, expected] of [
    ['This security key is not registered.', true],
    ['Your security key has been removed.', true],
    ['The request was canceled or timed out.', false],
    ['Something went wrong. Try again.', false]
  ]) {
    const alert = e('div', { role: 'alert' }, text), document = documentWith(alert);
    const dom = context(document).UChiLoginDOM;
    assert.equal(dom.duoKeyRejected(document), expected);
    alert.hidden = true; assert.equal(dom.duoKeyRejected(document), false);
  }
});


test('a canceled default-method error does not end the flow before another option appears', async () => {
  const f = fixture(); await f.start({ setup: true }); const from = await f.toDuo();
  const document = documentWith(e('div', { role: 'alert' }, 'The request was canceled or timed out.'));
  const a = await adapter('duo', document, from.url, f, from.documentId);
  await a.tick(); assert.equal(f.state().flows[7].status, 'active');
  const options = e('button', {}, 'Other options');
  document.body.append(options); a.mutate(); await a.tick();
  assert.equal(options.clicks, 1); assert.equal(a.calls.some(call => call.type === 'FLOW_ERROR'), false);
});


test('Duo method cards are recognized without relying on a particular menu heading', () => {
  const key = e('a', {}, e('div', {}, 'Security key'), e('div', {}, 'Use your security key'));
  const manage = e('div', { role: 'link' }, e('div', {}, 'Manage devices'));
  const document = documentWith(e('div', {}, 'Choose an option'), key, manage);
  const dom = context(document).UChiLoginDOM;
  assert.equal(dom.duoMenuVisible(document), true);
  assert.equal(dom.duoAction(document, 'login-key'), key);
  document.body.replaceChildren(e('h1', {}, 'Add a device'), key);
  assert.equal(dom.duoAction(document, 'login-key'), undefined);
  document.body.replaceChildren(e('h1', {}, 'Verify your identity before managing devices'), key, manage);
  assert.equal(dom.duoAction(document, 'login-key'), undefined);
});

test('returning to an already displayed Duo menu selects the key without a polling tick', async () => {
  const f = fixture({ credentials: [{ id: 'key', rpId: 'duosecurity.com', userName: 'test-student' }] });
  await f.start(); const from = await f.toDuo();
  await f.controller.exclusive(() => { f.controller.state.flows[7].duo.phase = 'returning'; });
  const key = e('button', {}, '\u5b89\u5168\u5bc6\u94a5');
  const a = await adapter('duo', documentWith(e('h1', {}, '\u5176\u4ed6\u9009\u9879'), key), from.url, f, from.documentId);
  await flush();
  assert.equal(key.clicks, 1); assert.equal(f.state().flows[7].duo.phase, 'authenticating');
  a.mutate(); await flush(); assert.equal(key.clicks, 1);
});

test('a menu rerender during click authorization stays retryable and clicks the replacement once', async () => {
  const f = fixture({ credentials: [{ id: 'key', rpId: 'duosecurity.com', userName: 'test-student' }] });
  await f.start(); const from = await f.toDuo();
  const old = e('button', {}, 'Security key'), fresh = e('a', {}, e('div', {}, 'Security key'), e('div', {}, 'Use your security key'));
  const document = documentWith(e('h1', {}, 'Other options'), old);
  const a = await adapter('duo', document, from.url, f, from.documentId);
  const send = a.c.chrome.runtime.sendMessage;
  let replaced = false;
  a.c.chrome.runtime.sendMessage = async message => {
    const result = await send(message);
    if (!replaced && message.type === 'DUO_STEP' && message.step === 'login-key') {
      document.body.replaceChildren(e('h1', {}, 'Other options'), fresh); replaced = true;
    }
    return result;
  };
  // The first render may already have advanced to the menu; reset only its click counter.
  old.clicks = 0;
  await f.controller.exclusive(() => { f.controller.state.flows[7].duo.phase = 'menu'; });
  await a.tick();
  assert.equal(old.clicks, 0); assert.equal(f.state().flows[7].duo.phase, 'menu');
  await a.tick(); await f.controller.tail;
  assert.equal(fresh.clicks, 1); assert.equal(f.state().flows[7].duo.phase, 'authenticating');
  await a.tick(); assert.equal(fresh.clicks, 1);
});


test('Okta advances across reused buttons without a timer or duplicate submissions', async () => {
  const { form, username, secret, button } = accountForm();
  const document = documentWith(form);
  button.onClick = () => {
    if (button.clicks === 1) form.replaceChildren(e('h2', {}, 'Verify with your password'), secret, button);
    else if (button.clicks === 2) form.replaceChildren(e('h2', {}, 'Duo Security'), button);
    else document.body.replaceChildren(e('h1', {}, 'Redirecting'));
  };
  const a = await adapter('okta', document, appUrl);
  for (let i = 0; i < 8; i++) a.mutate();
  await flush(); assert.equal(a.f.windows.size, 1);
  await a.f.approve(a.f.prompt()); await flush();
  assert.equal(username.value, 'test-student'); assert.equal(secret.value, 'test-only-password');
  assert.equal(button.clicks, 3);
  assert.deepEqual(a.calls.filter(message => message.type === 'LOGIN_STEP').map(message => message.step), ['username', 'password', 'duo']);
  for (let i = 0; i < 8; i++) a.mutate();
  await flush(); assert.equal(button.clicks, 3);
});

test('Okta fills once and waits for an enabled submit button without retaining expired approval', async () => {
  for (const outcome of ['enabled', 'expired', 'paused']) {
    const { form, secret, button } = accountForm({ combined: true }); button.disabled = true;
    const document = documentWith(form), a = await adapter('okta', document, appUrl);
    await a.f.approve(a.f.prompt()); await flush();
    assert.equal(secret.value, 'test-only-password'); assert.equal(button.clicks, 0);
    if (outcome === 'expired') a.f.advance(300_000);
    if (outcome === 'paused') await a.f.controller.dispatch({ type: 'UI_TOGGLE', enabled: false }, ui('popup.html'));
    button.disabled = false; a.mutate(); await flush();
    assert.equal(button.clicks, outcome === 'enabled' ? 1 : 0, outcome);
    a.mutate(); await a.tick();
    assert.equal(secret.events.filter(type => type === 'input').length, 1);
    assert.equal(a.calls.filter(message => message.type === 'LOGIN_STEP').length, 1);
  }
});

test('Okta does not fill a form replaced while authorization is pending', async () => {
  const original = accountForm({ combined: true }), replacement = accountForm({ combined: true });
  const document = documentWith(original.form), a = await adapter('okta', document, appUrl);
  const send = a.c.chrome.runtime.sendMessage;
  a.c.chrome.runtime.sendMessage = async message => {
    const result = await send(message);
    if (message.type === 'LOGIN_STEP') document.body.replaceChildren(replacement.form);
    return result;
  };
  await a.f.approve(a.f.prompt()); await flush(); a.mutate(); await a.tick();
  assert.equal(original.secret.value, ''); assert.equal(replacement.secret.value, '');
  assert.equal(original.button.clicks + replacement.button.clicks, 0);
  assert.equal(a.f.state().flows[7].status, 'error');
});

test('Duo method matching handles accessible labels, case, whitespace and nested descriptions', () => {
  for (const label of ['SeCuRiTy \u00a0\u200bKeY', 'SECURITY\n\tKEY', '\uFF33\uFF45\uFF43\uFF55\uFF52\uFF49\uFF54\uFF59 key']) {
    for (const attributes of [{ 'aria-label': label }, { 'aria-labelledby': 'key-name' }, { title: label }]) {
      const key = e('div', { role: 'menuitem', ...attributes }, e('p', {}, 'An updated description'));
      const manage = e('a', { 'aria-label': 'MANAGE\u00a0DEVICES' }, 'Devices');
      const document = documentWith(e('span', { id: 'key-name', hidden: true }, label), key, manage);
      const dom = context(document, DUO).UChiLoginDOM;
      assert.equal(dom.duoMenuVisible(document), true, label);
      assert.equal(dom.duoAction(document, 'login-key'), key, label);
      key.setAttribute('aria-disabled', 'true');
      assert.equal(dom.duoAction(document, 'login-key'), undefined);
    }
  }
  const document = documentWith(e('h1', {}, 'Other options'), e('button', {}, 'Security key'), e('a', {}, 'Security Key'));
  assert.equal(context(document, DUO).UChiLoginDOM.duoAction(document, 'login-key'), undefined);
});


test('portal approval navigates only once when later mutations and lifecycle events arrive', async () => {
  const document = documentWith(), a = await adapter('entry', document, portalUrl);
  await a.f.approve(a.f.prompt()); await flush();
  assert.deepEqual(a.navigations, [STUDENT_LOGIN_URL]);
  a.mutate(); a.events.get('DOMContentLoaded')?.(); a.events.get('pageshow')?.(); await flush();
  await a.tick();
  assert.deepEqual(a.navigations, [STUDENT_LOGIN_URL]);
});

test('Duo identity guidance stays noninteractive, follows the chosen language and disappears when paused', async () => {
  const f = fixture(); await f.start({ setup: true }); const from = await f.toDuo();
  f.api.i18n = { getUILanguage: () => 'zh-HK' };
  const method = e('button', {}, 'Duo Push');
  const document = documentWith(e('h1', {}, 'Verify your identity before managing devices'), method);
  const a = await adapter('duo', document, from.url, f, from.documentId);
  await a.tick();
  const notice = document.getElementById('uchicago-login-assistant-identity');
  assert.ok(notice);
  const box = notice._shadowRoot.querySelector('[role="status"]');
  assert.equal(box.getAttribute('lang'), 'zh-CN');
  assert.equal(box.querySelector('strong').textContent, '\u8bf7\u5148\u5b8c\u6210 Duo \u9a8c\u8bc1');
  assert.equal(box.querySelectorAll('button, input, a, select').length, 0);
  assert.equal(method.clicks, 0);
  await f.api.storage.local.set({ uiLanguage: 'en-US' }); await a.tick();
  assert.equal(box.querySelector('strong').textContent, 'Verify with Duo');
  assert.match(box.querySelector('p').textContent, /Choose a verification method/);
  document.body.replaceChildren(e('h1', {}, 'Other options'), method); a.mutate(); await a.tick();
  assert.ok(document.getElementById('uchicago-login-assistant-identity')); assert.equal(method.clicks, 0);
  await f.controller.dispatch({ type: 'UI_TOGGLE', enabled: false }, ui('popup.html')); await a.tick();
  assert.equal(document.getElementById('uchicago-login-assistant-identity'), null);
});
