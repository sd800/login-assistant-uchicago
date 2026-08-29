(() => {
  'use strict';
  if (window.top !== window || !location.hostname.endsWith('.duosecurity.com') || !navigator.credentials) return;
  const installed = Symbol.for('uchicago.passkey.bridge');
  if (navigator.credentials.get[installed]) return;
  const container = navigator.credentials;
  const original = { create: container.create, get: container.get };
  const native = { create: original.create.bind(container), get: original.get.bind(container) };
  const pending = new Map();
  function encode(value) {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let text = '';
      for (const byte of bytes) text += String.fromCharCode(byte);
      return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    }
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, encode(val)]));
    return value;
  }
  function buffer(value) {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, c => c.charCodeAt(0)).buffer;
  }
  function credential(wire, kind) {
    const raw = wire.response;
    const response = Object.create(kind === 'create' ? AuthenticatorAttestationResponse.prototype : AuthenticatorAssertionResponse.prototype);
    const values = { clientDataJSON: buffer(raw.clientDataJSON) };
    if (kind === 'create') {
      values.attestationObject = buffer(raw.attestationObject);
      values.getTransports = () => [...raw.transports];
      values.getAuthenticatorData = () => buffer(raw.authenticatorData);
      values.getPublicKey = () => buffer(raw.publicKey);
      values.getPublicKeyAlgorithm = () => raw.publicKeyAlgorithm;
    } else {
      values.authenticatorData = buffer(raw.authenticatorData);
      values.signature = buffer(raw.signature);
      values.userHandle = raw.userHandle ? buffer(raw.userHandle) : null;
    }
    for (const [key, value] of Object.entries(values)) Object.defineProperty(response, key, { value, enumerable: true });
    const result = Object.create(PublicKeyCredential.prototype);
    const properties = {
      id: wire.id, rawId: buffer(wire.rawId), type: 'public-key', authenticatorAttachment: wire.authenticatorAttachment, response,
      getClientExtensionResults: () => structuredClone(wire.clientExtensionResults),
      toJSON: () => structuredClone(wire)
    };
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(result, key, { value, enumerable: true });
    return result;
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== 'uchicago-passkeys-v1' || data.direction !== 'response') return;
    pending.get(data.id)?.resolve(data.result);
  });
  async function handle(kind, options) {
    if (!options?.publicKey) return native[kind](options);
    // Even browser-managed requests wait for the isolated adapter to decide
    // whether this is a default method being replaced in an approved sign-in.
    const browserManaged = !!options.mediation && !['optional', 'required'].includes(options.mediation);
    if (options.signal?.aborted) throw new DOMException("Authentication canceled.", 'AbortError');
    const id = crypto.randomUUID();
    let timer;
    let abort;
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve });
        const timeout = Math.min(125_000, Math.max(1_000, Number(options.publicKey.timeout) || 125_000));
        const cancel = () => window.postMessage({ channel: 'uchicago-passkeys-v1', direction: 'cancel', id }, location.origin);
        timer = setTimeout(() => { cancel(); reject(new DOMException("Authentication timed out. Try again or use another passkey provider.", 'NotAllowedError')); }, timeout);
        abort = () => { cancel(); reject(new DOMException("Authentication canceled.", 'AbortError')); };
        options.signal?.addEventListener('abort', abort, { once: true });
        window.postMessage({ channel: 'uchicago-passkeys-v1', direction: 'request', id, kind, browserManaged, options: encode(options.publicKey) }, location.origin);
      });
    } finally {
      pending.delete(id);
      clearTimeout(timer);
      if (abort) options.signal?.removeEventListener('abort', abort);
    }
    if (options.signal?.aborted) throw new DOMException("Authentication canceled.", 'AbortError');
    if (result.fallback) return native[kind](options);
    if (result.error) throw new DOMException(result.error.message, result.error.name);
    if (!result.response) throw new DOMException("The passkey provider returned an invalid response.", 'UnknownError');
    const value = credential(result.response, kind);
    if (kind === 'get') window.postMessage({ channel: 'uchicago-passkeys-v1', direction: 'delivered', id }, location.origin);
    return value;
  }
  for (const kind of ['create', 'get']) {
    const wrapped = function(options) {
      if (this !== container) return Reflect.apply(original[kind], this, [options]);
      return handle(kind, options);
    };
    Object.defineProperty(wrapped, installed, { value: true });
    // Cover both navigator.credentials.get() and prototype-based calls cached
    // by a page after document_start. Keep normal receiver validation.
    if (typeof CredentialsContainer === 'function') {
      const descriptor = Object.getOwnPropertyDescriptor(CredentialsContainer.prototype, kind);
      if (descriptor?.configurable) Object.defineProperty(CredentialsContainer.prototype, kind, { ...descriptor, value: wrapped });
    }
    Object.defineProperty(container, kind, { configurable: true, writable: true, value: wrapped });
  }
})();
