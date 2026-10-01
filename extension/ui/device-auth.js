import { b64, unb64 } from '../core/encoding.js';

function randomBytes(size) { return crypto.getRandomValues(new Uint8Array(size)); }
function checkedAssertion(assertion, challenge, credentialId) {
  if (!assertion || b64(new Uint8Array(assertion.rawId)) !== credentialId) throw new Error('Device verification did not match this extension.');
  const client = JSON.parse(new TextDecoder().decode(assertion.response.clientDataJSON));
  const flags = new Uint8Array(assertion.response.authenticatorData)[32];
  if (client.type !== 'webauthn.get' || client.challenge !== b64(challenge) || client.origin !== location.origin || !(flags & 0x04)) {
    throw new Error('Device verification did not complete.');
  }
  const result = assertion.getClientExtensionResults()?.prf?.results?.first;
  if (!result || result.byteLength !== 32) throw new Error('This device cannot protect local data with device verification.');
  return b64(new Uint8Array(result));
}

export async function verifyDevice(credentialId, prfSalt) {
  if (!navigator.credentials?.get) throw new Error('Device verification is unavailable in this browser.');
  const challenge = randomBytes(32);
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge, timeout: 120_000, userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: unb64(credentialId) }],
    extensions: { prf: { eval: { first: unb64(prfSalt, { min: 32, max: 32 }) } } }
  } });
  return checkedAssertion(assertion, challenge, credentialId);
}

export async function registerDevice() {
  if (!navigator.credentials?.create ||
      !globalThis.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable ||
      !await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) {
    throw new Error('Device verification is unavailable in this browser.');
  }
  const prfSalt = b64(randomBytes(32));
  const credential = await navigator.credentials.create({ publicKey: {
    challenge: randomBytes(32), rp: { name: 'UChicago Login Assistant' },
    user: { id: randomBytes(16), name: 'Local vault', displayName: 'UChicago Login Assistant' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 120_000,
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
    extensions: { prf: { eval: { first: unb64(prfSalt) } } }
  } });
  if (!credential?.getClientExtensionResults()?.prf?.enabled) {
    throw new Error('This device cannot protect local data with device verification.');
  }
  const credentialId = b64(new Uint8Array(credential.rawId));
  const secret = await verifyDevice(credentialId, prfSalt);
  return { credentialId, prfSalt, secret };
}
