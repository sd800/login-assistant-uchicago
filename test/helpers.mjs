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
  const rules = new Map(), ruleUpdates = [], reloaded = [], cookieOps = [];
  let cookies = [];
  const permissions = new Set([`${DUO}/*`, `${OKTA}/*`, '*://uchicago.okta.com/*', '*://*.duosecurity.com/*', 'https://portal.uchicago.edu/*', 'https://courses.uchicago.edu/*', '*://my.uchicago.edu/', '*://*.ais.uchicago.edu/*']);
  const sent = [];
  const changeListeners = new Set();
  const notify = changes => { for (const listener of changeListeners) listener(changes, 'local'); };
  const api = {
    runtime: {
      id: EXTENSION_ID, getURL: path => `chrome-extension://${EXTENSION_ID}/${path}`,
      async getContexts(filter = {}) {
        const contexts = [...frames].filter(([, frame]) =>
          frame.url?.startsWith(`chrome-extension://${EXTENSION_ID}/`) &&
          (!frame.documentLifecycle || frame.documentLifecycle === 'active'))
          .map(([tabId, frame]) => ({ contextType: 'TAB', tabId, frameId: frame.frameId ?? 0,
            documentId: frame.documentId, documentUrl: frame.url }));
        return contexts.filter(context => Object.entries({ contextTypes: 'contextType', tabIds: 'tabId',
          frameIds: 'frameId', documentIds: 'documentId' }).every(([key, field]) =>
          !filter[key] || filter[key].includes(context[field])));
      }
    },
    storage: { session: storage(), local: storage({ settings: { enabled: true, automaticLogin: true, duoOrigin: DUO, selectedCredentialId: data.credentials?.[0]?.id || '' } }, notify),
      onChanged: { addListener: listener => changeListeners.add(listener), removeListener: listener => changeListeners.delete(listener) } },
    cookies: {
      async getAll({ domain }) { return structuredClone(cookies.filter(c => { const host = c.domain.replace(/^\./, ''); return host === domain || host.endsWith('.' + domain); })); },
      async get(details) { cookieOps.push({ type: 'get', details: structuredClone(details) }); const url = new URL(details.url); return structuredClone(cookies.find(c => c.name === details.name && c.storeId === details.storeId && c.path === url.pathname && (!details.partitionKey ? !c.partitionKey : JSON.stringify(c.partitionKey) === JSON.stringify(details.partitionKey)) && (url.hostname === c.domain.replace(/^\./, '') || url.hostname.endsWith('.' + c.domain.replace(/^\./, ''))))); },
      async remove(details) { cookieOps.push({ type: 'remove', details: structuredClone(details) }); const current = await this.get(details); if (!current) return; cookies = cookies.filter(c => c !== cookies.find(x => JSON.stringify(x) === JSON.stringify(current))); return details; }
    },
    permissions: {
      async getAll() { return { origins: [...permissions] }; },
      async contains({ origins = [], permissions: named = [] }) {
        if (named.some(name => name !== 'cookies')) return false;
        return origins.every(origin => permissions.has(origin) ||
          permissions.has(origin.replace(/^https?:/, '*:').replace(/\/\*$/, '/')) ||
          (permissions.has('https://*.duosecurity.com/*') || permissions.has('*://*.duosecurity.com/*')) && /^https:\/\/(?:[a-z0-9-]+\.)*duosecurity\.com\//.test(origin));
      },
      async remove({ origins }) { origins.forEach(origin => permissions.delete(origin)); return true; }
    },
    webNavigation: { async getFrame({ tabId }) {
      const frame = frames.get(tabId);
      // Chrome's webNavigation API does not expose chrome-extension documents.
      return frame?.url?.startsWith('chrome-extension:') ? null : frame;
    } },
    declarativeNetRequest: {
      async getDynamicRules({ ruleIds } = {}) { return [...rules.values()].filter(rule => !ruleIds || ruleIds.includes(rule.id)).map(rule => structuredClone(rule)); },
      async updateDynamicRules(change) {
        ruleUpdates.push(structuredClone(change));
        for (const id of change.removeRuleIds || []) rules.delete(id);
        for (const rule of change.addRules || []) rules.set(rule.id, structuredClone(rule));
      }
    },
    tabs: { async reload(id) { reloaded.push(id); }, async create(options) { const id = Math.max(...frames.keys()) + 1; frames.set(id, { url: options.url, documentId: 'setup-entry-' + id }); return { id, ...options }; }, async get(id) { return { id, ...frames.get(id) }; }, async sendMessage(id, message) { sent.push({ id, message }); } },
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
    controller, api, vault, frames, windows, scripts, permissions, sent, rules, ruleUpdates, reloaded, cookieOps,
    setCookies: values => { cookies = structuredClone(values); }, cookies: () => structuredClone(cookies),
    clock: () => now, advance: ms => { now += ms; },
    state: () => api.storage.session.data.state,
    prompt: () => Object.values(api.storage.session.data.state.prompts)[0],
    async approve(prompt, extra = {}) { return controller.dispatch({ type: 'PROMPT_DECIDE', id: prompt.id, action: 'approve', ...extra }, ui(`confirm.html?id=${prompt.id}`)); },
    async start({ setup = false, ...extra } = {}) {
      if (setup) {
        const state = api.storage.session.data.state || { flows: {}, prompts: {}, jobs: {}, setups: {} };
        state.setups ||= {}; state.setups[7] = now + 120_000;
        await api.storage.session.set({ state });
      }
      await controller.dispatch({ type: 'LOGIN_DETECTED' }, sender()); await this.approve(this.prompt(), extra); },
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
