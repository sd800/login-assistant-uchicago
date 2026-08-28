import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createCredential, getAssertion } from '../extension/core/passkeys.js';
import { b64 } from '../extension/core/encoding.js';
import { DUO, creation, assertion } from './helpers.mjs';

const source = await readFile(new URL('../extension/content/passkey-bridge.js', import.meta.url), 'utf8');
function bridge() {
  const messages = []; const calls = []; const handlers = []; const timers = new Map();
  const window = { addEventListener(type, fn) { if (type === 'message') handlers.push(fn); }, postMessage(data, origin) { messages.push({ ...data, targetOrigin: origin }); } };
  window.top = window;
  const navigator = { credentials: Object.fromEntries(['get', 'create'].map(kind => [kind, async options => { calls.push({ kind, options }); return { native: true }; }])) };
  class PublicKeyCredential {}
  class AuthenticatorAttestationResponse {}
  class AuthenticatorAssertionResponse {}
  vm.runInNewContext(source, {
    window, navigator, location: { hostname: new URL(DUO).hostname, origin: DUO },
    crypto, ArrayBuffer, Uint8Array, btoa, atob, DOMException, structuredClone,
    PublicKeyCredential, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse,
    setTimeout(fn) { const id = crypto.randomUUID(); timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  return {
    navigator, messages, calls, timers, PublicKeyCredential, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse,
    reply(result, overrides = {}) {
      const request = messages.findLast(m => m.direction === 'request');
      const event = { source: window, origin: DUO, data: { channel: 'uchicago-passkeys-v1', direction: 'response', id: request.id, result }, ...overrides };
      for (const handler of handlers) handler(event);
    }
  };
}

test('bridge preserves native credentials and conditional/silent mediation without prompts', async () => {
  const b = bridge();
  for (const options of [{ password: true }, { publicKey: {}, mediation: 'conditional' }, { publicKey: {}, mediation: 'silent' }]) {
    assert.equal((await b.navigator.credentials.get(options)).native, true);
    assert.equal(b.calls.at(-1).options, options);
  }
  assert.equal(b.messages.length, 0);
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
function duoAdapter(statuses) {
  const listeners = new Map(), messages = [], calls = [], timers = [];
  let now = 100_000;
  const window = { top: null, addEventListener(type, handler) { listeners.set(type, handler); },
    postMessage(value) { messages.push(value); } };
  window.top = window;
  vm.runInNewContext(duoSource, {
    window, location: { hostname: new URL(DUO).hostname, origin: DUO }, document: {},
    UChiLoginDOM: {}, Date: { now: () => now }, setInterval() {},
    setTimeout(handler, delay) { timers.push(() => { now += delay; handler(); }); return timers.length; }, clearTimeout() {},
    chrome: { runtime: { async sendMessage(message) {
      calls.push(message);
      return { ok: true, result: message.type === 'STATUS' ? statuses.shift() || { trusted: false } : { fallback: true } };
    } } }
  });
  const id = crypto.randomUUID();
  return {
    calls, messages, timers,
    request: () => listeners.get('message')({ source: window, origin: DUO,
      data: { channel: 'uchicago-passkeys-v1', direction: 'request', id, kind: 'get', options: { challenge: 'synthetic', timeout: 5_000 } } }),
    cancel: () => listeners.get('message')({ source: window, origin: DUO,
      data: { channel: 'uchicago-passkeys-v1', direction: 'cancel', id } })
  };
}
const flushBridge = () => new Promise(resolve => setImmediate(resolve));

test('Duo bootstrap returns unrelated requests to Chrome without forwarding passkey options', async () => {
  const a = duoAdapter([{ trusted: false, pending: false }]);
  await a.request();
  assert.deepEqual(a.calls.map(item => item.type), ['STATUS']);
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

test('Duo bootstrap falls back when the school flow is no longer active', async () => {
  const a = duoAdapter([{ trusted: false, pending: true }, { trusted: false, pending: false }]);
  const pending = a.request(); await flushBridge(); a.timers.shift()(); await pending;
  assert.equal(a.calls.some(item => item.type === 'PK_BEGIN'), false);
  assert.equal(a.messages[0].result.fallback, true);
});
