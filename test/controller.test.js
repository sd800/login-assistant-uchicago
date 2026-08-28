import test from 'node:test';
import assert from 'node:assert/strict';
import { entryTarget, HANDOFF_MS, HISTORY_MS, DUO_MATCH } from '../extension/core/policy.js';
import { Controller } from '../extension/core/controller.js';
import { createLanguagePreference } from '../extension/core/locale.js';
import { createCredential } from '../extension/core/passkeys.js';
import { newPin } from '../extension/core/vault.js';
import { unb64 } from '../extension/core/encoding.js';
import { fixture, sender, ui, OKTA, DUO, creation, assertion } from './helpers.mjs';

async function withKey(extra = {}) {
  const { credential } = await createCredential({ options: creation(), origin: DUO, configuredOrigin: DUO, proof: { up: true, uv: false } });
  return { f: fixture({ credentials: [credential], ...extra }), credential };
}
const begin = (f, from, credential, extra = {}) => f.controller.dispatch({ type: 'PK_BEGIN', kind: 'get', options: assertion(credential, extra) }, from);

test('no password leaves the vault before confirmation', async () => {
  const f = fixture();
  await assert.rejects(f.controller.dispatch({ type: 'LOGIN_STEP', step: 'password' }, sender()), /Confirm this sign-in/);
  await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender());
  assert.equal(f.prompt().title, 'Sign in to UChicago with saved account?');
  assert.equal(f.windows.size, 1);
  assert.equal(JSON.stringify(f.state()).includes('test-only-password'), false);
  await assert.rejects(f.controller.dispatch({ type: 'LOGIN_STEP', step: 'password' }, sender()), /Confirm this sign-in/);
});
test('repeated detection produces only one prompt and cancel suppresses this document', async () => {
  const f = fixture();
  await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender());
  await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender());
  assert.equal(f.windows.size, 1);
  const p = f.prompt();
  await f.controller.dispatch({ type: 'PROMPT_DECIDE', id: p.id, action: 'cancel' }, ui(`confirm.html?id=${p.id}`));
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender())).status, 'cancelled');
  assert.equal(Object.keys(f.state().prompts).length, 0);
});
test('closing confirmation window cancels the flow', async () => {
  const f = fixture(); await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender());
  await f.controller.windowClosed(f.prompt().windowId);
  assert.equal(f.state().flows[7].status, 'cancelled');
});
test('password submits at most once per document even under concurrent messages', async () => {
  const f = fixture(); await f.start();
  const result = await Promise.all([1, 2, 3].map(() => f.controller.dispatch({ type: 'LOGIN_STEP', step: 'password' }, sender())));
  assert.equal(result.filter(r => r.password).length, 1);
  assert.equal(result.filter(r => r.skipped).length, 2);
});
test('only requested credentials are returned to Okta, never to Duo', async () => {
  const f = fixture(); await f.start();
  const user = await f.controller.dispatch({ type: 'LOGIN_STEP', step: 'username' }, sender());
  assert.equal(user.username, 'test-student'); assert.equal(user.password, undefined);
  const duoSender = await f.toDuo();
  await assert.rejects(f.controller.dispatch({ type: 'LOGIN_STEP', step: 'password' }, duoSender));
});
test('untrusted content cannot read settings or approve a prompt', async () => {
  const f = fixture(); await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender()); const p = f.prompt();
  await assert.rejects(f.controller.dispatch({ type: 'UI_GET' }, sender()), /Open the extension/);
  await assert.rejects(f.controller.dispatch({ type: 'PROMPT_DECIDE', id: p.id, action: 'approve' }, sender()), /Open the extension/);
  await assert.rejects(f.controller.dispatch({ type: 'PROMPT_GET', id: p.id }, ui('confirm.html?id=wrong')), /does not match/);
});
test('settings snapshot excludes password, private keys and PIN material', async () => {
  const { f, credential } = await withKey({ pin: await newPin('123456-test') });
  const snapshot = await f.controller.dispatch({ type: 'UI_GET' }, ui());
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes('test-only-password'), false);
  assert.equal(text.includes(credential.privateKey.d), false);
  assert.equal(text.includes('iterations'), false);
});
test('fresh login confirmation can authorize exactly one matching assertion', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
  const result = await begin(f, from, credential);
  assert.ok(result.response); assert.equal(f.state().flows[7].grant, null);
  assert.equal((await f.vault.read()).credentials[0].signCount, 1);
  const again = await begin(f, from, credential);
  assert.equal(again.pending, true); assert.equal(f.prompt().kind, 'get');
});
test('spent grant cannot be reused after worker restart', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
  await begin(f, from, credential);
  const restarted = new Controller(f.api, f.vault, f.clock);
  const result = await restarted.dispatch({ type: 'PK_BEGIN', kind: 'get', options: assertion(credential) }, from);
  assert.equal(result.pending, true);
});
test('expired presence approval requires a new confirmation', async () => {
  const { f, credential } = await withKey(); await f.start(); f.advance(30_000); const from = await f.toDuo();
  const result = await begin(f, from, credential);
  assert.equal(result.pending, true);
  assert.equal((await f.vault.read()).credentials[0].signCount, 0);
});
test('another tab does not inherit login approval', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo(8);
  assert.equal((await begin(f, from, credential)).fallback, true);
  assert.ok(f.state().flows[7].grant);
});
test('required UV never uses a click-only grant; native fallback is available', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
  const result = await begin(f, from, credential, { userVerification: 'required' });
  assert.equal(result.pending, true); const p = f.prompt();
  await assert.rejects(f.approve(p, { credentialId: credential.id }), /Identity verification is required/);
  await f.controller.dispatch({ type: 'PROMPT_DECIDE', id: p.id, action: 'fallback' }, ui(`confirm.html?id=${p.id}`));
  assert.equal((await f.controller.dispatch({ type: 'PK_POLL', id: result.id }, from)).fallback, true);
});
test('only a correct PIN supplies user verification', async () => {
  const { f, credential } = await withKey({ pin: await newPin('test-pin-123') });
  await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender());
  await assert.rejects(f.approve(f.prompt(), { pin: 'wrong-pin' }), /Incorrect verification PIN/);
  assert.equal(f.state().flows[7].status, 'asking');
  await f.approve(f.prompt(), { pin: 'test-pin-123' });
  const from = await f.toDuo(); const result = await begin(f, from, credential, { userVerification: 'required' });
  assert.ok(result.response); assert.equal(unb64(result.response.response.authenticatorData)[32], 0x05);
});
test('PIN failures are rate limited persistently across worker restart', async () => {
  const pin = await newPin('test-pin-123'); const f = fixture({ pin });
  await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender()); const p = f.prompt();
  for (let i = 0; i < 5; i++) await assert.rejects(f.approve(p, { pin: 'wrong-pin' }));
  const restarted = new Controller(f.api, f.vault, f.clock);
  await assert.rejects(restarted.dispatch({ type: 'PROMPT_DECIDE', id: p.id, action: 'approve', pin: 'test-pin-123' }, ui(`confirm.html?id=${p.id}`)), /Too many incorrect PIN attempts/);
});
test('registration requires separate confirmation and persists the private key locally', async () => {
  const f = fixture(); const from = await f.toDuo();
  const request = await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation() }, from);
  assert.equal(request.pending, true);
  assert.equal((await f.vault.read()).credentials.length, 0);
  const prompt = f.prompt();
  assert.equal(prompt.kind, 'create');
  await f.approve(prompt);
  const result = await f.controller.dispatch({ type: 'PK_POLL', id: request.id }, from);
  const stored = (await f.vault.read()).credentials[0];
  assert.equal(result.response.id, stored.id);
  assert.ok(stored.privateKey.d);
  assert.equal(JSON.stringify(result).includes(stored.privateKey.d), false);
  assert.equal((await f.controller.settings()).selectedCredentialId, '');
});

test('account management and root pages never request consent or receive credentials', async () => {
  const f = fixture(); await f.start();
  for (const path of ['/', '/enduser/settings', '/app/UserHome', '/signin/forgot-password']) {
    const from = { ...sender(), url: `${OKTA}${path}` };
    f.frames.set(7, { documentId: from.documentId, url: from.url });
    assert.equal((await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, from)).status, 'not-login');
    const result = await f.controller.dispatch({ type: 'LOGIN_STEP', step: 'password' }, from);
    assert.equal(result.password, undefined);
  }
});

test('consumed consent is durable before signing begins, including interrupted operations', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
  let durableState;
  f.controller.executeJob = async function(job) {
    job.started = true;
    await this.persist();
    durableState = structuredClone(f.state());
    throw new Error('simulated worker termination');
  };
  await assert.rejects(begin(f, from, credential), /simulated/);
  assert.equal(durableState.flows[7].grant, null);
  assert.equal(Object.values(durableState.jobs)[0].started, true);
  const restarted = new Controller(f.api, f.vault, f.clock);
  const result = await restarted.dispatch({ type: 'PK_BEGIN', kind: 'get', options: assertion(credential) }, from);
  assert.equal(result.error.name, 'NotAllowedError');
  assert.equal((await f.vault.read()).credentials[0].signCount, 0);
});

test('signing reads the vault only after consent consumption has been persisted', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
  const read = f.vault.read;
  let reads = 0;
  f.vault.read = async () => {
    if (++reads === 2) {
      assert.equal(f.state().flows[7].grant, null);
      assert.equal(Object.values(f.state().jobs)[0].started, true);
    }
    return read();
  };
  assert.ok((await begin(f, from, credential)).response);
  assert.equal(reads, 2);
});

test('navigation invalidates pending passkey requests and their confirmation windows', async () => {
  const { f, credential } = await withKey(); const from = await f.toDuo();
  const result = await begin(f, from, credential); const prompt = f.prompt();
  const url = `${DUO}/frame/v4/auth`; const documentId = 'new-duo-document';
  f.frames.set(7, { url, documentId });
  await f.controller.navigation({ tabId: 7, frameId: 0, url, documentId });
  assert.equal(f.state().jobs[result.id], undefined);
  assert.equal(f.windows.has(prompt.windowId), false);
  await assert.rejects(f.approve(prompt), /expired/);
});

test('returning to the school site ends authority without claiming successful login', async () => {
  const { f } = await withKey(); await f.start(); await f.toDuo();
  f.frames.set(7, { documentId: 'canvas', url: 'https://canvas.uchicago.edu/' });
  await f.controller.navigation({ tabId: 7, frameId: 0, documentId: 'canvas', url: 'https://canvas.uchicago.edu/' });
  assert.equal(f.state().flows[7], undefined);
  assert.match(f.api.storage.local.data.history[0].text, /confirm sign-in/);
});

test('cleanup expires approvals and does not repeatedly prompt on the same page', async () => {
  const f = fixture(); await f.start(); f.advance(300_000);
  await f.controller.cleanup();
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender())).status, 'expired');
  assert.equal(Object.keys(f.state().prompts).length, 0);
});

test('expired flow is stopped even before periodic cleanup has run', async () => {
  const f = fixture(); await f.start(); f.advance(300_000);
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender())).status, 'expired');
});

test('pausing unregisters Duo adapters and revokes outstanding authority', async () => {
  const f = fixture(); await f.controller.syncScripts(); await f.start();
  assert.equal(f.scripts.size, 2);
  await f.controller.dispatch({ type: 'UI_TOGGLE', enabled: false }, ui('popup.html'));
  assert.equal(f.scripts.size, 0);
  assert.equal(Object.keys(f.state().flows).length, 0);
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender())).status, 'disabled');
});

test('selected key deletion revokes grants without deleting other keys', async () => {
  const { f, credential } = await withKey(); await f.start();
  await f.controller.dispatch({ type: 'UI_DELETE', id: credential.id }, ui());
  assert.equal((await f.vault.read()).credentials.length, 0);
  assert.equal((await f.controller.settings()).selectedCredentialId, '');
  assert.equal(Object.keys(f.state().flows).length, 0);
});

test('wildcard Duo permission does not authorize a page outside an approved school flow', async () => {
  const f = fixture();
  f.permissions.clear();
  f.permissions.add('https://*.duosecurity.com/*');
  await f.controller.syncScripts();
  assert.equal(f.scripts.size, 2);
  for (const script of f.scripts.values()) assert.deepEqual(script.matches, [DUO_MATCH]);
  const other = 'https://api-another.duosecurity.com';
  f.frames.set(7, { url: other + '/frame/v4/auth', documentId: 'other-tenant' });
  assert.equal(await f.api.permissions.contains({ origins: [other + '/*'] }), true);
  assert.equal((await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation() }, sender(other, 7, 'other-tenant'))).fallback, true);
  assert.equal(Object.keys(f.state().prompts).length, 0);
});

test('legacy host settings are ignored and clearing data keeps flow detection ready', async () => {
  const f = fixture();
  f.permissions.clear();
  f.permissions.add('https://*.duosecurity.com/*');
  f.api.permissions.remove = async () => { throw new Error('Required host permissions cannot be removed here'); };
  const next = 'https://api-another.duosecurity.com';
  await f.controller.dispatch({ type: 'UI_SAVE', username: 'test-student', password: '', duoOrigin: next, enabled: true, selectedCredentialId: '' }, ui());
  assert.equal(f.scripts.size, 2);
  for (const script of f.scripts.values()) assert.deepEqual(script.matches, [DUO_MATCH]);
  await f.api.storage.local.set({ uiLanguage: 'en-US' });
  const language = createLanguagePreference(f.api.storage.local, f.api.storage.onChanged, 'zh-Hant');
  assert.equal(await language.initialize(), 'en-US');
  await f.controller.dispatch({ type: 'UI_CLEAR' }, ui());
  assert.equal(f.scripts.size, 2);
  assert.equal((await f.vault.read()).password, '');
  assert.equal(f.api.storage.local.data.uiLanguage, null);
  assert.equal(language.locale, 'zh-CN');
  language.dispose();
  assert.equal(f.permissions.has('https://*.duosecurity.com/*'), true);
});

test('withheld Duo access blocks adapters and authentication until permission is restored', async () => {
  const f = fixture();
  const before = await f.vault.read();
  f.permissions.clear();
  await f.controller.syncScripts();
  assert.equal(f.scripts.size, 0);
  await f.controller.dispatch({ type: 'UI_SAVE_SETTINGS', selectedCredentialId: '' }, ui());
  assert.deepEqual(await f.vault.read(), before);
  f.permissions.add('https://*.duosecurity.com/*');
  await f.controller.syncScripts();
  assert.equal(f.scripts.size, 2);
  f.frames.set(7, { url: DUO + '/frame/v4/auth', documentId: 'revoked-duo' });
  f.permissions.clear();
  await assert.rejects(f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation() }, sender(DUO, 7, 'revoked-duo')), /page or tab has changed/);
  assert.equal(Object.keys(f.state().prompts).length, 0);
});

test('changing the UI language does not reset an active sign-in or its bounded approval', async () => {
  const { f } = await withKey();
  await f.start();
  const before = structuredClone(f.state());
  await f.api.storage.local.set({ uiLanguage: 'zh-CN' });
  assert.equal((await f.controller.dispatch({ type: 'STATUS' }, sender())).active, true);
  assert.deepEqual(f.state(), before);
});

const entrySender = (url, documentId = 'entry-document', tabId = 7) => ({ ...sender(new URL(url).origin, tabId, documentId), url });
async function moveTo(f, url, documentId = 'next-document', controller = f.controller) {
  const from = entrySender(url, documentId);
  f.frames.set(7, { url, documentId });
  await controller.navigation({ tabId: 7, frameId: 0, url, documentId });
  return from;
}
async function approveEntry(f, kind) {
  const url = kind === 'portal' ? 'https://portal.uchicago.edu/ais/' : 'https://courses.uchicago.edu/';
  const from = entrySender(url);
  f.frames.set(7, { url, documentId: from.documentId });
  await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from);
  await f.approve(f.prompt());
  return from;
}
for (const kind of ['portal', 'courses']) {
  test(kind + ' entry requires approval, returns only a fixed target, and starts at most once', async () => {
    const f = fixture();
    const url = kind === 'portal' ? 'https://portal.uchicago.edu/ais/' : 'https://courses.uchicago.edu/';
    const from = entrySender(url);
    f.frames.set(7, { url, documentId: from.documentId });
    await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from);
    await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from);
    assert.equal(f.windows.size, 1);
    await assert.rejects(f.controller.dispatch({ type: 'ENTRY_STEP', target: entryTarget(kind) }, from), /Confirm this sign-in/);
    await f.approve(f.prompt());
    for (const type of ['UI_GET', 'LOGIN_DETECTED', 'LOGIN_STEP', 'PK_BEGIN']) {
      await assert.rejects(f.controller.dispatch({ type, step: 'password' }, from));
    }
    await assert.rejects(f.controller.dispatch({ type: 'ENTRY_STEP', target: 'https://example.com/' }, from), /link has changed/);
    const results = await Promise.all([1, 2, 3].map(() => f.controller.dispatch({ type: 'ENTRY_STEP', target: entryTarget(kind) }, from)));
    assert.equal(results.filter(r => r.target === entryTarget(kind)).length, 1);
    assert.equal(results.filter(r => r.skipped).length, 2);
    assert.deepEqual(Object.keys(results.find(r => r.target)), ['target']);
    assert.doesNotMatch(JSON.stringify(f.state()), /test-only-password/);
  });

  test(kind + ' approval survives its launch endpoint and worker restart, without a second Okta prompt', async () => {
    const { f, credential } = await withKey();
    const from = await approveEntry(f, kind);
    const approved = f.state().flows[7];
    await f.controller.dispatch({ type: 'ENTRY_STEP', target: entryTarget(kind) }, from);
    await moveTo(f, entryTarget(kind), 'launch-document');
    const restarted = new Controller(f.api, f.vault, f.clock);
    const oktaUrl = kind === 'courses' ? OKTA + '/app/uchicago_canvas_1/test/sso/saml?SAMLRequest=synthetic' : OKTA + '/oauth2/v1/authorize?state=synthetic';
    const okta = await moveTo(f, oktaUrl, 'app-document', restarted);
    assert.equal((await restarted.dispatch({ type: 'LOGIN_DETECTED' }, okta)).status, 'active');
    assert.equal(f.state().flows[7].id, approved.id);
    assert.equal(f.state().flows[7].grant.issuedAt, approved.grant.issuedAt);
    assert.equal(f.prompt(), undefined);
    assert.equal((await restarted.dispatch({ type: 'LOGIN_STEP', step: 'username' }, okta)).username, 'test-student');
    assert.equal((await restarted.dispatch({ type: 'LOGIN_STEP', step: 'password' }, okta)).password, 'test-only-password');
    const duo = await f.toDuo();
    assert.ok((await begin(f, duo, credential)).response);
  });
}

test('entry cancellation and closing the prompt suppress the current document; retry remains available', async () => {
  for (const action of ['cancel', 'close']) {
    const f = fixture();
    const from = entrySender('https://courses.uchicago.edu/');
    f.frames.set(7, { url: from.url, documentId: from.documentId });
    await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from);
    const p = f.prompt();
    if (action === 'close') await f.controller.windowClosed(p.windowId);
    else await f.controller.dispatch({ type: 'PROMPT_DECIDE', id: p.id, action: 'cancel' }, ui('confirm.html?id=' + p.id));
    assert.equal((await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from)).status, 'cancelled');
    await assert.rejects(f.controller.dispatch({ type: 'ENTRY_STEP', target: entryTarget('courses') }, from));
    await f.controller.dispatch({ type: 'UI_RETRY', tabId: 7 }, ui('popup.html'));
    assert.deepEqual(f.sent[0], { id: 7, message: { type: 'RECHECK' } });
    assert.equal((await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from)).status, 'asking');
  }
});

test('entry approval is rejected after a same-document route change', async () => {
  const f = fixture();
  const from = entrySender('https://courses.uchicago.edu/');
  f.frames.set(7, { url: from.url, documentId: from.documentId });
  await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from);
  const prompt = f.prompt();
  f.frames.set(7, { url: 'https://courses.uchicago.edu/resources', documentId: from.documentId });
  await assert.rejects(f.approve(prompt), /page has changed/);
  await assert.rejects(f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from), /page or tab has changed/);
});

test('entry messages from subframes, stale documents, and neighboring routes cannot start a sign-in', async () => {
  const f = fixture();
  const valid = entrySender('https://portal.uchicago.edu/ais/');
  f.frames.set(7, { url: valid.url, documentId: valid.documentId });
  for (const from of [{ ...valid, frameId: 1 }, { ...valid, documentId: 'stale' }, { ...valid, url: 'https://portal.uchicago.edu/other/' }, { ...valid, url: 'https://courses.uchicago.edu/help' }]) {
    await assert.rejects(f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from));
  }
  assert.equal(f.windows.size, 0);
});

test('entry handoff stops on unrelated destinations, a wrong launch endpoint, or timeout', async () => {
  for (const destination of ['https://example.com/', 'https://canvas.uchicago.edu/courses', entryTarget('portal'), OKTA + '/app/UserHome']) {
    const f = fixture();
    const from = await approveEntry(f, 'courses');
    await f.controller.dispatch({ type: 'ENTRY_STEP', target: entryTarget('courses') }, from);
    await moveTo(f, destination);
    assert.equal(f.state().flows[7], undefined, destination);
  }
  const f = fixture();
  const from = await approveEntry(f, 'courses');
  await f.controller.dispatch({ type: 'ENTRY_STEP', target: entryTarget('courses') }, from);
  f.advance(HANDOFF_MS);
  await moveTo(f, OKTA + '/app/test/sso/saml');
  assert.equal(f.state().flows[7], undefined);
});

test('a page cannot carry approval to Okta before the entry step has started', async () => {
  const f = fixture();
  await approveEntry(f, 'courses');
  const okta = await moveTo(f, OKTA + '/app/test/sso/saml');
  assert.equal(f.state().flows[7], undefined);
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, okta)).status, 'asking');
});

test('the entry redirect never renews passkey user-presence approval', async () => {
  const { f, credential } = await withKey();
  const from = await approveEntry(f, 'courses');
  await f.controller.dispatch({ type: 'ENTRY_STEP', target: entryTarget('courses') }, from);
  f.advance(30_000);
  await moveTo(f, OKTA + '/app/test/sso/saml');
  assert.equal((await begin(f, await f.toDuo(), credential)).pending, true);
});

test('entry pages respect pause and missing account settings', async () => {
  for (const mode of ['paused', 'empty']) {
    const f = fixture(mode === 'empty' ? { username: '', password: '' } : {});
    if (mode === 'paused') f.api.storage.local.data.settings.enabled = false;
    const from = entrySender('https://courses.uchicago.edu/');
    f.frames.set(7, { url: from.url, documentId: from.documentId });
    assert.equal((await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from)).status, mode === 'paused' ? 'disabled' : 'needs-setup');
    assert.equal(f.windows.size, 0);
  }
});

test('a combined form and a later password-only form cannot submit the password twice', async () => {
  const f = fixture(); await f.start();
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_STEP', step: 'combined' }, sender())).password, 'test-only-password');
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_STEP', step: 'password' }, sender())).skipped, true);
});

test('revoked portal or Okta access blocks old content scripts and pending approvals', async () => {
  for (const url of ['https://courses.uchicago.edu/', OKTA + '/app/test/sso/saml']) {
    const f = fixture();
    const from = entrySender(url);
    f.frames.set(7, { url, documentId: from.documentId });
    const type = url.startsWith(OKTA) ? 'LOGIN_DETECTED' : 'ENTRY_DETECTED';
    await f.controller.dispatch({ type }, from);
    const prompt = f.prompt();
    f.permissions.delete(new URL(url).origin + '/*');
    await assert.rejects(f.approve(prompt), /page has changed/);
    await assert.rejects(f.controller.dispatch({ type }, from), /page or tab has changed/);
    assert.equal(f.state().flows[7].status, 'asking');
  }
});

test('account-only saving ignores Duo drafts and works with withheld Duo access', async () => {
  const { f, credential } = await withKey({ pin: await newPin('existing-pin') });
  f.api.storage.local.data.settings.enabled = false;
  f.permissions.delete(DUO + '/*');
  const before = await f.vault.read();
  const settings = await f.controller.settings();
  await f.controller.dispatch({ type: 'UI_SAVE_ACCOUNT', username: before.username, password: ' exact new password ', duoOrigin: 'invalid', enabled: true, selectedCredentialId: 'invalid' }, ui());
  const after = await f.vault.read();
  assert.equal(after.password, ' exact new password ');
  assert.deepEqual(after.pin, before.pin);
  assert.deepEqual(after.credentials, [credential]);
  assert.deepEqual(await f.controller.settings(), settings);
});

test('Duo-only saving cannot save an account draft or change the on/off switch', async () => {
  const f = fixture();
  const before = await f.vault.read();
  f.api.storage.local.data.settings.enabled = false;
  await f.controller.dispatch({ type: 'UI_SAVE_SETTINGS', duoOrigin: DUO, selectedCredentialId: '', enabled: true, username: 'unsaved-account', password: 'unsaved-password' }, ui());
  assert.deepEqual(await f.vault.read(), before);
  assert.equal((await f.controller.settings()).enabled, false);
  await assert.rejects(f.controller.dispatch({ type: 'UI_SAVE_SETTINGS', selectedCredentialId: 'missing' }, ui()));
  assert.deepEqual(await f.vault.read(), before);
});

test('changing accounts requires a password and clears only the selected passkey association', async () => {
  const { f, credential } = await withKey();
  const before = await f.vault.read();
  await assert.rejects(f.controller.dispatch({ type: 'UI_SAVE_ACCOUNT', username: 'different-account', password: '' }, ui()), /Enter a password/);
  assert.deepEqual(await f.vault.read(), before);
  await f.controller.dispatch({ type: 'UI_SAVE_ACCOUNT', username: 'different-account', password: 'new-account-password' }, ui());
  assert.equal((await f.controller.settings()).selectedCredentialId, '');
  assert.equal((await f.controller.settings()).duoOrigin, undefined);
  assert.deepEqual((await f.vault.read()).credentials, [credential]);
});

test('independent saves remain settings-only actions and revoke existing authentication consent', async () => {
  for (const type of ['UI_SAVE_ACCOUNT', 'UI_SAVE_SETTINGS']) {
    const f = fixture(); await f.start();
    const message = { type, username: 'test-student', password: '', duoOrigin: DUO, selectedCredentialId: '' };
    await assert.rejects(f.controller.dispatch(message, ui('popup.html')), /Open the extension/);
    await assert.rejects(f.controller.dispatch(message, sender()), /Open the extension/);
    await f.controller.dispatch(message, ui());
    assert.deepEqual(f.state().flows, {});
  }
});

async function follow(f, url, overrides = {}) {
  const details = { tabId: 7, frameId: 0, documentId: crypto.randomUUID(), url,
    transitionType: 'link', transitionQualifiers: ['server_redirect'], ...overrides };
  f.frames.set(details.tabId, { url, documentId: details.documentId });
  await f.controller.navigation(details);
  return { ...sender(new URL(url).origin, details.tabId, details.documentId), url };
}

test('one approved flow follows multiple Duo hosts without saving or confirming individual sites', async () => {
  const { f, credential } = await withKey(); f.permissions.add(DUO_MATCH); await f.start();
  const expiry = f.state().flows[7].expiresAt;
  await follow(f, DUO + '/frame/v4/auth');
  const second = await follow(f, 'https://api-another.duosecurity.com/frame/v4/auth?token=synthetic-private-query');
  assert.equal((await f.controller.dispatch({ type: 'STATUS' }, second)).trusted, true);
  assert.equal(f.prompt(), undefined);
  assert.equal(f.state().flows[7].expiresAt, expiry);
  assert.ok((await begin(f, second, credential)).response);
  assert.equal(JSON.stringify(f.api.storage.local.data).includes('synthetic-private-query'), false);
  assert.equal((await f.controller.settings()).duoOrigin, undefined);
});

test('Duo may follow intermediate redirects outside school domains', async () => {
  const { f, credential } = await withKey(); f.permissions.add(DUO_MATCH); await f.start();
  const originalDeadline = f.state().flows[7].grant.issuedAt;
  const middle = await follow(f, 'https://sso.example.net/continue');
  assert.equal(f.state().flows[7].stage, 'transit');
  await assert.rejects(f.controller.dispatch({ type: 'LOGIN_STEP', step: 'password' }, middle));
  await follow(f, 'https://broker.example.org/saml', { transitionType: 'form_submit', transitionQualifiers: [] });
  const from = await follow(f, 'https://api-another.duosecurity.com/auth');
  assert.equal(f.state().flows[7].grant.issuedAt, originalDeadline);
  assert.ok((await begin(f, from, credential)).response);
});

test('direct destination pages on school and third-party domains end without reporting authentication failure or success', async () => {
  for (const url of ['https://canvas.uchicago.edu/', 'https://school-service.example.org/home']) {
    const f = fixture(); await f.start();
    await follow(f, url);
    assert.equal(f.state().flows[7].stage, 'transit');
    f.advance(HANDOFF_MS); await f.controller.cleanup();
    assert.equal(f.state().flows[7], undefined);
    assert.match(f.api.storage.local.data.history[0].text, /steps ended/);
    assert.doesNotMatch(f.api.storage.local.data.history[0].text, /failed|successful/i);
  }
});

test('a fixed entry can reach Duo or a third-party destination without a committed Okta page', async () => {
  for (const url of [DUO + '/auth', 'https://third-party.example.net/home']) {
    const f = fixture(); f.permissions.add(DUO_MATCH);
    const from = await approveEntry(f, 'courses');
    await f.controller.dispatch({ type: 'ENTRY_STEP', target: entryTarget('courses') }, from);
    const arrived = await follow(f, url);
    assert.equal(f.prompt(), undefined);
    if (url.startsWith(DUO)) assert.equal((await f.controller.dispatch({ type: 'STATUS' }, arrived)).trusted, true);
    else assert.equal(f.state().flows[7].stage, 'transit');
  }
});

test('Duo flow admission rejects absent consent, unrelated tabs, manual navigation, stale documents, iframes and expired authority', async () => {
  for (const scenario of ['no-consent', 'other-tab', 'typed', 'back', 'expired', 'stale', 'iframe', 'disabled']) {
    const f = fixture(); f.permissions.add(DUO_MATCH);
    if (scenario !== 'no-consent') await f.start();
    if (scenario === 'expired') f.advance(300_001);
    if (scenario === 'disabled') f.api.storage.local.data.settings.enabled = false;
    const details = { tabId: scenario === 'other-tab' ? 8 : 7, frameId: scenario === 'iframe' ? 1 : 0,
      documentId: 'candidate', url: DUO + '/auth', transitionType: scenario === 'typed' ? 'typed' : 'link',
      transitionQualifiers: scenario === 'typed' ? ['from_address_bar', 'server_redirect'] : scenario === 'back' ? ['forward_back', 'server_redirect'] : ['server_redirect'] };
    f.frames.set(details.tabId, { documentId: scenario === 'stale' ? 'newer' : details.documentId, url: details.url });
    await f.controller.navigation(details);
    const from = sender(DUO, details.tabId, scenario === 'stale' ? 'newer' : details.documentId);
    const result = await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation() }, from);
    assert.equal(result.fallback, true, scenario);
    assert.equal(f.prompt(), undefined, scenario);
  }
});

test('the intermediate observation window cannot extend approval or survive manual navigation', async () => {
  for (const interruption of ['timeout', 'manual']) {
    const f = fixture(); await f.start(); await follow(f, 'https://middle.example.net/');
    if (interruption === 'timeout') f.advance(HANDOFF_MS);
    else await follow(f, 'https://other.example.net/', { transitionType: 'typed', transitionQualifiers: ['from_address_bar'] });
    const from = await follow(f, DUO + '/auth');
    assert.equal((await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation() }, from)).fallback, true);
  }
});

test('RP and credential matching still apply across Duo host changes', async () => {
  const made = await createCredential({ options: creation({ rp: { id: new URL(DUO).hostname, name: 'Duo' } }),
    origin: DUO, configuredOrigin: DUO, proof: { up: true, uv: false } });
  const f = fixture({ credentials: [made.credential] }); f.permissions.add(DUO_MATCH); await f.start();
  const from = await follow(f, 'https://api-another.duosecurity.com/auth');
  const result = await begin(f, from, made.credential);
  assert.equal(result.error.name, 'SecurityError');
  assert.equal((await f.vault.read()).credentials[0].signCount, 0);
});

test('activity older than 24 hours is deleted on read, cleanup and new messages while keeping the 20-entry cap', async () => {
  const f = fixture(); f.advance(HISTORY_MS); const now = f.clock();
  await f.api.storage.local.set({ history: [{ at: now, text: 'Current' }, { at: now - HISTORY_MS + 1, text: 'Almost expired' },
    { at: now - HISTORY_MS, text: 'Expired' }, { at: now + 1, text: 'Future' }] });
  const snapshot = await f.controller.dispatch({ type: 'UI_GET' }, ui());
  assert.deepEqual(snapshot.history.map(item => item.text), ['Current', 'Almost expired']);
  assert.deepEqual(f.api.storage.local.data.history, snapshot.history);
  f.advance(1); await f.controller.cleanup();
  assert.deepEqual(f.api.storage.local.data.history.map(item => item.text), ['Current']);
  f.advance(HISTORY_MS); await f.controller.note('Fresh');
  assert.deepEqual(f.api.storage.local.data.history.map(item => item.text), ['Fresh']);
  for (let i = 0; i < 22; i++) await f.controller.note('Entry ' + i);
  assert.equal(f.api.storage.local.data.history.length, 20);
});

test('Okta app sign-in can start after arriving from an arbitrary third-party application', async () => {
  const f = fixture();
  await follow(f, 'https://vendor.example.net/account');
  const from = await follow(f, OKTA + '/app/vendor/opaque/sso/saml?RelayState=opaque');
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, from)).status, 'asking');
  await f.approve(f.prompt());
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_STEP', step: 'password' }, from)).password, 'test-only-password');
});

test('manual navigation to another Okta login page requires a new confirmation', async () => {
  const f = fixture(); await f.start();
  const from = await follow(f, OKTA + '/app/another/sso/saml', { transitionType: 'typed', transitionQualifiers: ['from_address_bar'] });
  assert.equal(f.state().flows[7], undefined);
  await assert.rejects(f.controller.dispatch({ type: 'LOGIN_STEP', step: 'password' }, from));
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, from)).status, 'asking');
});

test('a registration prompt cannot outlive the approved school flow', async () => {
  const f = fixture(); await f.start(); f.advance(299_000);
  const from = await f.toDuo();
  await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation() }, from);
  const prompt = f.prompt();
  assert.equal(prompt.deadline, f.state().flows[7].expiresAt);
  f.advance(1_000); await assert.rejects(f.approve(prompt), /expired/);
  assert.equal((await f.vault.read()).credentials.length, 0);
});
