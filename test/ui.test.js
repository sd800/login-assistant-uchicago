import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Element, element as e, documentWith } from './dom-fixture.mjs';
import { fixture, ui, OKTA, DUO, sender, creation } from './helpers.mjs';
import { emptyVault, newPin } from '../extension/core/vault.js';
import { CONFIRM_TEXT } from '../extension/core/policy.js';
import { PORTAL_URL } from '../extension/core/shortcut.js';
import { createLanguagePreference, translate } from '../extension/core/locale.js';

// Execute the actual page handlers against in-memory Chrome and DOM doubles.
async function page(name, f = fixture()) {
  const html = await readFile(new URL('../extension/' + name + '.html', import.meta.url), 'utf8');
  const source = (await readFile(new URL('../extension/' + (name === 'start' ? 'confirm' : name) + '.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const nodes = {};
  for (const [, tag, before, id, after] of html.matchAll(/<([a-z][\w-]*)\b([^>]*)\bid="([^"]+)"([^>]*)>/gi)) {
    const attrs = { id };
    for (const [, key, value] of (before + after).matchAll(/([:\w-]+)(?:="([^"]*)")?/g)) attrs[key] = value ?? '';
    nodes[id] = e(tag, attrs);
    nodes[id].disabled = Object.hasOwn(attrs, 'disabled');
    nodes[id].hidden = Object.hasOwn(attrs, 'hidden');
  }
  const document = documentWith(...Object.values(nodes));
  document.createElement = tag => e(tag, {});
  const calls = [], permissionRequests = [], hooks = {};
  const pagePath = name + '.html' + (name === 'confirm' ? '?id=' + (Object.keys(f.state()?.prompts ?? {})[0] ?? 'missing') : '');
  const state = { settingsOpened: 0, closed: false, confirmationRequests: [], confirmResult: true, validityChecks: 0, destinations: [] };
  const from = name === 'start' ? { ...ui(pagePath), tab: { id: 7 }, frameId: 0, documentId: 'shortcut-document' } : ui(pagePath);
  if (name === 'start') f.frames.set(7, { url: from.url, documentId: from.documentId });
  const api = async message => {
    calls.push(JSON.parse(JSON.stringify(message)));
    await hooks.before?.(message);
    return f.controller.dispatch(message, from);
  };
  const text = (node, message, params = {}) => {
    const values = typeof params === 'function' ? params() : params;
    node.textContent = message.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
  };
  if (nodes['confirm-form']) nodes['confirm-form'].reportValidity = () => {
    state.validityChecks++;
    return !nodes.pin.required || !!nodes.pin.value;
  };
  const context = {
    URL, location: { href: ui(pagePath).url, replace: target => state.destinations.push(target) }, CONFIRM_TEXT, PORTAL_URL,
    Date: class extends Date { static now() { return f.clock(); } },
    setInterval: () => 1,
    document, $: id => nodes[id], api, t: (value, params = {}) => value.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? ''), bindText: text,
    localize: (node, render, attribute) => attribute ? node.setAttribute(attribute, render()) : node.textContent = render(),
    status: (node, message, error = false) => { node.textContent = message; node.error = error; },
    date: value => String(value), initializeLocale: async () => {}, getLocale: () => 'en-US', setLocale: async () => {},
    duoOrigin: value => { const url = new URL(value); if (!url.hostname.endsWith('.duosecurity.com')) throw new Error('Invalid Duo URL'); return url.origin; },
    Option: function(text, value) { return new Element('option', { value }, text); },
    confirm: message => { state.confirmationRequests.push(message); return state.confirmResult; },
    chrome: {
      storage: f.api.storage,
      permissions: { request: async request => { permissionRequests.push(request); return true; } },
      runtime: { openOptionsPage: () => { state.settingsOpened++; } },
      tabs: { query: async () => [{ id: 7 }] }
    },
    window: { close: () => { state.closed = true; } }
  };
  vm.createContext(context);
  await vm.runInContext('(async () => {\n' + source + '\n})()', context);
  return { nodes, calls, permissionRequests, hooks, state, f, html, document };
}

test('only a new installation opens Settings, not worker startup, updates, or browser restart', async () => {
  const f = fixture(), hooks = {};
  let opened = 0;
  for (const [namespace, events] of Object.entries({
    runtime: ['onMessage', 'onInstalled', 'onStartup'], webNavigation: ['onCommitted', 'onHistoryStateUpdated', 'onDOMContentLoaded', 'onCompleted'],
    tabs: ['onRemoved'], windows: ['onRemoved'], alarms: ['onAlarm'], permissions: ['onRemoved', 'onAdded']
  })) {
    f.api[namespace] ||= {};
    for (const event of events) f.api[namespace][event] = { addListener: fn => { hooks[namespace + '.' + event] = fn; } };
  }
  for (const area of ['local', 'session']) f.api.storage[area].setAccessLevel = async () => {};
  f.api.i18n = { getUILanguage: () => 'en-US' };
  f.api.action = { setTitle: async () => {} };
  f.api.alarms.create = async () => {};
  f.api.runtime.openOptionsPage = async () => { opened++; };
  const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const context = vm.createContext({
    chrome: f.api, createLanguagePreference, translate,
    Controller: class { constructor() { return f.controller; } },
    Vault: class { constructor() { return f.vault; } }, indexedRepository: () => {}
  });
  vm.runInContext(source, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  assert.equal(opened, 0);
  for (const reason of ['update', 'chrome_update', 'shared_module_update']) hooks['runtime.onInstalled']({ reason });
  hooks['runtime.onStartup']();
  await settle();
  assert.equal(opened, 0);
  hooks['runtime.onInstalled']({ reason: 'install' });
  await settle();
  assert.equal(opened, 1);
  hooks['runtime.onInstalled']({ reason: 'update' });
  hooks['runtime.onStartup']();
  await settle();
  assert.equal(opened, 1);

  f.sent.length = 0;
  const details = { tabId: 7, frameId: 0, documentId: 'okta-document', url: `${OKTA}/login` };
  hooks['webNavigation.onDOMContentLoaded'](details);
  hooks['webNavigation.onCompleted'](details);
  await settle();
  assert.equal(JSON.stringify(f.sent), JSON.stringify([
    { id: 7, message: { type: 'FLOW_WAKE' } },
    { id: 7, message: { type: 'FLOW_WAKE' } }
  ]));
});

test('saving Account preserves the other form and PIN inputs', async () => {
  const p = await page('settings');
  p.nodes.password.value = ' updated password ';
  p.nodes['new-pin'].value = 'unsaved-pin';
  await p.nodes['account-form'].emit('submit');
  assert.equal((await p.f.vault.read()).password, ' updated password ');
  assert.equal(p.nodes.password.value, '');
  assert.equal(p.nodes['new-pin'].value, 'unsaved-pin');
  assert.equal(p.permissionRequests.length, 0);
  assert.equal(p.calls.find(c => c.type === 'UI_SAVE_ACCOUNT').duoOrigin, undefined);
  assert.equal(p.calls.some(c => c.type === 'UI_SETUP_PASSKEY'), true);
  assert.equal(p.f.prompt().kind, 'setup');
});



test('a failed account save retains the password and leaves its fields usable', async () => {
  const p = await page('settings');
  p.nodes.password.value = 'draft-password';
  p.hooks.before = message => { if (message.type === 'UI_SAVE_ACCOUNT') throw new Error('Storage unavailable'); };
  await p.nodes['account-form'].emit('submit');
  assert.equal(p.nodes.password.value, 'draft-password');
  assert.equal(p.nodes['save-account'].disabled, false);
  assert.equal(p.nodes.username.disabled, false);
  assert.equal(p.nodes['account-status'].error, true);
});

test('Settings describes password, passkey, and PIN encryption from their saved state', async () => {
  const saved = await page('settings');
  assert.equal(saved.nodes['password-help'].hidden, false);
  assert.equal(saved.nodes['password-help-text'].textContent,
    'Your username and password have been securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.');
  assert.equal(saved.nodes['passkey-storage-help'].textContent,
    'Passkeys will be securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.');
  assert.equal(saved.nodes['pin-storage-help'].hidden, true);
  assert.equal(saved.nodes['pin-storage-help-text'].textContent, '');
  saved.nodes['pin-settings'].open = true;
  await saved.nodes['pin-settings'].emit('toggle');
  assert.equal(saved.nodes['pin-storage-help'].hidden, false);
  assert.equal(saved.nodes['pin-storage-help-text'].textContent,
    'If you choose to set up a verification PIN, it will be securely saved on this device using industry-standard encryption and will only be used for sign-in verification.');
  assert.ok(saved.html.indexOf('class="credential-lock secure-help-lock" aria-hidden="true"') < saved.html.indexOf('id="password-help-text"'));

  saved.nodes.username.value = 'another-account';
  await saved.nodes.username.emit('input');
  assert.equal(saved.nodes['password-help-text'].textContent,
    'Your username and password will be securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.');

  const one = await page('settings', fixture({ credentials: [
    { id: 'one-key', rpId: 'duosecurity.com', userName: 'test-student', createdAt: 1 }
  ] }));
  assert.equal(one.nodes['passkey-storage-help'].textContent,
    'Your passkey has been securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.');

  const many = await page('settings', fixture({ credentials: [
    { id: 'valid-key', rpId: 'duosecurity.com', userName: 'test-student', createdAt: 2 },
    { id: 'invalid-key', rpId: 'duosecurity.com', userName: 'test-student', createdAt: 1, rejectedAt: 3 }
  ] }));
  assert.equal(many.nodes['passkey-storage-help'].textContent,
    'Your passkeys have been securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.');
});

test('saving a PIN does not overwrite the account draft', async () => {
  const p = await page('settings');
  p.nodes['pin-settings'].open = true;
  await p.nodes['pin-settings'].emit('toggle');
  p.nodes.password.value = 'draft-password';
  p.nodes['new-pin'].value = 'new-pin-value';
  await p.nodes['pin-form'].emit('submit');
  assert.ok((await p.f.vault.read()).pin);
  assert.equal(p.nodes['pin-storage-help-text'].textContent,
    'Your verification PIN has been securely saved on this device using industry-standard encryption and will only be used for sign-in verification.');
  assert.equal(p.nodes.password.value, 'draft-password');
  assert.equal(p.nodes['new-pin'].value, '');
});

test('the power icon persists immediately and remains paused when reopened', async () => {
  const p = await page('popup');
  const header = p.html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)[1];
  assert.deepEqual([...header.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]), ['toggle', 'retry', 'settings']);
  assert.equal(p.nodes.state, undefined);
  assert.equal(p.nodes.toggle.getAttribute('role'), 'switch');
  assert.equal(p.nodes.toggle.getAttribute('aria-label'), 'Sign-in assistant');
  assert.equal(p.nodes.toggle.getAttribute('aria-checked'), 'true');
  assert.equal(p.nodes.toggle.getAttribute('title'), 'On · Click to disable');
  await p.nodes.toggle.emit('click');
  assert.equal((await p.f.controller.settings()).enabled, false);
  assert.equal(p.nodes.toggle.getAttribute('aria-checked'), 'false');
  assert.equal(p.nodes.toggle.getAttribute('title'), 'Off · Click to enable');
  const reopened = await page('popup', p.f);
  assert.equal(reopened.nodes.toggle.getAttribute('aria-checked'), 'false');
  assert.equal(reopened.nodes.toggle.getAttribute('title'), 'Off · Click to enable');
  await reopened.nodes.toggle.emit('click');
  assert.equal((await p.f.controller.settings()).enabled, true);
  assert.equal(reopened.nodes.toggle.getAttribute('aria-checked'), 'true');
  assert.equal(reopened.nodes.toggle.getAttribute('title'), 'On · Click to disable');
});

test('repeated clicks while a toggle is saving create only one update', async () => {
  const p = await page('popup');
  let release;
  p.hooks.before = message => message.type === 'UI_TOGGLE' ? new Promise(resolve => { release = resolve; }) : undefined;
  const pending = p.nodes.toggle.emit('click');
  await Promise.resolve();
  assert.equal(p.nodes.toggle.disabled, true);
  await p.nodes.toggle.emit('click');
  assert.equal(p.calls.filter(c => c.type === 'UI_TOGGLE').length, 1);
  release(); await pending;
  assert.equal(p.nodes.toggle.disabled, false);
  assert.equal(p.nodes.toggle.getAttribute('aria-checked'), 'false');
});

test('a failed toggle shows the error and reconciles the actual saved state', async () => {
  const p = await page('popup');
  p.hooks.before = async message => {
    if (message.type !== 'UI_TOGGLE') return;
    await p.f.controller.dispatch(message, ui('popup.html'));
    throw new Error('Adapter update failed');
  };
  await p.nodes.toggle.emit('click');
  assert.equal(p.nodes.status.error, true);
  assert.equal(p.nodes.toggle.disabled, false);
  assert.equal(p.nodes.toggle.getAttribute('aria-checked'), 'false');
});

test('icon controls open Settings and retry sign-in without reloading the page', async () => {
  const p = await page('popup');
  await p.nodes.settings.emit('click');
  assert.equal(p.state.settingsOpened, 1);
  await p.nodes.retry.emit('click');
  assert.deepEqual(p.f.sent, [{ id: 7, message: { type: 'RECHECK' } }]);
  assert.equal(p.state.closed, true);
});

test('saved icons reflect independent account/password and passkey storage without requiring key selection', async () => {
  const credential = { id: 'saved-key', rpId: 'duosecurity.com', userName: 'student', createdAt: 1 };
  const cases = [
    { username: '', password: '', credentials: [], account: false, passkey: false },
    { username: 'student', password: '', credentials: [], account: false, passkey: false },
    { username: '', password: 'test-only-password', credentials: [], account: false, passkey: false },
    { username: 'student', password: 'test-only-password', credentials: [], account: true, passkey: false },
    { username: '', password: '', credentials: [credential], account: false, passkey: true },
    { username: 'student', password: 'test-only-password', credentials: [credential], account: true, passkey: true }
  ];
  for (const item of cases) {
    const f = fixture(item);
    f.api.storage.local.data.settings.duoOrigin = '';
    f.api.storage.local.data.settings.selectedCredentialId = item.passkey ? '' : 'stale-selection';
    const p = await page('popup', f);
    assert.equal(p.nodes['account-saved'].hidden, !item.account);
    assert.equal(p.nodes['passkey-saved'].hidden, !item.passkey);
    assert.equal(p.nodes['saved-indicators'].hidden, !item.account && !item.passkey);
    for (const id of ['account-saved', 'passkey-saved']) {
      assert.equal(p.nodes[id].getAttribute('role'), 'img');
      assert.equal(p.nodes[id].getAttribute('title'), p.nodes[id].getAttribute('aria-label'));
    }
  }
});

test('local account deletion requires confirmation and clearly describes the complete reset', async () => {
  const f = fixture({
    pin: await newPin('test-only-pin'),
    credentials: [{ id: 'saved-key', rpId: 'duosecurity.com', userName: 'student', createdAt: 1 }]
  });
  await f.api.storage.local.set({ uiLanguage: 'zh-CN', history: [{ at: 1, text: 'Test activity' }] });
  const p = await page('settings', f);
  p.state.confirmResult = false;
  await p.nodes.clear.emit('click');
  assert.equal(p.calls.filter(c => c.type === 'UI_CLEAR').length, 0);
  assert.equal((await f.vault.read()).credentials.length, 1);
  assert.match(p.state.confirmationRequests[0], /^Delete local data\?/);
  assert.match(p.state.confirmationRequests[0], /account, password, passkeys, and PIN/);
  assert.match(p.state.confirmationRequests[0], /Settings, language, and activity will also be reset/);
  p.state.confirmResult = true;
  await p.nodes.clear.emit('click');
  assert.deepEqual(await f.vault.read(), emptyVault());
  assert.equal(f.api.storage.local.data.uiLanguage, null);
  assert.deepEqual(f.api.storage.local.data.history, []);
  assert.equal(p.nodes['clear-status'].textContent, 'Local data deleted.');
  const reopened = await page('popup', f);
  assert.equal(reopened.nodes['account-saved'].hidden, true);
  assert.equal(reopened.nodes['passkey-saved'].hidden, true);
});

test('the passkey list matches the saved account, supports deletion, and keeps drafts', async () => {
  const f = fixture({ credentials: [
    { id: 'key-one', rpId: 'duosecurity.com', userName: 'other-account', createdAt: 1, accountUsername: 'other-account' },
    { id: 'key-two', rpId: 'duosecurity.com', userName: 'test-student', createdAt: 2 }
  ] });
  const p = await page('settings', f);
  assert.equal(p.nodes['selected-credential'], undefined);
  assert.match(p.nodes.credentials.children[0].textContent, /test-studentCurrent account/);
  assert.equal((await f.controller.settings()).selectedCredentialId, 'key-two');
  p.nodes.password.value = 'draft-password';
  const remove = p.nodes.credentials.children[0].querySelector('button');
  assert.equal(remove.getAttribute('aria-label'), 'Delete passkey for test-student');
  p.state.confirmResult = false; await remove.emit('click');
  assert.equal((await f.vault.read()).credentials.length, 2);
  p.state.confirmResult = true; await remove.emit('click');
  assert.deepEqual((await f.vault.read()).credentials.map(c => c.id), ['key-one']);
  assert.equal(p.nodes.password.value, 'draft-password');
  assert.equal((await f.controller.settings()).selectedCredentialId, '');
});

test('without an eligible account key, Settings shows manual verification and offers setup', async () => {
  const f = fixture(); delete f.api.storage.local.data.settings.automaticLogin;
  const p = await page('settings', f);
  assert.equal(p.nodes['duo-mode'].textContent, 'Manual verification');
  assert.equal(p.nodes['duo-mode-state'].className, 'duo-mode manual');
  assert.equal(p.nodes['duo-manual-icon'].hidden, false);
  assert.equal(p.nodes['duo-automatic-icon'].hidden, true);
  assert.equal(p.nodes['passkey-setup'].hidden, false);
  assert.equal(p.nodes['add-passkey'].disabled, false);
  p.nodes.password.value = 'draft-password';
  await p.nodes['add-passkey'].emit('click');
  assert.equal(p.calls.some(c => c.type === 'UI_SETUP_PASSKEY'), true);
  assert.equal((await f.controller.settings()).automaticLogin, false);
  assert.equal(p.nodes.password.value, 'draft-password');
});

test('a usable passkey fixes automatic verification and hides setup until the key is deleted', async () => {
  const f = fixture({ credentials: [{ id: 'saved-key', rpId: 'duosecurity.com', userName: 'test-student', createdAt: 1 }] });
  f.api.storage.local.data.settings.automaticLogin = false;
  const p = await page('settings', f);
  assert.equal(p.nodes['duo-mode'].textContent, 'Automatic verification');
  assert.equal(p.nodes['duo-mode-state'].className, 'duo-mode automatic');
  assert.equal(p.nodes['duo-manual-icon'].hidden, true);
  assert.equal(p.nodes['duo-automatic-icon'].hidden, false);
  assert.equal(p.nodes.credentials.children[0].children[0].children[0].children[0].children[0].className, 'credential-lock');
  assert.equal(p.nodes['passkey-setup'].hidden, true);
  assert.equal(p.nodes['add-passkey'].disabled, true);
  assert.equal(p.nodes['manual-login'], undefined);
  assert.equal((await f.controller.settings()).automaticLogin, true);
  await p.nodes['add-passkey'].emit('click');
  assert.equal(p.calls.some(c => c.type === 'UI_SETUP_PASSKEY'), false);
  const reopened = await page('settings', f);
  assert.equal(reopened.nodes['duo-mode'].textContent, 'Automatic verification');
  p.nodes.password.value = 'draft-password';
  p.nodes['new-pin'].value = 'draft-pin';
  await p.nodes.credentials.children[0].querySelector('button').emit('click');
  assert.equal(p.nodes['duo-mode'].textContent, 'Manual verification');
  assert.equal(p.nodes['passkey-setup'].hidden, false);
  assert.equal(p.nodes['add-passkey'].disabled, false);
  assert.equal((await f.controller.settings()).automaticLogin, false);
  assert.equal(p.nodes.password.value, 'draft-password');
  assert.equal(p.nodes['new-pin'].value, 'draft-pin');
});

test('pending, invalid, and other-account keys leave setup visible without deleting local keys', async () => {
  for (const extra of [{ registrationPending: true }, { rejectedAt: 1 }, { accountUsername: 'another-account' }]) {
    const f = fixture({ credentials: [{ id: 'saved-key', rpId: 'duosecurity.com', userName: 'test-student', createdAt: 1, ...extra }] });
    const p = await page('settings', f);
    assert.equal(p.nodes['duo-mode'].textContent, 'Manual verification');
    assert.equal(p.nodes['passkey-setup'].hidden, false);
    assert.equal((await f.vault.read()).credentials.length, 1);
  }
});


async function confirmation(data = {}) {
  const f = fixture(data);
  await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender());
  return page('confirm', f);
}
async function key(p, value, extra = {}) {
  let prevented = false;
  await p.document.emit('keydown', {
    key: value, target: p.document.body,
    preventDefault() { prevented = true; }, ...extra
  });
  return prevented;
}
const decisions = p => p.calls.filter(call => call.type === 'PROMPT_DECIDE');

test('Enter and Space confirm from the page or Confirm button through the existing controller', async () => {
  for (const value of ['Enter', ' ']) for (const focusButton of [false, true]) {
    const p = await confirmation();
    assert.equal(await key(p, value, { target: focusButton ? p.nodes.approve : p.document.body }), true);
    assert.deepEqual(decisions(p).map(call => call.action), ['approve']);
    assert.equal(p.f.state().flows[7].status, 'active');
    assert.equal(p.state.closed, true);
  }
});

test('confirmation shortcuts ignore composition, modifiers, synthetic events, and native control keys', async () => {
  const p = await confirmation();
  for (const extra of [{ isTrusted: false }, { defaultPrevented: true }, { isComposing: true }, { keyCode: 229 },
    { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    for (const value of ['Enter', ' ', 'Escape']) assert.equal(await key(p, value, extra), false);
  }
  for (const value of ['Enter', ' ', 'Escape']) await key(p, value, { repeat: true });
  const nestedButton = e('span', {});
  p.nodes.cancel.append(nestedButton);
  p.nodes.pin.value = 'draft PIN with spaces';
  for (const target of [p.nodes.pin, p.nodes.choices, p.nodes.cancel, p.nodes.fallback, nestedButton,
    e('textarea', {}), e('summary', {}), e('a', { href: '#' }), e('div', { contenteditable: 'true' }),
    e('div', { role: 'combobox' })]) {
    for (const value of ['Enter', ' ']) assert.equal(await key(p, value, { target }), false);
  }
  assert.equal(decisions(p).length, 0);
  assert.equal(p.nodes.pin.value, 'draft PIN with spaces');
  await p.nodes.cancel.emit('click');
  assert.equal(p.f.state().flows[7].status, 'cancelled');
});

test('Escape cancels even from a PIN field and closes expired or unavailable prompts without approval', async () => {
  const active = await confirmation();
  await key(active, 'Escape', { target: active.nodes.pin });
  assert.deepEqual(decisions(active).map(call => call.action), ['cancel']);
  assert.equal(active.f.state().flows[7].status, 'cancelled');
  assert.equal(active.state.closed, true);
  const expired = await confirmation();
  expired.f.advance(expired.f.prompt().deadline - expired.f.clock());
  const missing = await page('confirm');
  for (const p of [expired, missing]) {
    await key(p, 'Enter');
    await key(p, ' ');
    await key(p, 'Escape');
    assert.equal(decisions(p).length, 0);
    assert.equal(p.state.closed, true);
  }
});

test('keyboard approval respects disabled verification and required PIN form validation', async () => {
  for (const hasPin of [false, true]) {
    const f = fixture(hasPin ? { pin: await newPin('test-only-pin') } : {});
    await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create',
      options: creation({ authenticatorSelection: { userVerification: 'required' } }) }, await f.toDuo());
    const p = await page('confirm', f);
    await key(p, ' ');
    await p.nodes['confirm-form'].emit('submit');
    assert.equal(decisions(p).length, 0);
    assert.equal(p.nodes.approve.disabled, !hasPin);
    assert.equal(p.state.validityChecks, hasPin ? 2 : 0);
    if (hasPin) {
      p.nodes.pin.value = 'test-only-pin';
      await key(p, 'Enter');
      assert.equal((await f.vault.read()).credentials.length, 1);
      assert.equal(p.nodes.pin.value, '');
      assert.equal(p.state.closed, true);
    }
  }
});

test('a pending keyboard decision is not duplicated or reversed by additional keys', async () => {
  const p = await confirmation();
  let release;
  p.hooks.before = message => message.type === 'PROMPT_DECIDE' ? new Promise(resolve => { release = resolve; }) : undefined;
  const pending = key(p, 'Enter');
  await Promise.resolve();
  await key(p, ' ');
  await key(p, 'Escape');
  assert.deepEqual(decisions(p).map(call => call.action), ['approve']);
  assert.equal(p.nodes.approve.disabled, true);
  release(); await pending;
  assert.equal(p.state.closed, true);
});

test('a failed keyboard decision allows a fresh keypress without accepting held-key repeats', async () => {
  const p = await confirmation();
  p.hooks.before = () => { throw new Error('Temporary failure'); };
  await key(p, 'Enter');
  assert.equal(p.nodes.status.error, true);
  assert.equal(p.nodes.approve.disabled, false);
  await key(p, 'Enter', { repeat: true });
  assert.equal(decisions(p).length, 1);
  p.hooks.before = undefined;
  await key(p, ' ');
  assert.equal(p.f.state().flows[7].status, 'active');
  assert.equal(p.state.closed, true);
});

test('passkey setup does not require a Duo address or another permission prompt', async () => {
  const p = await page('settings'); await p.nodes['add-passkey'].emit('click');
  assert.equal(p.permissionRequests.length, 0);
  assert.equal(Object.hasOwn(p.calls.find(call => call.type === 'UI_SETUP_PASSKEY'), 'duoOrigin'), false);
  assert.equal(p.nodes['duo-origin'], undefined);
});

test('activity refresh preserves account and PIN drafts while expired entries disappear', async () => {
  const p = await page('settings'); p.nodes.password.value = 'draft-password'; p.nodes['new-pin'].value = 'draft-pin';
  await p.f.controller.note('Current activity'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.nodes.password.value, 'draft-password'); assert.equal(p.nodes['new-pin'].value, 'draft-pin');
  p.f.advance(24 * 60 * 60_000); await p.f.controller.cleanup(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.nodes.history.textContent, 'No activity yet.');
});

test('passkey creation uses Continue and places the alternate provider below Details', async () => {
  const f = fixture(); const from = await f.toDuo();
  await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation() }, from);
  const p = await page('confirm', f);
  assert.equal(p.nodes.title.textContent, 'Add a passkey');
  assert.equal(p.nodes.approve.textContent, 'Continue');
  assert.match(p.nodes.notice.textContent, /Adding a passkey is necessary/);
  assert.equal(p.nodes['consent-help'].textContent, 'Confirming allows this page to complete this passkey request.');
  assert.ok(p.html.indexOf('id="fallback"') > p.html.indexOf('</details>'));
  assert.match(p.nodes['keyboard-help'].textContent, /continue/);
});


test('invalid keys stay listed with an explicit label and require confirmed user deletion', async () => {
  const credential = { id: 'invalid-key', rpId: 'duosecurity.com', userName: 'test-student', createdAt: 1, rejectedAt: 2 };
  const p = await page('settings', fixture({ credentials: [credential] }));
  assert.match(p.nodes.credentials.textContent, /Invalid/);
  assert.equal(p.nodes['duo-mode'].textContent, 'Manual verification');
  assert.equal(p.nodes['passkey-setup'].hidden, false);
  assert.equal((await p.f.vault.read()).credentials.length, 1);
  const remove = p.nodes.credentials.children[0].querySelector('button');
  p.state.confirmResult = false; await remove.emit('click');
  assert.equal((await p.f.vault.read()).credentials.length, 1);
  p.state.confirmResult = true; await remove.emit('click');
  assert.equal((await p.f.vault.read()).credentials.length, 0);
});

test('an unavailable-key prompt cannot approve with Enter and can explicitly start replacement', async () => {
  const f = fixture(); await f.start({ setup: true }); const from = await f.toDuo();
  await f.controller.dispatch({ type: 'DUO_STEP', step: 'key-selected' }, from);
  await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'get', options: { challenge: creation().challenge, rpId: 'duosecurity.com' } }, from);
  const p = await page('confirm', f);
  assert.equal(p.nodes.approve.hidden, true); assert.equal(p.nodes.enroll.hidden, false);
  await key(p, 'Enter'); assert.equal(decisions(p).length, 0);
  await p.nodes.enroll.emit('click');
  assert.equal(f.state().flows[7].duo.mode, 'enroll'); assert.equal(p.state.closed, true);
});


test('manual sign-in confirmation describes manual Duo and does not ask for a passkey PIN', async () => {
  const f = fixture({ pin: await newPin('test-only-pin') });
  await f.controller.dispatch({ type: 'UI_SAVE_SETTINGS', automaticLogin: false }, ui());
  await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender());
  const p = await page('confirm', f);
  assert.equal(p.nodes['pin-field'].hidden, true);
  assert.equal(p.nodes['sign-in-explanation'].hidden, false);
  assert.equal(p.nodes['sign-in-explanation'].textContent, 'Confirm to log in to uchicago.edu.');
  assert.match(p.nodes['consent-help'].textContent, /Complete Duo verification yourself/);
  await key(p, 'Enter'); assert.equal(f.state().flows[7].grant, null);
});


test('the passkey setup action and its explanation follow the saved-key list', async () => {
  const p = await page('settings');
  assert.ok(p.html.indexOf('id="credentials"') < p.html.indexOf('id="add-passkey"'));
  assert.ok(p.html.indexOf('id="add-passkey"') < p.html.indexOf('Opens a new school sign-in tab. Automatic verification'));
});


test('the shortcut page reuses confirmation and keyboard controls without opening a popup', async () => {
  for (const value of ['Enter', ' ', 'Escape']) {
    const p = await page('start');
    assert.equal(p.nodes.title.textContent, CONFIRM_TEXT);
    assert.equal(p.nodes['sign-in-explanation'].hidden, false);
    assert.equal(p.nodes['sign-in-explanation'].textContent, 'Confirm to log in to uchicago.edu.');
    assert.equal(p.f.windows.size, 0);
    await key(p, value);
    const choice = p.calls.find(call => call.type === 'SHORTCUT_DECIDE');
    assert.equal(choice.action, value === 'Escape' ? 'cancel' : 'approve');
    assert.equal(p.state.closed, false);
    assert.equal(p.state.destinations.length, 1);
    assert.equal(new URL(p.state.destinations[0]).hostname, value === 'Escape' ? 'portal.uchicago.edu' : 'ais92hbprd.ais.uchicago.edu');
  }
});

test('shortcut PIN errors keep the page usable and Cancel works even if the worker fails', async () => {
  const p = await page('start', fixture({ pin: await newPin('test-only-pin') }));
  p.nodes.pin.value = 'incorrect-pin';
  await key(p, 'Enter');
  assert.equal(p.state.destinations.length, 0);
  assert.equal(p.nodes.status.error, true);
  assert.equal(p.nodes.approve.disabled, false);
  p.hooks.before = () => { throw new Error('Worker unavailable'); };
  await p.nodes.cancel.emit('click');
  assert.deepEqual(p.state.destinations, [PORTAL_URL]);
});


test('confirmation load failures are not mislabeled as expired requests', async () => {
  const f = fixture();
  f.api.runtime.getContexts = async () => [];
  const unavailable = await page('start', f);
  assert.equal(unavailable.nodes.title.textContent, 'Unable to load confirmation');
  assert.match(unavailable.nodes.status.textContent, /no longer active/);
  assert.equal(unavailable.nodes.approve.disabled, true);
  await unavailable.nodes.cancel.emit('click');
  assert.deepEqual(unavailable.state.destinations, [PORTAL_URL]);
  const expired = await page('confirm');
  assert.equal(expired.nodes.title.textContent, 'Request expired');
});
