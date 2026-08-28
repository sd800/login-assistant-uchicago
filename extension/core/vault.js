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
  constructor(repository) { this.repository = repository; }
  async load() {
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
    await this.repository.set('payload', await seal(data, key));
  }
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
    }
  };
}

export async function newPin(pin) {
  if (typeof pin !== 'string' || pin.length < 6 || pin.length > 128) throw new Error("Use 6–128 characters for your verification PIN.");
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
