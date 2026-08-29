import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { b64, unb64, utf8, concat, sha256, cbor } from '../extension/core/encoding.js';
import { createCredential, getAssertion, checkRequest, matchingCredentials } from '../extension/core/passkeys.js';
import { Vault, seal, unseal, newPin, verifyPin } from '../extension/core/vault.js';
import { DUO, creation, assertion, decodeCbor, memoryRepository } from './helpers.mjs';

async function make(options = creation(), proof = { up: true, uv: false }) {
  return createCredential({ options, origin: DUO, configuredOrigin: DUO, proof });
}
test('base64url is canonical and supports large encrypted vaults', () => {
  const bytes = new Uint8Array(300_000).fill(255);
  assert.deepEqual(unb64(b64(bytes), { max: bytes.length }), bytes);
  for (const value of ['a', 'AA==', 'A+', 'AB', '*']) assert.throws(() => unb64(value));
});
test('CBOR integer, string, byte string, map and boolean encodings round trip independently', () => {
  const input = new Map([[1, 2], [3, -7], [-1, new Uint8Array(256).fill(5)], ['\u6c49\u5b57', [true, false, 65536]]]);
  const encoded = cbor(input);
  const decoded = decodeCbor(encoded);
  assert.deepEqual(decoded.value, input);
  assert.equal(decoded.consumed, encoded.length);
});
test('registration contains a valid COSE P-256 key and matching verification flags', async () => {
  const { response, credential } = await make();
  const attestation = decodeCbor(unb64(response.response.attestationObject)).value;
  assert.equal(attestation.get('fmt'), 'none');
  assert.equal(attestation.get('attStmt').size, 0);
  const auth = attestation.get('authData');
  assert.deepEqual(auth.slice(0, 32), await sha256(utf8('duosecurity.com')));
  assert.equal(auth[32], 0x41);
  assert.deepEqual(auth.slice(37, 53), new Uint8Array(16));
  const idLength = new DataView(auth.buffer, auth.byteOffset + 53, 2).getUint16(0);
  assert.equal(b64(auth.slice(55, 55 + idLength)), credential.id);
  const cose = decodeCbor(auth.slice(55 + idLength)).value;
  assert.equal(cose.get(3), -7);
  assert.equal(b64(cose.get(-2)), credential.publicKey.x);
  assert.equal(b64(cose.get(-3)), credential.publicKey.y);
  const spki = createPublicKey({ key: Buffer.from(unb64(response.response.publicKey)), type: 'spki', format: 'der' }).export({ format: 'jwk' });
  assert.equal(spki.x, credential.publicKey.x);
  assert.equal(response.clientExtensionResults.credProps.rk, true);
  assert.equal(JSON.stringify(response).includes(credential.privateKey.d), false);
});
test('assertion signature verifies independently with OpenSSL; tampering fails', async () => {
  const { credential } = await make();
  const options = assertion(credential);
  const signed = await getAssertion({ options, origin: DUO, configuredOrigin: DUO, credential, proof: { up: true, uv: false } });
  const { response } = signed.response;
  const auth = unb64(response.authenticatorData);
  const client = unb64(response.clientDataJSON);
  const message = concat(auth, await sha256(client));
  const key = createPublicKey({ key: credential.publicKey, format: 'jwk' });
  assert.equal(verify('sha256', message, key, unb64(response.signature)), true);
  message[0] ^= 1;
  assert.equal(verify('sha256', message, key, unb64(response.signature)), false);
  assert.equal(auth[32], 1);
  assert.equal(new DataView(auth.buffer).getUint32(33), 1);
  assert.equal(signed.credential.signCount, 1);
  assert.equal(JSON.parse(new TextDecoder().decode(client)).challenge, options.challenge);
});
test('verified PIN proof controls the UV flag and presence alone cannot satisfy required UV', async () => {
  const options = creation({ authenticatorSelection: { userVerification: 'required' } });
  await assert.rejects(make(options), /Identity verification is required/);
  await assert.rejects(make(creation(), { up: false, uv: true }), /User confirmation is required/);
  const verified = await make(options, { up: true, uv: true });
  assert.equal(unb64(verified.response.response.authenticatorData)[32], 0x45);
  await assert.rejects(getAssertion({ options: assertion(verified.credential, { userVerification: 'required' }), origin: DUO, configuredOrigin: DUO, credential: verified.credential, proof: { up: true, uv: false } }), /Identity verification is required/);
});
test('excludeCredentials is enforced after user consent', async () => {
  const { credential } = await make();
  await assert.rejects(createCredential({ options: creation({ excludeCredentials: [{ type: 'public-key', id: credential.id }] }), origin: DUO, configuredOrigin: DUO, credentials: [credential], proof: { up: true } }), { name: 'InvalidStateError' });
});
test('credential selection honors discoverability and allow lists', async () => {
  const { credential } = await make();
  assert.equal(matchingCredentials({}, credential.rpId, [credential]).length, 1);
  assert.equal(matchingCredentials({}, credential.rpId, [{ ...credential, discoverable: false }]).length, 0);
  assert.equal(matchingCredentials(assertion(credential), credential.rpId, [{ ...credential, discoverable: false }]).length, 1);
  assert.equal(matchingCredentials(assertion(credential), 'wrong', [credential]).length, 0);
});
test('unsupported capabilities, bad challenge, RP mismatch fail explicitly', () => {
  for (const options of [creation({ extensions: { prf: {} } }), creation({ attestation: 'enterprise' }), creation({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }), creation({ authenticatorSelection: { authenticatorAttachment: 'platform' } })]) assert.throws(() => checkRequest('create', options, DUO, DUO), { name: 'NotSupportedError' });
  assert.throws(() => checkRequest('create', creation({ challenge: 'AA' }), DUO, DUO));
  assert.throws(() => checkRequest('create', creation({ rp: { id: 'evil.com' } }), DUO, DUO), { name: 'SecurityError' });
});
test('AES-GCM authenticates ciphertext and rotates IVs', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const data = { password: 'test-secret-only', credentials: [] };
  const a = await seal(data, key); const b = await seal(data, key);
  assert.notEqual(a.iv, b.iv);
  assert.equal(JSON.stringify(a).includes(data.password), false);
  assert.deepEqual(await unseal(a, key), data);
  const damaged = unb64(a.data); damaged[0] ^= 1;
  await assert.rejects(unseal({ ...a, data: b64(damaged) }, key));
});
test('vault can reopen with a nonextractable persisted key', async () => {
  const repo = memoryRepository(); const vault = new Vault(repo);
  const data = await vault.read(); data.password = 'test-not-a-real-secret';
  await vault.write(data);
  assert.equal((await new Vault(repo).read()).password, data.password);
  assert.equal(repo.map.get('key').extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', repo.map.get('key')));
});
test('PIN verifies only the supplied correct value and is salted', async () => {
  const pin = await newPin('123456-test'); const second = await newPin('123456-test');
  assert.notEqual(pin.hash, second.hash);
  assert.equal(await verifyPin('123456-test', pin), true);
  assert.equal(await verifyPin('wrong-value', pin), false);
  assert.equal(await verifyPin('', pin), false);
  await assert.rejects(newPin('123'));
});

test('Duo AppID hints keep WebAuthn RP hashing, signatures, and exclusions intact', async () => {
  const appid = DUO + '/legacy/app-id';
  const options = creation({ extensions: { credProps: true, appidExclude: appid } });
  const { credential, response } = await make(options);
  assert.deepEqual(response.clientExtensionResults, { credProps: { rk: true }, appidExclude: true });
  await assert.rejects(createCredential({ options: { ...options, excludeCredentials: [{ type: 'public-key', id: credential.id }] },
    origin: DUO, configuredOrigin: DUO, credentials: [credential], proof: { up: true } }), { name: 'InvalidStateError' });
  const signed = await getAssertion({ options: assertion(credential, { extensions: { appid } }),
    origin: DUO, configuredOrigin: DUO, credential, proof: { up: true, uv: false } });
  const auth = unb64(signed.response.response.authenticatorData);
  assert.deepEqual(auth.slice(0, 32), await sha256(utf8(credential.rpId)));
  assert.deepEqual(signed.response.clientExtensionResults, { appid: false });
  const message = concat(auth, await sha256(unb64(signed.response.response.clientDataJSON)));
  assert.equal(verify('sha256', message, createPublicKey({ key: credential.publicKey, format: 'jwk' }), unb64(signed.response.response.signature)), true);
  for (const invalid of ['http://duosecurity.com/app', 'https://duosecurity.com.evil.test/app', 'https://evilduosecurity.com/app', 'https://user@duosecurity.com/app', false]) {
    assert.throws(() => checkRequest('get', assertion(credential, { extensions: { appid: invalid } }), DUO, DUO), { name: 'SecurityError' });
  }
});
