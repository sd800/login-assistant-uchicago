import { b64, unb64, utf8 } from './encoding.js';

const AAD = utf8('UChicago Login Assistant vault v1');
export const emptyVault = () => ({ version: 1, username: '', password: '', credentials: [], pin: null });

export async function seal(value, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, utf8(JSON.stringify(value)));
  return { version: 1, iv: b64(iv), data: b64(new Uint8Array(encrypted)) };
}
export async function unseal(blob, key) {
  if (blob.version !== 1) throw new Error("This vault version is not supported.");
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv, { min: 12, max: 12 }), additionalData: AAD }, key, unb64(blob.data, { max: 2_000_000 }));
  return JSON.parse(new TextDecoder().decode(bytes));
}
export class Vault {
  constructor(repository, session = null) { this.repository = repository; this.session = session; }
  async protection() {
    const record = await this.repository.get('v2');
    if (record) return { mode: record.mode, hasPin: !!record.pin, hasAccount: !!record.meta?.hasAccount,
      hasPassword: !!record.meta?.hasPassword, hasPasskeys: !!record.meta?.hasPasskeys,
      credentialId: record.device?.credentialId || '', prfSalt: record.device?.prfSalt || '',
      locked: !await this.sessionKey(record) };
    const data = (await this.load()).data;
    return { mode: data.pin ? 'pin-legacy' : 'none', hasPin: !!data.pin,
      hasAccount: !!data.username, hasPassword: !!data.password,
      hasPasskeys: !!data.credentials.length, credentialId: '', locked: !!data.pin };
  }
  async sessionKey(record) {
    const saved = this.session ? (await this.session.get('vaultUnlock')).vaultUnlock : null;
    if (!saved || saved.id !== record.id) return null;
    try { return await crypto.subtle.importKey('raw', unb64(saved.key, { min: 32, max: 32 }), 'AES-GCM', false, ['encrypt', 'decrypt']); }
    catch { return null; }
  }
  async remember(record, raw) {
    if (this.session) await this.session.set({ vaultUnlock: { id: record.id, key: b64(raw) } });
  }
  async forget() { if (this.session) await this.session.remove('vaultUnlock'); }
  async load() {
    const protectedRecord = await this.repository.get('v2');
    if (protectedRecord) {
      const key = await this.sessionKey(protectedRecord);
      if (!key) { const error = new Error('Unlock local data to continue.'); error.code = 'VAULT_LOCKED'; throw error; }
      return { key, data: await unseal(protectedRecord.payload, key) };
    }
    let key = await this.repository.get('key');
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await this.repository.set('key', key);
    }
    const blob = await this.repository.get('payload');
    return { key, data: blob ? await unseal(blob, key) : emptyVault() };
  }
  async read() { return (await this.load()).data; }
  async write(data) {
    const { key } = await this.load();
    const record = await this.repository.get('v2');
    if (record) {
      record.payload = await seal(data, key);
      record.meta = metadata(data);
      await this.repository.set('v2', record);
    } else await this.repository.set('payload', await seal(data, key));
  }
  async unlockPin(pin) {
    const record = await this.repository.get('v2');
    if (!record?.pin) throw new Error('Set a verification passphrase in settings.');
    const wrapping = await pinKey(pin, unb64(record.pin.salt), record.pin.iterations);
    try {
      const raw = await unwrap(record.pin.wrapped, wrapping);
      await this.remember(record, raw);
      raw.fill(0);
      return true;
    } catch (error) {
      if (error.name === 'OperationError') return false;
      throw error;
    }
  }
  async unlockDevice(secret, credentialId) {
    const record = await this.repository.get('v2');
    if (!record?.device || record.device.credentialId !== credentialId) throw new Error('Device verification is not configured.');
    try {
      const raw = await unwrap(record.device.wrapped, await deviceKey(secret));
      await this.remember(record, raw);
      raw.fill(0);
      return true;
    } catch (error) {
      if (error.name === 'OperationError') return false;
      throw error;
    }
  }
  async prepareProtected() {
    const current = await this.repository.get('v2');
    if (current) {
      const saved = this.session ? (await this.session.get('vaultUnlock')).vaultUnlock : null;
      if (!saved || saved.id !== current.id) throw new Error('Unlock local data to continue.');
      return { record: current, raw: unb64(saved.key, { min: 32, max: 32 }), data: await this.read() };
    }
    return { record: { version: 2, id: b64(crypto.getRandomValues(new Uint8Array(16))), mode: 'none' },
      raw: crypto.getRandomValues(new Uint8Array(32)), data: await this.read() };
  }
  async saveProtected(record, raw, data) {
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    record.payload = await seal(data, key);
    record.meta = metadata(data);
    await this.repository.replaceV2(record);
    await this.remember(record, raw);
    raw.fill(0);
  }
  async setPin(pin) {
    const { record, raw, data } = await this.prepareProtected();
    if (record.mode === 'device') throw new Error('Turn off device verification before changing the passphrase.');
    if (pin) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iterations = 600_000;
      record.pin = { salt: b64(salt), iterations, wrapped: await wrap(raw, await pinKey(pin, salt, iterations)) };
      data.pin = await newPin(pin);
      record.mode = 'pin';
      await this.saveProtected(record, raw, data);
    } else {
      data.pin = null;
      delete record.pin;
      await this.restoreLegacy(data); raw.fill(0);
    }
  }
  async setDevice(credentialId, secret, prfSalt) {
    const { record, raw, data } = await this.prepareProtected();
    record.device = { credentialId, prfSalt, wrapped: await wrap(raw, await deviceKey(secret)) };
    delete record.pin;
    record.mode = 'device';
    await this.saveProtected(record, raw, data);
  }
  async switchToPin(pin) {
    await newPin(pin);
    const { record, raw, data } = await this.prepareProtected();
    delete record.device;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iterations = 600_000;
    record.pin = { salt: b64(salt), iterations, wrapped: await wrap(raw, await pinKey(pin, salt, iterations)) };
    data.pin = await newPin(pin);
    record.mode = 'pin';
    await this.saveProtected(record, raw, data);
  }
  async restoreLegacy(data) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await this.repository.replaceLegacy(key, await seal(data, key));
    await this.forget();
  }
  async clear() { await this.repository.clear(); await this.forget(); }
}
export function indexedRepository() {
  let database;
  function open() {
    database ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('uchicago-login-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('vault');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }
  return {
    async get(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = db.transaction('vault').objectStore('vault').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },
    async set(key, value) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('vault', 'readwrite');
        tx.objectStore('vault').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("The vault could not be saved. Try again."));
      });
    },
    async replaceV2(value) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('vault', 'readwrite'), store = tx.objectStore('vault');
        store.put(value, 'v2'); store.delete('key'); store.delete('payload');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    },
    async replaceLegacy(key, payload) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('vault', 'readwrite'), store = tx.objectStore('vault');
        store.put(key, 'key'); store.put(payload, 'payload'); store.delete('v2');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    },
    async clear() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('vault', 'readwrite');
        tx.objectStore('vault').clear();
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    }
  };
}

function metadata(data) {
  return { hasAccount: !!data.username, hasPassword: !!data.password, hasPasskeys: !!data.credentials.length };
}
async function pinKey(pin, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function deviceKey(secret) {
  return crypto.subtle.importKey('raw', unb64(secret, { min: 32, max: 32 }), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function wrap(raw, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv: b64(iv), data: b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, raw))) };
}
async function unwrap(record, key) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv, { min: 12, max: 12 }) },
    key, unb64(record.data, { min: 48, max: 48 })));
}

export async function newPin(pin) {
  if (typeof pin !== 'string' || pin.length < 6 || pin.length > 128) throw new Error("Use 6–128 characters for your verification passphrase.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), hash: b64(await pinHash(pin, salt)), iterations: 310_000 };
}
async function pinHash(pin, salt) {
  const key = await crypto.subtle.importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310_000 }, key, 256));
}
export async function verifyPin(pin, record) {
  if (!record || typeof pin !== 'string' || !pin || pin.length > 128) return false;
  const a = await pinHash(pin, unb64(record.salt));
  const b = unb64(record.hash);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
