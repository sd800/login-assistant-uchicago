import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createCredential, getAssertion } from '../extension/core/passkeys.js';
import { b64 } from '../extension/core/encoding.js';
import { DUO, creation, assertion, fixture, ui } from './helpers.mjs';

import { element as e, documentWith } from './dom-fixture.mjs';

const source = await readFile(new URL('../extension/content/passkey-bridge.js', import.meta.url), 'utf8');
function bridge() {
  const messages = []; const calls = []; const handlers = []; const timers = new Map();
  const window = { addEventListener(type, fn) { if (type === 'message') handlers.push(fn); }, postMessage(data, origin) { messages.push({ ...data, targetOrigin: origin }); } };
  window.top = window;
  class CredentialsContainer {
    async get(options) { calls.push({ kind: 'get', options }); return { native: true }; }
    async create(options) { calls.push({ kind: 'create', options }); return { native: true }; }
  }
  const navigator = { credentials: new CredentialsContainer() };
  class PublicKeyCredential {}
  class AuthenticatorAttestationResponse {}
  class AuthenticatorAssertionResponse {}
  vm.runInNewContext(source, {
    window, navigator, location: { hostname: new URL(DUO).hostname, origin: DUO },
    crypto, ArrayBuffer, Uint8Array, btoa, atob, DOMException, structuredClone,
    CredentialsContainer, PublicKeyCredential, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse,
    setTimeout(fn) { const id = crypto.randomUUID(); timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  return {
    CredentialsContainer, navigator, messages, calls, timers, PublicKeyCredential, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse,
    reply(result, overrides = {}) {
      const request = messages.findLast(m => m.direction === 'request');
      const event = { source: window, origin: DUO, data: { channel: 'uchicago-passkeys-v1', direction: 'response', id: request.id, result }, ...overrides };
      for (const handler of handlers) handler(event);
    }
  };
}

test('browser-managed requests wait for the adapter before any native call', async () => {
  const b = bridge();
  assert.equal((await b.navigator.credentials.get({ password: true })).native, true);
  for (const mediation of ['conditional', 'silent']) {
    const options = { publicKey: {}, mediation };
    const count = b.calls.length;
    const pending = b.navigator.credentials.get(options);
    assert.equal(b.calls.length, count);
    assert.equal(b.messages.at(-1).browserManaged, true);
    b.reply({ fallback: true });
    assert.equal((await pending).native, true);
    assert.equal(b.calls.at(-1).options, options);
  }
});

test('bridge encodes only a typed-array view and falls back with original options', async () => {
  const b = bridge(); const bytes = new Uint8Array([99, 1, 2, 3, 88]);
  const options = { publicKey: { challenge: bytes.subarray(1, 4), allowCredentials: [{ type: 'public-key', id: bytes.buffer }] } };
  const pending = b.navigator.credentials.get(options);
  const request = b.messages[0];
  assert.equal(request.options.challenge, b64(Uint8Array.of(1, 2, 3)));
  assert.equal(request.options.allowCredentials[0].id, b64(bytes));
  assert.equal(request.targetOrigin, DUO);
  b.reply({ fallback: true });
  assert.equal((await pending).native, true);
  assert.equal(b.calls[0].options, options);
  assert.equal(b.timers.size, 0);
});

test('bridge reconstructs registration and assertion responses', async () => {
  const b = bridge();
  const made = await createCredential({ options: creation(), origin: DUO, configuredOrigin: DUO, proof: { up: true, uv: false } });
  const registration = b.navigator.credentials.create({ publicKey: { challenge: new Uint8Array(32) } });
  b.reply({ response: made.response });
  const created = await registration;
  assert.ok(created instanceof b.PublicKeyCredential);
  assert.ok(created.response instanceof b.AuthenticatorAttestationResponse);
  assert.equal(created.response.getPublicKeyAlgorithm(), -7);
  assert.ok(created.response.getPublicKey() instanceof ArrayBuffer);
  assert.equal(b64(new Uint8Array(created.rawId)), made.credential.id);
  const extensions = created.getClientExtensionResults();
  extensions.credProps.rk = false;
  assert.equal(created.getClientExtensionResults().credProps.rk, true);
  const signed = await getAssertion({ options: assertion(made.credential), origin: DUO, configuredOrigin: DUO, credential: made.credential, proof: { up: true, uv: false } });
  const authentication = b.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } });
  b.reply({ response: signed.response });
  const received = await authentication;
  assert.ok(received.response instanceof b.AuthenticatorAssertionResponse);
  assert.equal(b64(new Uint8Array(received.response.signature)), signed.response.response.signature);
  assert.deepEqual(received.toJSON(), signed.response);
  assert.equal(b.calls.length, 0);
});

test('bridge ignores messages from another source or origin', async () => {
  const b = bridge(); const pending = b.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } });
  let resolved = false; pending.then(() => { resolved = true; });
  b.reply({ fallback: true }, { source: {} });
  b.reply({ fallback: true }, { origin: 'https://example.com' });
  await Promise.resolve();
  assert.equal(resolved, false);
  b.reply({ fallback: true }); await pending;
  assert.equal(b.calls.length, 1);
});

test('aborting a pending bridge request cancels it without invoking native authentication', async () => {
  const b = bridge(); const controller = new AbortController();
  const pending = b.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) }, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(b.messages.at(-1).direction, 'cancel');
  assert.equal(b.calls.length, 0); assert.equal(b.timers.size, 0);
});

test('timeout fails explicitly and never triggers an unexpected second authentication', async () => {
  const b = bridge(); const pending = b.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } });
  for (const timer of b.timers.values()) timer();
  await assert.rejects(pending, { name: 'NotAllowedError' });
  assert.equal(b.messages.at(-1).direction, 'cancel');
  assert.equal(b.calls.length, 0);
});

test('an already-aborted request does not enter the provider', async () => {
  const b = bridge(); const controller = new AbortController(); controller.abort();
  await assert.rejects(b.navigator.credentials.get({ publicKey: {}, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(b.messages.length, 0);
});

const duoSource = await readFile(new URL('../extension/content/duo.js', import.meta.url), 'utf8');
function duoAdapter(statuses, failures = new Set()) {
  const listeners = new Map(), messages = [], calls = [], timers = [];
  let now = 100_000;
  const window = { top: null, addEventListener(type, handler) { listeners.set(type, handler); },
    postMessage(value) { messages.push(value); } };
  window.top = window;
  vm.runInNewContext(duoSource, {
    window, location: { hostname: new URL(DUO).hostname, origin: DUO }, document: {},
    UChiLoginDOM: { duoIdentity: () => false, duoKeyRejected: () => false }, Date: { now: () => now }, setInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout(handler, delay) { timers.push(() => { now += delay; handler(); }); return timers.length; }, clearTimeout() {},
    chrome: { runtime: { async sendMessage(message) {
      calls.push(message);
      if (failures.has(message.type)) throw new Error('private-runtime-error');
      return { ok: true, result: message.type === 'STATUS' ? statuses.shift() || { trusted: false } : { fallback: true } };
    } } }
  });
  const id = crypto.randomUUID();
  return {
    calls, messages, timers,
    request: (kind = 'get') => listeners.get('message')({ source: window, origin: DUO,
      data: { channel: 'uchicago-passkeys-v1', direction: 'request', id, kind, options: { challenge: 'synthetic', timeout: 5_000 } } }),
    cancel: () => listeners.get('message')({ source: window, origin: DUO,
      data: { channel: 'uchicago-passkeys-v1', direction: 'cancel', id } })
  };
}
const flushBridge = () => new Promise(resolve => setImmediate(resolve));

test('Duo bootstrap returns unrelated requests to Chrome without forwarding passkey options', async () => {
  const a = duoAdapter([{ trusted: false, pending: false }]);
  await a.request();
  assert.deepEqual(a.calls.map(item => item.type), ['STATUS', 'PK_FALLBACK']);
  assert.equal(a.messages[0].result.fallback, true);
});

test('Duo bootstrap waits for browser navigation before forwarding a request', async () => {
  for (const pendingStatus of [{ trusted: false, pending: true }]) {
    const a = duoAdapter([pendingStatus, { trusted: true }]);
    const pending = a.request(); await flushBridge();
    assert.equal(a.calls.some(item => item.type === 'PK_BEGIN'), false);
    a.timers.shift()(); await pending;
    assert.deepEqual(a.calls.map(item => item.type), ['STATUS', 'STATUS', 'PK_BEGIN']);
  }
});

test('Duo bootstrap cancellation during discovery prevents forwarding or a late response', async () => {
  const a = duoAdapter([{ trusted: false, pending: true }, { trusted: true }]);
  const pending = a.request(); await flushBridge(); await a.cancel(); a.timers.shift()(); await pending;
  assert.equal(a.calls.some(item => item.type === 'PK_BEGIN'), false);
  assert.equal(a.messages.length, 0);
});

test('Duo bootstrap does not invoke native UI after a known approved flow disappears', async () => {
  const a = duoAdapter([{ trusted: false, pending: true }, { trusted: false, pending: false }]);
  const pending = a.request(); await flushBridge(); a.timers.shift()(); await pending;
  assert.equal(a.calls.some(item => item.type === 'PK_BEGIN'), false);
  assert.equal(a.messages[0].result.error.name, 'NotAllowedError');
});


test('registration bootstrap reports the fallback stage without forwarding request options', async () => {
  for (const [statuses, failures, reason] of [
    [[{ trusted: false, pending: false }], new Set(), 'flow'],
    [[{ trusted: true }], new Set(['PK_BEGIN']), 'error'],
    [[{ trusted: false, pending: false }], new Set(['PK_FALLBACK']), 'flow']
  ]) {
    const a = duoAdapter(statuses, failures);
    await a.request('create');
    const report = a.calls.find(item => item.type === 'PK_FALLBACK');
    if (reason === 'error') assert.equal(report, undefined);
    else assert.deepEqual(JSON.parse(JSON.stringify(report)), { type: 'PK_FALLBACK', kind: 'create', reason });
    if (reason === 'error') assert.equal(a.messages[0].result.error.name, 'NotAllowedError');
    else assert.equal(a.messages[0].result.fallback, true);
    assert.equal(JSON.stringify(report || {}).includes('synthetic'), false);
    assert.equal(JSON.stringify(a.messages).includes('private-runtime-error'), false);
  }
});

test('browser-managed registration preserves the original options after an explicit fallback', async () => {
  const b = bridge();
  const options = { publicKey: { challenge: new Uint8Array(32) }, mediation: 'conditional' };
  const pending = b.navigator.credentials.create(options);
  assert.equal(b.calls.length, 0);
  assert.equal(b.messages[0].browserManaged, true);
  b.reply({ fallback: true });
  assert.equal((await pending).native, true);
  assert.equal(b.calls[0].options, options);
});

test('prototype-based Security key requests are intercepted before a native call', async () => {
  const b = bridge();
  const pending = b.CredentialsContainer.prototype.get.call(b.navigator.credentials, { publicKey: { challenge: new Uint8Array(32) } });
  assert.equal(b.calls.length, 0);
  assert.equal(b.messages[0].direction, 'request');
  b.reply({ error: { name: 'AbortError', message: 'Switching methods' } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(b.calls.length, 0);
});


// Run the real page bridge, isolated adapter, and controller together. Native
// WebAuthn calls are counted; no polling interval is advanced in these tests.
const domSource = await readFile(new URL('../extension/content/dom.js', import.meta.url), 'utf8');
async function connected(t, { manual = false, identity = false } = {}) {
  const { credential } = await createCredential({ options: creation(), origin: DUO, configuredOrigin: DUO, proof: { up: true, uv: false } });
  const f = fixture({ credentials: manual ? [] : [credential] });
  f.api.storage.local.data.settings.automaticLogin = false;
  await f.start(); const from = await f.toDuo();
  if (identity) await f.controller.dispatch({ type: 'DUO_STEP', step: 'identity' }, from);
  const document = documentWith(e('h1', {}, identity ? 'Verify your identity before managing devices' : 'Check Duo Mobile'));
  const events = new Map(), observers = [], timers = new Set(), calls = [], native = [], errors = [];
  const window = {
    addEventListener(type, listener) { const list = events.get(type) || []; list.push(listener); events.set(type, list); },
    postMessage(data) { queueMicrotask(() => { for (const listener of events.get('message') || []) {
      Promise.resolve(listener({ source: window, origin: DUO, data })).catch(error => errors.push(error));
    } }); }
  };
  window.top = window;
  class CredentialsContainer {
    async get(options) { native.push(options); return { native: true }; }
    async create(options) { native.push(options); return { native: true }; }
  }
  const navigator = { credentials: new CredentialsContainer() };
  const shared = { window, document, navigator, location: new URL(DUO + '/frame/v4/auth'),
    crypto, TextEncoder, ArrayBuffer, Uint8Array, btoa, atob, DOMException, structuredClone,
    setTimeout(fn, delay) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); }, setInterval() {},
    getComputedStyle: node => ({ visibility: 'visible', display: 'block', ...node.style }),
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} disconnect() {} }
  };
  const isolated = vm.createContext({ ...shared, Date: { now: f.clock }, chrome: { runtime: {
    async sendMessage(message) {
      calls.push(message);
      try { return { ok: true, result: await f.controller.dispatch(message, from) }; }
      catch (error) { return { ok: false, error: error.message }; }
    }
  } } });
  vm.runInContext(domSource, isolated); vm.runInContext(duoSource, isolated);
  vm.runInNewContext(source, { ...shared, CredentialsContainer,
    PublicKeyCredential: class {}, AuthenticatorAssertionResponse: class {}, AuthenticatorAttestationResponse: class {} });
  t.after(() => { for (const listener of events.get('pagehide') || []) listener(); for (const timer of timers) clearTimeout(timer); });
  const until = async predicate => {
    const deadline = Date.now() + 1500;
    while (!predicate() && Date.now() < deadline) await flushBridge();
    assert.deepEqual(errors, []); assert.ok(predicate(), 'the asynchronous sign-in step completed');
  };
  return { f, from, credential, document, navigator, native, calls, until,
    click(node) {
      for (const listener of events.get('click') || []) listener({ isTrusted: true, target: node });
      node.click();
    },
    mutate() { observers.forEach(callback => callback()); },
    async get(overrides = {}) { return navigator.credentials.get({ publicKey: assertion(credential, overrides) }); }
  };
}

test('an unmatched default request is canceled and synchronous Security key selection signs without native UI', async t => {
  const a = await connected(t);
  let defaultError, received;
  const defaultRequest = a.get({ allowCredentials: [{ type: 'public-key', id: creation().challenge }] }).catch(error => { defaultError = error; });
  await a.until(() => a.calls.some(call => call.type === 'PK_BEGIN'));
  await a.f.controller.tail; await flushBridge();
  const options = e('button', {}, 'Other options'), key = e('button', {}, 'Security key');
  options.onClick = () => { a.document.body.replaceChildren(e('h1', {}, 'Other options to log in'), key); a.mutate(); };
  key.onClick = () => {
    a.document.body.replaceChildren(e('h1', {}, 'Use your security key'));
    a.get().then(value => { received = value; }); a.mutate();
  };
  a.document.body.append(options); a.mutate();
  await a.until(() => received?.response?.signature);
  await defaultRequest;
  await a.until(() => Object.values(a.f.state().jobs).some(job => job.stage === 'delivered'));
  assert.equal(defaultError.name, 'AbortError');
  assert.equal(options.clicks, 1); assert.equal(key.clicks, 1);
  assert.equal(a.native.length, 0); assert.equal(received.id, a.credential.id);
  assert.equal((await a.f.vault.read()).credentials[0].signCount, 1);
});

test('manually choosing the English Security Key card still signs after a default Touch ID request', async t => {
  const a = await connected(t);
  let received, defaultError;
  const defaultRequest = a.get({ userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: creation().challenge }] }).catch(error => { defaultError = error; });
  await a.until(() => a.calls.some(call => call.type === 'PK_BEGIN'));
  await a.f.controller.tail; await flushBridge();
  const key = e('button', { type: 'button', class: 'auth-method auth-method-link' },
    e('div', { class: 'method-label' }, 'Security Key'), e('div', { class: 'method-description' }, 'Use a hardware security key'));
  a.document.body.replaceChildren(e('h1', { 'data-testid': 'card-text' }, 'Select an option to log in'),
    e('ul', { class: 'all-auth-methods-list' }, e('li', {}, key)));
  key.onClick = () => {
    a.document.body.replaceChildren(e('h1', {}, 'Use your security key'));
    a.get().then(value => { received = value; });
  };
  a.click(key);
  await a.until(() => received?.response?.signature); await defaultRequest;
  assert.equal(defaultError.name, 'AbortError');
  assert.equal(received.id, a.credential.id); assert.equal(key.clicks, 1);
  assert.equal(a.native.length, 0); assert.equal(a.f.prompt(), undefined);
  assert.equal((await a.f.vault.read()).credentials[0].signCount, 1);
});

test('a matching key is handled immediately, including the device-management identity check', async t => {
  for (const identity of [false, true]) {
    const a = await connected(t, { identity });
    const result = await a.get();
    assert.equal(result.id, a.credential.id); assert.equal(a.native.length, 0);
    assert.equal(a.f.prompt(), undefined);
  }
});

test('without a saved key, Duo stays manual and lets the user use Chrome', async t => {
  const a = await connected(t, { manual: true });
  assert.equal((await a.get()).native, true);
  assert.equal(a.native.length, 1);
  assert.equal((await a.f.vault.read()).credentials.length, 0);
  assert.equal(a.f.prompt(), undefined);
});

test('an unmatched selected key waits for an explicit provider choice without native fallback', async t => {
  const a = await connected(t);
  await a.f.controller.dispatch({ type: 'DUO_STEP', step: 'key-selected' }, a.from);
  const request = a.get({ allowCredentials: [{ type: 'public-key', id: creation().challenge }] });
  await a.until(() => a.f.prompt()?.fallbackOnly);
  assert.equal(a.native.length, 0);
  const prompt = a.f.prompt();
  await a.f.controller.dispatch({ type: 'PROMPT_DECIDE', id: prompt.id, action: 'fallback' }, ui('confirm.html?id=' + prompt.id));
  assert.equal((await request).native, true); assert.equal(a.native.length, 1);
  assert.equal((await a.f.vault.read()).credentials[0].rejectedAt, undefined);
});


test('a ready menu selects its nested Security key card after a slow login without another confirmation', async t => {
  const a = await connected(t); a.f.advance(90_000);
  let received;
  const key = e('div', { role: 'button' }, e('div', {}, 'Security key'), e('p', {}, 'Use your security key'));
  const manage = e('a', {}, 'Manage devices');
  key.onClick = () => {
    a.document.body.replaceChildren(e('h1', {}, 'Use your security key'));
    a.get().then(value => { received = value; }); a.mutate();
  };
  a.document.body.replaceChildren(e('div', {}, 'Choose an option'), key, manage); a.mutate();
  await a.until(() => received?.response?.signature);
  assert.equal(key.clicks, 1); assert.equal(a.native.length, 0);
  assert.equal(a.f.prompt(), undefined); assert.equal(received.id, a.credential.id);
});
