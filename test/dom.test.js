import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Element, element as e, documentWith } from './dom-fixture.mjs';
import { fixture, sender, ui } from './helpers.mjs';
import { STUDENT_LOGIN_URL, CANVAS_LOGIN_URL } from '../extension/core/policy.js';

const scripts = Object.fromEntries(await Promise.all(['routes', 'dom', 'entry', 'okta'].map(async name =>
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
async function adapter(name, document, url, f = fixture()) {
  const timers = [], listeners = [], calls = [], navigations = [];
  const from = { ...sender(new URL(url).origin), url };
  f.frames.set(7, { url, documentId: from.documentId });
  const location = new URL(url);
  location.assign = target => navigations.push(target);
  const window = {}; window.top = window;
  const runtime = {
    onMessage: { addListener: listener => listeners.push(listener) },
    async sendMessage(message) {
      calls.push(message);
      try { return { ok: true, result: await f.controller.dispatch(message, from) }; }
      catch (error) { return { ok: false, error: error.message }; }
    }
  };
  const c = context(document, url, { location, window, chrome: { runtime }, Date: { now: f.clock }, setInterval: fn => timers.push(fn) });
  vm.runInContext(scripts[name], c);
  await flush();
  return { f, c, calls, navigations, from, listeners, async tick() { await timers[0](); await flush(); } };
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

test('portal clicks only the Student button after confirmation, once, in the same tab', async () => {
  const page = studentPage(true);
  const a = await adapter('entry', page.document, portalUrl);
  assert.equal(page.studentLink.clicks, 0);
  assert.equal(page.studentTab.clicks, 0);
  assert.ok(a.f.prompt());
  await a.f.approve(a.f.prompt());
  await a.tick();
  await a.tick();
  assert.equal(page.studentTab.clicks, 1);
  assert.equal(page.studentLink.clicks, 1);
  assert.equal(page.studentLink.target, '_self');
  assert.equal(page.staffLink.clicks, 0);
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

test('canceling an entry prompt does not navigate or prompt repeatedly', async () => {
  const a = await adapter('entry', documentWith(), coursesUrl);
  const p = a.f.prompt();
  await a.f.controller.dispatch({ type: 'PROMPT_DECIDE', id: p.id, action: 'cancel' }, ui('confirm.html?id=' + p.id));
  await a.tick(); await a.tick();
  assert.equal(a.navigations.length, 0);
  assert.equal(a.f.prompt(), undefined);
});

test('a missing or changed Student link times out without clicking a different destination', async () => {
  const page = studentPage();
  const a = await adapter('entry', page.document, portalUrl);
  await a.f.approve(a.f.prompt());
  page.studentLink.setAttribute('href', 'https://example.com/');
  await a.tick();
  a.f.advance(16_000);
  await a.tick();
  assert.equal(page.studentLink.clicks, 0);
  assert.equal(page.staffLink.clicks, 0);
  assert.equal(a.f.state().flows[7].status, 'error');
});

test('an Okta app form mounted after initial page load is filled only after confirmation', async () => {
  const document = documentWith();
  const a = await adapter('okta', document, appUrl);
  assert.equal(a.f.state(), undefined);
  const { form, username, secret, button } = accountForm({ combined: true });
  document.body.append(form);
  await a.tick();
  assert.ok(a.f.prompt());
  assert.equal(secret.value, '');
  await a.f.approve(a.f.prompt());
  await a.tick();
  assert.equal(username.value, 'test-student');
  assert.equal(secret.value, 'test-only-password');
  assert.deepEqual(secret.events, ['input', 'change']);
  assert.equal(button.clicks, 1);
  a.f.advance(11_000); await a.tick();
  assert.equal(button.clicks, 1);
});
