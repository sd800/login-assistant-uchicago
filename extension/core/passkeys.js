import { allowedRp, parseHttps } from './policy.js';
import { b64, unb64, utf8, sha256, concat, cbor, uint32, randomId, derSignature } from './encoding.js';

export class PasskeyError extends Error {
  constructor(name, message, reason = '', features = []) {
    super(message); this.name = name; this.reason = reason; this.features = features;
  }
}
export function checkRequest(kind, options, origin, configuredOrigin) {
  if (!options || typeof options !== 'object') throw new PasskeyError('TypeError', "Missing WebAuthn request options.");
  const rpId = kind === 'create' ? options.rp?.id || new URL(origin).hostname : options.rpId || new URL(origin).hostname;
  if (!allowedRp(rpId, origin, configuredOrigin)) throw new PasskeyError('SecurityError', "The passkey does not belong to this site.");
  unb64(options.challenge, { min: 16, max: 1024 });
  const uv = kind === 'create' ? options.authenticatorSelection?.userVerification : options.userVerification;
  if (uv && !['required', 'preferred', 'discouraged'].includes(uv)) throw new PasskeyError('TypeError', "Unrecognized user verification requirement.");
  if (options.attestation === 'enterprise') {
    throw new PasskeyError('NotSupportedError', "This request needs a different authenticator. Use another passkey provider.", 'enterprise');
  }
  if (options.authenticatorSelection?.authenticatorAttachment === 'platform') {
    throw new PasskeyError('NotSupportedError', "This request needs a different authenticator. Use another passkey provider.", 'platform');
  }
  const extensions = options.extensions || {};
  const supported = ['credProps', kind === 'get' ? 'appid' : 'appidExclude'];
  const unsupported = Object.keys(extensions).filter(key => !supported.includes(key));
  if (unsupported.length) {
    // Only standard feature names may enter activity records, never page-supplied names or values.
    const known = ['appid', 'appidExclude', 'credentialProtectionPolicy', 'enforceCredentialProtectionPolicy',
      'credProtect', 'credBlob', 'getCredBlob', 'hmacCreateSecret', 'hmacGetSecret', 'largeBlob',
      'minPinLength', 'prf', 'uvm', 'devicePubKey', 'payment'];
    const features = unsupported.every(key => known.includes(key)) ? unsupported.sort() : [];
    throw new PasskeyError('NotSupportedError', "This request uses unsupported WebAuthn features. Use another passkey provider.", 'extensions', features);
  }
  const legacyAppId = extensions[kind === 'get' ? 'appid' : 'appidExclude'];
  if (legacyAppId !== undefined) {
    // Accept Duo's same-site legacy hint, but keep every local credential bound to its WebAuthn RP ID.
    let app;
    try { app = typeof legacyAppId === 'string' && parseHttps(legacyAppId); } catch { /* Invalid AppID. */ }
    if (!app || !(app.hostname === 'duosecurity.com' || app.hostname.endsWith('.duosecurity.com'))) {
      throw new PasskeyError('SecurityError', "The legacy security key address does not belong to Duo.");
    }
  }
  const list = kind === 'create' ? options.excludeCredentials : options.allowCredentials;
  if (list !== undefined) {
    if (!Array.isArray(list) || list.length > 100) throw new PasskeyError('TypeError', "Invalid credential list.");
    for (const item of list) {
      if (item.type !== 'public-key') throw new PasskeyError('TypeError', "Unrecognized credential type.");
      unb64(item.id, { min: 1, max: 1023 });
    }
  }
  if (kind === 'create') {
    if (!options.pubKeyCredParams?.some(x => x.type === 'public-key' && x.alg === -7)) {
      throw new PasskeyError('NotSupportedError', "This provider supports only ES256 (P-256) credentials.", 'algorithm');
    }
    unb64(options.user?.id, { min: 1, max: 64 });
    if (typeof options.user?.name !== 'string' || !options.user.name || options.user.name.length > 254) {
      throw new PasskeyError('TypeError', "Invalid passkey account information.");
    }
  }
  return { rpId, requireUV: uv === 'required' };
}

export function matchingCredentials(options, rpId, credentials) {
  const allow = options.allowCredentials || [];
  return credentials.filter(c => c.rpId === rpId && (allow.length ? allow.some(x => x.id === c.id) : c.discoverable));
}

function requireProof(proof, requireUV) {
  if (proof?.up !== true) throw new PasskeyError('NotAllowedError', "User confirmation is required.");
  if (requireUV && proof.uv !== true) throw new PasskeyError('NotAllowedError', "Identity verification is required for this request.");
}
const clientData = (kind, options, origin) => utf8(JSON.stringify({ type: `webauthn.${kind}`, challenge: options.challenge, origin, crossOrigin: false }));

export async function createCredential({ options, origin, configuredOrigin, credentials = [], proof }) {
  const { rpId, requireUV } = checkRequest('create', options, origin, configuredOrigin);
  requireProof(proof, requireUV);
  if ((options.excludeCredentials || []).some(x => credentials.some(c => c.id === x.id && c.rpId === rpId))) {
    throw new PasskeyError('InvalidStateError', "This passkey is already registered.");
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const id = randomId();
  const idBytes = unb64(id);
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64(publicKey.x)], [-3, unb64(publicKey.y)]]));
  const flags = 0x41 | (proof.uv ? 0x04 : 0); // Set UP and AT; set UV only for a verified PIN.
  const authData = concat(await sha256(utf8(rpId)), Uint8Array.of(flags), uint32(0), new Uint8Array(16), Uint8Array.of(0, idBytes.length), idBytes, cose);
  const discoverable = options.authenticatorSelection?.residentKey !== 'discouraged';
  const credential = { id, rpId, userId: options.user.id, userName: options.user.name, publicKey, privateKey, discoverable, signCount: 0, createdAt: Date.now(), lastUsedAt: null };
  const response = {
    id, rawId: id, type: 'public-key', authenticatorAttachment: 'cross-platform',
    response: {
      clientDataJSON: b64(clientData('create', options, origin)),
      attestationObject: b64(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
      authenticatorData: b64(authData), publicKey: b64(spki), publicKeyAlgorithm: -7, transports: []
    },
    clientExtensionResults: {
      ...(options.extensions?.credProps ? { credProps: { rk: discoverable } } : {}),
      ...(options.extensions?.appidExclude !== undefined ? { appidExclude: true } : {})
    }
  };
  return { credential, response };
}

export async function getAssertion({ options, origin, configuredOrigin, credential, proof }) {
  const { rpId, requireUV } = checkRequest('get', options, origin, configuredOrigin);
  requireProof(proof, requireUV);
  if (!matchingCredentials(options, rpId, [credential]).length) throw new PasskeyError('NotAllowedError', "No matching passkey was found.");
  if (credential.signCount >= 0xffffffff) throw new PasskeyError('NotAllowedError', "This passkey has reached its signature limit. Register a new one.");
  const nextCount = credential.signCount + 1;
  const authData = concat(await sha256(utf8(rpId)), Uint8Array.of(0x01 | (proof.uv ? 0x04 : 0)), uint32(nextCount));
  const data = clientData('get', options, origin);
  const key = await crypto.subtle.importKey('jwk', credential.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, concat(authData, await sha256(data))));
  return {
    credential: { ...credential, signCount: nextCount, lastUsedAt: Date.now() },
    response: {
      id: credential.id, rawId: credential.id, type: 'public-key', authenticatorAttachment: 'cross-platform',
      response: { clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(derSignature(signature)), userHandle: credential.userId },
      clientExtensionResults: options.extensions?.appid !== undefined ? { appid: false } : {}
    }
  };
}
