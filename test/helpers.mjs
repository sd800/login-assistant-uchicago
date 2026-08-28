import { randomId } from '../extension/core/encoding.js';
import { emptyVault } from '../extension/core/vault.js';
import { Controller } from '../extension/core/controller.js';

export const DUO = 'https://api-test123.duosecurity.com';
export const OKTA = 'https://uchicago.okta.com';
export const EXTENSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const ui = (page = 'settings.html') => ({ id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/${page}` });
export const sender = (origin = OKTA, tabId = 7, documentId = 'okta-document') => ({ id: EXTENSION_ID, url: `${origin}/login`, origin, tab: { id: tabId }, frameId: 0, documentId });
export function creation(overrides = {}) {
  return { rp: { id: 'duosecurity.com', name: 'Duo' }, user: { id: randomId(16), name: 'test-student', displayName: 'Test Student' }, challenge: randomId(), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { userVerification: 'discouraged', residentKey: 'preferred' }, extensions: { credProps: true }, ...overrides };
}
export const assertion = (credential, overrides = {}) => ({ rpId: credential.rpId, challenge: randomId(), allowCredentials: [{ type: 'public-key', id: credential.id }], userVerification: 'discouraged', ...overrides });
export function memoryRepository() {
  const map = new Map();
  return { map, async get(key) { return map.get(key); }, async set(key, value) { map.set(key, value); } };
}
function storage(initial = {}, notify = () => {}) {
  const data = structuredClone(initial);
  return { data, async get(key) { return { [key]: structuredClone(data[key]) }; }, async set(value) {
    const changes = {};
    for (const [key, next] of Object.entries(value)) if (JSON.stringify(data[key]) !== JSON.stringify(next)) {
      changes[key] = { oldValue: structuredClone(data[key]), newValue: structuredClone(next) };
    }
    Object.assign(data, structuredClone(value));
    if (Object.keys(changes).length) notify(changes);
  } };
}
export function fixture(data = {}) {
  let now = 100_000;
  let vaultData = { ...emptyVault(), username: 'test-student', password: 'test-only-password', ...data };
  const frames = new Map([[7, { documentId: 'okta-document', url: `${OKTA}/login` }]]);
  const windows = new Map();
  let nextWindow = 20;
  const scripts = new Map();
  const permissions = new Set([`${DUO}/*`, `${OKTA}/*`, 'https://portal.uchicago.edu/*', 'https://courses.uchicago.edu/*']);
  const sent = [];
  const changeListeners = new Set();
  const notify = changes => { for (const listener of changeListeners) listener(changes, 'local'); };
  const api = {
    runtime: { id: EXTENSION_ID, getURL: path => `chrome-extension://${EXTENSION_ID}/${path}` },
    storage: { session: storage(), local: storage({ settings: { enabled: true, duoOrigin: DUO, selectedCredentialId: data.credentials?.[0]?.id || '' } }, notify),
      onChanged: { addListener: listener => changeListeners.add(listener), removeListener: listener => changeListeners.delete(listener) } },
    permissions: {
      async getAll() { return { origins: [...permissions] }; },
      async contains({ origins }) {
        return origins.every(origin => permissions.has(origin) ||
          (permissions.has('https://*.duosecurity.com/*') && /^https:\/\/(?:[a-z0-9-]+\.)?duosecurity\.com\//.test(origin)));
      },
      async remove({ origins }) { origins.forEach(origin => permissions.delete(origin)); return true; }
    },
    webNavigation: { async getFrame({ tabId }) { return frames.get(tabId); } },
    tabs: { async get(id) { return { id, ...frames.get(id) }; }, async sendMessage(id, message) { sent.push({ id, message }); } },
    windows: { async create(options) { const id = nextWindow++; windows.set(id, options); return { id }; }, async remove(id) { windows.delete(id); } },
    scripting: {
      async getRegisteredContentScripts() { return [...scripts.values()]; },
      async unregisterContentScripts({ ids }) { ids.forEach(id => scripts.delete(id)); },
      async registerContentScripts(values) { values.forEach(value => scripts.set(value.id, value)); }
    }
  };
  const vault = { async read() { return structuredClone(vaultData); }, async write(value) { vaultData = structuredClone(value); } };
  const controller = new Controller(api, vault, () => now);
  return {
    controller, api, vault, frames, windows, scripts, permissions, sent,
    clock: () => now, advance: ms => { now += ms; },
    state: () => api.storage.session.data.state,
    prompt: () => Object.values(api.storage.session.data.state.prompts)[0],
    async approve(prompt, extra = {}) { return controller.dispatch({ type: 'PROMPT_DECIDE', id: prompt.id, action: 'approve', ...extra }, ui(`confirm.html?id=${prompt.id}`)); },
    async start(extra = {}) { await controller.dispatch({ type: 'LOGIN_DETECTED' }, sender()); await this.approve(this.prompt(), extra); },
    async toDuo(tabId = 7) {
      if (tabId === 7 && !this.state()?.flows?.[7]) { await this.start(); this.advance(30_000); }
      const documentId = `duo-${tabId}`; frames.set(tabId, { url: `${DUO}/frame/v4/auth`, documentId }); await controller.navigation({ tabId, frameId: 0, documentId, url: `${DUO}/frame/v4/auth`, transitionType: 'link', transitionQualifiers: ['server_redirect'] }); return sender(DUO, tabId, documentId); }
  };
}

// Independent CBOR reader for checking encoded authentication data.
export function decodeCbor(bytes) {
  let at = 0;
  function read() {
    const byte = bytes[at++]; const major = byte >> 5; const extra = byte & 31;
    if (major === 7) return extra === 21;
    let length = extra;
    if (extra === 24) length = bytes[at++];
    if (extra === 25) { length = (bytes[at] << 8) | bytes[at + 1]; at += 2; }
    if (extra === 26) { length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0); at += 4; }
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2 || major === 3) { const part = bytes.slice(at, at + length); at += length; return major === 2 ? part : new TextDecoder().decode(part); }
    if (major === 4) return Array.from({ length }, read);
    if (major === 5) { const result = new Map(); for (let i = 0; i < length; i++) result.set(read(), read()); return result; }
    throw new Error('Unsupported test CBOR input');
  }
  return { value: read(), get consumed() { return at; } };
}
