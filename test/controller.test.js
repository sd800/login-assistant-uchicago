import test from 'node:test';
import assert from 'node:assert/strict';
import { entryTarget, FLOW_MS, HANDOFF_MS, HISTORY_MS, DUO_MATCH } from '../extension/core/policy.js';
import { Controller } from '../extension/core/controller.js';
import { SHORTCUT_RULE_ID, PORTAL_URL, shortcutRule } from '../extension/core/shortcut.js';
import { createLanguagePreference, translate } from '../extension/core/locale.js';
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
test('one login confirmation covers distinct matching requests within the approved flow', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
  const deadline = f.state().flows[7].grant.expiresAt;
  for (let i = 0; i < 2; i++) {
    f.advance(i === 0 ? 90_000 : 10_000);
    assert.ok((await begin(f, from, credential)).response);
    assert.equal(f.prompt(), undefined);
  }
  assert.equal(f.state().flows[7].grant.requests.length, 2);
  assert.equal(f.state().flows[7].grant.expiresAt, deadline);
  assert.equal((await f.vault.read()).credentials[0].signCount, 2);
});
test('a handled challenge cannot be signed again after worker restart', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
  const options = assertion(credential);
  assert.ok((await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'get', options }, from)).response);
  const restarted = new Controller(f.api, f.vault, f.clock);
  const repeated = await restarted.dispatch({ type: 'PK_BEGIN', kind: 'get', options }, from);
  assert.equal(repeated.error.name, 'NotAllowedError');
  const fresh = await restarted.dispatch({ type: 'PK_BEGIN', kind: 'get', options: assertion(credential) }, from);
  assert.ok(fresh.response); assert.equal(f.prompt(), undefined);
});
test('approval remains usable until five minutes but never beyond the original flow deadline', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
  f.advance(299_999);
  assert.ok((await begin(f, from, credential)).response);
  f.advance(1);
  assert.equal((await begin(f, from, credential)).response, undefined);
  assert.equal((await f.vault.read()).credentials[0].signCount, 1);
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

test('accepted challenges are durable before signing begins, including interrupted operations', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
  let durableState;
  f.controller.executeJob = async function(job) {
    job.started = true;
    await this.persist();
    durableState = structuredClone(f.state());
    throw new Error('simulated worker termination');
  };
  await assert.rejects(begin(f, from, credential), /simulated/);
  assert.equal(durableState.flows[7].grant.requests.length, 1);
  assert.equal(Object.values(durableState.jobs)[0].started, true);
  const restarted = new Controller(f.api, f.vault, f.clock);
  const result = await restarted.dispatch({ type: 'PK_BEGIN', kind: 'get', options: assertion(credential) }, from);
  assert.equal(result.error.name, 'NotAllowedError');
  assert.equal((await f.vault.read()).credentials[0].signCount, 0);
});

test('signing reads the vault only after the accepted challenge has been persisted', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
  const read = f.vault.read;
  let reads = 0;
  f.vault.read = async () => {
    if (++reads === 2) {
      assert.equal(f.state().flows[7].grant.requests.length, 1);
      assert.equal(Object.values(f.state().jobs)[0].started, true);
    }
    return read();
  };
  assert.ok((await begin(f, from, credential)).response);
  assert.equal(reads, 2);
});

test('navigation invalidates pending passkey requests and their confirmation windows', async () => {
  const { f, credential } = await withKey(); const from = await f.toDuo();
  const result = await begin(f, from, credential, { userVerification: 'required' }); const prompt = f.prompt();
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
  const f = fixture(); await f.start(); f.advance(FLOW_MS);
  await f.controller.cleanup();
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender())).status, 'expired');
  assert.equal(Object.keys(f.state().prompts).length, 0);
});

test('approved flows prevent automatic tab discard and restore the previous setting when authority ends', async () => {
  const f = fixture();
  await f.start();
  assert.deepEqual(f.tabUpdates, [{ id: 7, properties: { autoDiscardable: false } }]);
  f.advance(FLOW_MS);
  assert.deepEqual(await f.controller.cleanup(), []);
  assert.deepEqual(f.tabUpdates, [
    { id: 7, properties: { autoDiscardable: false } },
    { id: 7, properties: { autoDiscardable: true } }
  ]);
});

test('expired flow is stopped even before periodic cleanup has run', async () => {
  const f = fixture(); await f.start(); f.advance(FLOW_MS);
  assert.equal((await f.controller.dispatch({ type: 'LOGIN_DETECTED' }, sender())).status, 'expired');
});

test('pausing revokes outstanding authority while static adapters remain passive', async () => {
  const f = fixture(); await f.controller.syncScripts(); await f.start();
  assert.equal(f.scripts.size, 0);
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
  assert.equal(f.scripts.size, 0);
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
  assert.equal(f.scripts.size, 0);
  await f.api.storage.local.set({ uiLanguage: 'en-US' });
  const language = createLanguagePreference(f.api.storage.local, f.api.storage.onChanged, 'zh-Hant');
  assert.equal(await language.initialize(), 'en-US');
  await f.controller.dispatch({ type: 'UI_CLEAR' }, ui());
  assert.equal(f.scripts.size, 0);
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
  assert.equal(f.scripts.size, 0);
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
const shortcutSender = (tabId = 7, documentId = 'shortcut-document') => ({
  ...ui('start.html'), tab: { id: tabId }, frameId: 0, documentId
});
async function openShortcut(f, from = shortcutSender()) {
  f.frames.set(from.tab.id, { url: from.url, documentId: from.documentId });
  return f.controller.dispatch({ type: 'SHORTCUT_OPEN' }, from);
}

test('the navigation shortcut only matches HTTP or HTTPS home requests', () => {
  const rule = shortcutRule(), match = new RegExp(rule.condition.regexFilter);
  for (const url of ['http://my.uchicago.edu/', 'https://my.uchicago.edu/', 'https://my.uchicago.edu/?&']) assert.ok(match.test(url));
  for (const url of ['https://my.uchicago.edu/help', 'https://my.uchicago.edu/?code=token',
    'https://my.uchicago.edu.example/', 'https://myXuchicagoXedu/', 'https://my.uchicago.edu:444/',
    'https://other.example/?next=https://my.uchicago.edu/', 'ftp://my.uchicago.edu/']) assert.equal(match.test(url), false);
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
  assert.deepEqual(rule.condition.requestMethods, ['get']);
});

test('the shortcut follows saved account, pause, and access changes without redundant rule writes', async () => {
  const f = fixture({ username: '', password: '' });
  await f.controller.syncScripts();
  assert.equal(f.ruleUpdates.length, 0);
  await f.controller.dispatch({ type: 'UI_SAVE_ACCOUNT', username: 'test-student', password: 'test-only-password' }, ui());
  assert.ok(f.rules.has(SHORTCUT_RULE_ID));
  await f.controller.syncScripts();
  assert.equal(f.ruleUpdates.length, 1);
  await f.controller.dispatch({ type: 'UI_TOGGLE', enabled: false }, ui('popup.html'));
  assert.equal(f.rules.size, 0);
  await f.controller.dispatch({ type: 'UI_TOGGLE', enabled: true }, ui('popup.html'));
  assert.ok(f.rules.has(SHORTCUT_RULE_ID));
  f.permissions.delete('*://my.uchicago.edu/');
  f.permissions.add('http://my.uchicago.edu/*');
  await f.controller.syncScripts();
  assert.ok(f.rules.has(SHORTCUT_RULE_ID));
  f.permissions.delete('http://my.uchicago.edu/*');
  await f.controller.syncScripts();
  assert.equal(f.rules.size, 0);
  f.permissions.add('https://my.uchicago.edu/*');
  await f.controller.syncScripts();
  await f.controller.dispatch({ type: 'UI_CLEAR' }, ui());
  assert.equal(f.rules.size, 0);
});

test('an unreadable account removes the shortcut rather than trapping the next navigation', async () => {
  const f = fixture(); await f.controller.syncScripts();
  f.vault.read = async () => { throw new Error('Storage unavailable'); };
  await f.controller.syncScripts();
  assert.equal(f.rules.size, 0);
});

test('inline confirmation bypasses the portal and carries one approval through AIS, Okta, and Duo', async () => {
  const { f, credential } = await withKey();
  const from = shortcutSender(), prompt = await openShortcut(f, from);
  assert.equal(await f.api.webNavigation.getFrame({ tabId: 7, frameId: 0 }), null);
  assert.equal((await f.controller.dispatch({ type: 'SHORTCUT_OPEN' }, from)).id, prompt.id);
  assert.equal(f.windows.size, 0);
  assert.equal(f.state().flows[7].status, 'asking');
  assert.doesNotMatch(JSON.stringify(prompt), /test-only-password|privateKey/);
  for (const type of ['UI_GET', 'LOGIN_STEP', 'PK_BEGIN']) await assert.rejects(f.controller.dispatch({ type }, from));
  const result = await f.controller.dispatch({ type: 'SHORTCUT_DECIDE', id: prompt.id, action: 'approve', target: 'https://other.example/' }, from);
  assert.equal(result.target, entryTarget('portal'));
  assert.equal(f.state().flows[7].stage, 'handoff');
  assert.equal(f.state().flows[7].expiresAt, f.clock() + FLOW_MS);
  assert.equal(f.prompt(), undefined);
  const grant = structuredClone(f.state().flows[7].grant);
  await assert.rejects(f.controller.dispatch({ type: 'SHORTCUT_DECIDE', id: prompt.id, action: 'approve' }, from));
  await moveTo(f, result.target, 'ais-document');
  const restarted = new Controller(f.api, f.vault, f.clock);
  const okta = await moveTo(f, OKTA + '/oauth2/v1/authorize?state=synthetic', 'okta-next', restarted);
  assert.equal((await restarted.dispatch({ type: 'LOGIN_DETECTED' }, okta)).status, 'active');
  assert.deepEqual(f.state().flows[7].grant, grant);
  assert.equal((await restarted.dispatch({ type: 'LOGIN_STEP', step: 'password' }, okta)).password, 'test-only-password');
  assert.ok((await begin(f, await f.toDuo(), credential)).response);
  assert.equal(f.prompt(), undefined);
});

test('canceling the shortcut returns to the portal without a second prompt in either event order', async () => {
  for (const contentFirst of [false, true]) {
    const f = fixture(), from = shortcutSender();
    const prompt = await openShortcut(f, from);
    f.advance(120_001); await f.controller.cleanup();
    assert.equal((await f.controller.dispatch({ type: 'SHORTCUT_DECIDE', id: prompt.id, action: 'cancel' }, from)).target, PORTAL_URL);
    const portal = entrySender(PORTAL_URL, 'portal-document');
    f.frames.set(7, { url: portal.url, documentId: portal.documentId });
    if (contentFirst) assert.equal((await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, portal)).status, 'cancelled');
    await moveTo(f, portal.url, portal.documentId);
    assert.equal((await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, portal)).status, 'cancelled');
    assert.equal(f.prompt(), undefined);
    await f.controller.dispatch({ type: 'UI_RETRY', tabId: 7 }, ui('popup.html'));
    assert.equal((await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, portal)).status, 'asking');
  }
});

test('inline approval rejects other pages, tabs, frames, stale documents, and expired prompts', async () => {
  const f = fixture(), from = shortcutSender(), prompt = await openShortcut(f, from);
  const decide = { type: 'SHORTCUT_DECIDE', id: prompt.id, action: 'approve' };
  const second = shortcutSender(8, 'other-document'); await openShortcut(f, second);
  for (const source of [ui('start.html'), ui('settings.html'), sender(), { ...from, frameId: 1 },
    { ...from, documentId: 'stale' }, second]) await assert.rejects(f.controller.dispatch(decide, source));
  await assert.rejects(f.approve(prompt), /does not match/);
  assert.equal(f.state().flows[7].status, 'asking');
  f.advance(120_001);
  await assert.rejects(f.controller.dispatch(decide, from), /expired/);
  await f.controller.dispatch({ type: 'UI_RETRY', tabId: 7 }, ui('popup.html'));
  assert.deepEqual(f.reloaded, [7]);
  assert.equal(f.prompt()?.tabId, 8);
});

test('shortcut approval rejects changed, closed, or inactive extension documents', async () => {
  for (const change of ['same-url-reload', 'other-page', 'closed', 'inactive', 'child-frame']) {
    const f = fixture(), from = shortcutSender(), prompt = await openShortcut(f, from);
    const frame = f.frames.get(7);
    if (change === 'same-url-reload') frame.documentId = 'replacement-document';
    if (change === 'other-page') frame.url = ui('settings.html').url;
    if (change === 'closed') f.frames.delete(7);
    if (change === 'inactive') frame.documentLifecycle = 'cached';
    if (change === 'child-frame') frame.frameId = 1;
    await assert.rejects(f.controller.dispatch({ type: 'SHORTCUT_DECIDE', id: prompt.id, action: 'approve' }, from), /no longer active/);
    assert.equal(f.state().flows[7].status, 'asking');
    assert.equal(f.state().flows[7].grant, undefined);
  }
});

test('shortcut approval rechecks the extension document after loading its account', async () => {
  const f = fixture(), from = shortcutSender(), prompt = await openShortcut(f, from);
  const read = f.vault.read;
  f.vault.read = async () => {
    const data = await read();
    f.frames.get(7).documentId = 'replacement-document';
    return data;
  };
  await assert.rejects(f.controller.dispatch({ type: 'SHORTCUT_DECIDE', id: prompt.id, action: 'approve' }, from), /no longer active/);
  assert.equal(f.state().flows[7].status, 'asking');
});

test('unavailable shortcuts return to the normal portal without exposing an account', async () => {
  for (const cause of ['paused', 'missing-account', 'missing-access']) {
    const f = fixture();
    if (cause === 'paused') f.api.storage.local.data.settings.enabled = false;
    if (cause === 'missing-account') await f.vault.write({ username: '', password: '', credentials: [] });
    if (cause === 'missing-access') { f.permissions.delete('*://my.uchicago.edu/'); }
    assert.deepEqual(await openShortcut(f), { target: PORTAL_URL });
    assert.equal(f.prompt(), undefined);
  }
  const f = fixture(), prompt = await openShortcut(f);
  f.permissions.delete('*://my.uchicago.edu/');
  assert.deepEqual(await f.controller.dispatch({ type: 'SHORTCUT_DECIDE', action: 'approve', id: prompt.id }, shortcutSender()), { target: PORTAL_URL });
  assert.equal(f.state().flows[7].grant, undefined);
});

async function approveEntry(f, kind) {
  const url = kind === 'portal' ? 'https://portal.uchicago.edu/ais/' : kind === 'myuchicago' ? 'https://my.uchicago.edu/' : 'https://courses.uchicago.edu/';
  const from = entrySender(url);
  f.frames.set(7, { url, documentId: from.documentId });
  await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from);
  await f.approve(f.prompt());
  return from;
}
for (const kind of ['portal', 'courses', 'myuchicago']) {
  test(kind + ' entry requires approval, returns only a fixed target, and starts at most once', async () => {
    const f = fixture();
    const url = kind === 'portal' ? 'https://portal.uchicago.edu/ais/' : kind === 'myuchicago' ? 'https://my.uchicago.edu/' : 'https://courses.uchicago.edu/';
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

test('a slow entry redirect retains the original flow approval without renewing it', async () => {
  const { f, credential } = await withKey();
  const from = await approveEntry(f, 'courses');
  await f.controller.dispatch({ type: 'ENTRY_STEP', target: entryTarget('courses') }, from);
  const deadline = f.state().flows[7].grant.expiresAt;
  f.advance(45_000);
  await moveTo(f, OKTA + '/app/test/sso/saml');
  assert.ok((await begin(f, await f.toDuo(), credential)).response);
  assert.equal(f.state().flows[7].grant.expiresAt, deadline);
  assert.equal(f.prompt(), undefined);
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

test('a same-document Duo history update preserves the committed redirect and key approval', async () => {
  const { f, credential } = await withKey(); await f.start();
  const grant = structuredClone(f.state().flows[7].grant);
  const documentId = 'duo-history-document';
  const committed = { tabId: 7, frameId: 0, documentId, url: DUO + '/prompt/sign-in?test=1',
    transitionType: 'link', transitionQualifiers: ['server_redirect'] };
  const current = DUO + '/prompt/sign-in';
  f.frames.set(7, { documentId, url: current, documentLifecycle: 'active' });
  const from = { ...sender(DUO, 7, documentId), url: current };
  await f.controller.navigation(committed);
  assert.equal((await f.controller.dispatch({ type: 'STATUS' }, from)).trusted, true);
  assert.equal((await f.controller.dispatch({ type: 'DUO_MENU', open: true }, from)).click, true);
  await f.controller.navigation({ ...committed, url: current, transitionQualifiers: [] });
  assert.deepEqual(f.state().flows[7].grant, grant);
  await f.controller.dispatch({ type: 'DUO_STEP', step: 'key-selected' }, from);
  assert.ok((await begin(f, from, credential)).response);
  assert.equal(f.prompt(), undefined);
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
  for (const scenario of ['no-consent', 'other-tab', 'typed', 'back', 'expired', 'stale', 'changed-origin', 'iframe', 'disabled']) {
    const f = fixture(); f.permissions.add(DUO_MATCH);
    if (scenario !== 'no-consent') await f.start();
    if (scenario === 'expired') f.advance(FLOW_MS + 1);
    if (scenario === 'disabled') f.api.storage.local.data.settings.enabled = false;
    const details = { tabId: scenario === 'other-tab' ? 8 : 7, frameId: scenario === 'iframe' ? 1 : 0,
      documentId: 'candidate', url: DUO + '/auth', transitionType: scenario === 'typed' ? 'typed' : 'link',
      transitionQualifiers: scenario === 'typed' ? ['from_address_bar', 'server_redirect'] : scenario === 'back' ? ['forward_back', 'server_redirect'] : ['server_redirect'] };
    const frameUrl = scenario === 'changed-origin' ? 'https://api-another.duosecurity.com/auth' : details.url;
    f.frames.set(details.tabId, { documentId: scenario === 'stale' ? 'newer' : details.documentId, url: frameUrl });
    await f.controller.navigation(details);
    const from = sender(new URL(frameUrl).origin, details.tabId, scenario === 'stale' ? 'newer' : details.documentId);
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
  const f = fixture(); await f.start(); f.advance(FLOW_MS - 1_000);
  const from = await f.toDuo();
  await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation() }, from);
  const prompt = f.prompt();
  assert.equal(prompt.deadline, f.state().flows[7].expiresAt);
  f.advance(1_000); await assert.rejects(f.approve(prompt), /expired/);
  assert.equal((await f.vault.read()).credentials.length, 0);
});


test('Duo menu completion is recorded on display and survives worker restarts, reloads, and redirects', async () => {
  const f = fixture(); await f.start({ setup: true }); const from = await f.toDuo();
  const request = { type: 'DUO_MENU', open: true };
  const results = await Promise.all([1, 2, 3].map(() => f.controller.dispatch(request, from)));
  assert.equal(results.filter(result => result.click).length, 3);
  assert.equal(f.state().flows[7].duo.phase, 'start');
  const restarted = new Controller(f.api, f.vault, f.clock);
  assert.equal((await restarted.dispatch(request, from)).click, true);
  await restarted.dispatch({ type: 'DUO_MENU', open: false }, from);
  assert.equal((await restarted.dispatch(request, from)).click, false);
  f.permissions.add(DUO_MATCH);
  for (const [origin, transitionType] of [[DUO, 'reload'], ['https://api-next.duosecurity.com', 'link']]) {
    const documentId = `menu-${transitionType}`;
    const url = origin + '/frame/v4/auth';
    f.frames.set(7, { documentId, url });
    await restarted.navigation({ tabId: 7, frameId: 0, documentId, url, transitionType, transitionQualifiers: ['server_redirect'] });
    const next = { ...sender(origin, 7, documentId), url };
    assert.equal((await restarted.dispatch({ type: 'STATUS' }, next)).duoMenuHandled, true);
    assert.equal((await restarted.dispatch(request, next)).click, false);
    assert.equal(f.state().flows[7].status, 'active');
  }
});

test('observing a Duo menu stops only its approved flow and keeps passkey registration available', async () => {
  const f = fixture(); await f.start({ setup: true }); const from = await f.toDuo();
  assert.equal((await f.controller.dispatch({ type: 'DUO_MENU', open: false }, from)).click, false);
  assert.equal((await f.controller.dispatch({ type: 'DUO_MENU', open: true }, from)).click, false);
  const registration = await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation() }, from);
  assert.equal(registration.pending, true);
  assert.equal(f.prompt().kind, 'create');
  const otherTab = await f.toDuo(8);
  assert.equal((await f.controller.dispatch({ type: 'DUO_MENU', open: true }, otherTab)).fallback, true);
  assert.equal(f.state().flows[8], undefined);
  await assert.rejects(f.controller.dispatch({ type: 'DUO_MENU', open: true }, sender(DUO, 7, 'stale-document')));
});


test('device-management subdomains preserve the flow and accept a passkey registration request', async () => {
  for (const rpId of ['duosecurity.com', 'devicemanagement.duosecurity.com']) {
    const f = fixture(); f.permissions.add(DUO_MATCH); await f.start({ setup: true });
    const duo = await f.toDuo();
    await f.controller.dispatch({ type: 'DUO_MENU', open: false }, duo);
    const from = await follow(f, 'https://uw1.devicemanagement.duosecurity.com/frame/device-management/portal');
    const status = await f.controller.dispatch({ type: 'STATUS' }, from);
    assert.equal(status.trusted, true);
    assert.equal(status.duoMenuHandled, true);
    const request = await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation({ rp: { id: rpId, name: 'Duo' } }) }, from);
    assert.equal(request.pending, true);
    assert.equal(f.prompt().kind, 'create');
    await f.approve(f.prompt());
    const result = await f.controller.dispatch({ type: 'PK_POLL', id: request.id }, from);
    assert.ok(result.response);
    assert.equal((await f.vault.read()).credentials[0].rpId, rpId);
  }
});

test('device-management subdomains still require approval and Chrome site access', async () => {
  const url = 'https://uw1.devicemanagement.duosecurity.com/frame/device-management/portal';
  const request = { type: 'PK_BEGIN', kind: 'create', options: creation() };
  const unapproved = fixture(); unapproved.permissions.add(DUO_MATCH);
  const unapprovedPage = await follow(unapproved, url);
  assert.equal((await unapproved.controller.dispatch(request, unapprovedPage)).fallback, true);
  assert.equal(unapproved.prompt(), undefined);
  const withheld = fixture(); withheld.permissions.delete('*://*.duosecurity.com/*'); await withheld.start(); await withheld.toDuo();
  const withheldPage = await follow(withheld, url);
  await assert.rejects(withheld.controller.dispatch(request, withheldPage), /page or tab has changed/);
  assert.equal(withheld.prompt(), undefined);
});


test('registration fallback records precise compatibility reasons without request secrets', async () => {
  const cases = [
    [{ extensions: { appidExclude: 'private-app-id', prf: { eval: { first: 'private-value' } } } }, /features: prf/],
    [{ extensions: { 'private-feature-name': 'private-value' } }, /unsupported WebAuthn features\./],
    [{ attestation: 'enterprise' }, /enterprise attestation/],
    [{ authenticatorSelection: { authenticatorAttachment: 'platform' } }, /built-in authenticator/],
    [{ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }, /ES256/],
    [{ padding: 'x'.repeat(65_537) }, /supported size/]
  ];
  for (const [overrides, expected] of cases) {
    const f = fixture(); const from = await f.toDuo();
    const options = creation(overrides);
    options.user.name = 'private-account-name';
    options.excludeCredentials = [{ type: 'public-key', id: options.user.id }];
    assert.equal((await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options }, from)).fallback, true);
    const history = (await f.controller.dispatch({ type: 'UI_GET' }, ui())).history;
    const record = history[0];
    const english = translate(record.text, 'en-US', record.params);
    const chinese = translate(record.text, 'zh-CN', record.params);
    assert.match(english, expected);
    assert.notEqual(chinese, english);
    assert.doesNotMatch(chinese, /\{features\}/);
    const stored = JSON.stringify(history);
    for (const secret of [options.challenge, options.user.id, options.user.name, 'private-app-id',
      'private-value', 'private-feature-name', 'test-only-password', 'x'.repeat(100)]) {
      assert.equal(stored.includes(secret), false, secret.slice(0, 24));
    }
    assert.equal(Object.keys(f.state().jobs).length, 0);
    assert.equal(Object.keys(f.state().prompts).length, 0);
    assert.equal((await f.vault.read()).credentials.length, 0);
  }
});

test('registration fallback distinguishes expired, missing, mismatched, and paused flows without authorizing them', async () => {
  for (const [scenario, expected] of [
    ['expired', /approval expired/], ['missing', /No active sign-in approval/],
    ['mismatched', /not linked/], ['paused', /assistant is paused/]
  ]) {
    const f = fixture(); let from = await f.toDuo();
    if (scenario === 'expired') f.advance(FLOW_MS + 1);
    if (scenario === 'missing') await f.controller.exclusive(() => f.controller.invalidateTab(7));
    if (scenario === 'paused') await f.api.storage.local.set({ settings: { enabled: false } });
    if (scenario === 'mismatched') {
      from = { ...from, documentId: 'new-duo-document' };
      f.frames.set(7, { url: from.url, documentId: from.documentId });
    }
    const previous = structuredClone(f.state().flows);
    const result = await f.controller.dispatch({ type: 'PK_FALLBACK', kind: 'create', reason: 'flow', text: 'private-page-data' }, from);
    assert.equal(result.fallback, true);
    const record = f.api.storage.local.data.history[0];
    assert.match(record.text, expected);
    assert.notEqual(translate(record.text, 'zh-CN'), record.text);
    assert.deepEqual(f.state().flows, previous);
    assert.equal(JSON.stringify(f.api.storage.local.data.history).includes('private-page-data'), false);
    assert.equal((await f.vault.read()).credentials.length, 0);
  }
});

test('registration fallback reports enforce sender and reason validation', async () => {
  const f = fixture(); const from = await f.toDuo();
  const report = { type: 'PK_FALLBACK', kind: 'create', reason: 'error' };
  const before = structuredClone(f.api.storage.local.data.history);
  for (const invalid of [{ ...from, frameId: 1 }, { ...from, documentId: 'old-document' }, sender('https://example.com')]) {
    await assert.rejects(f.controller.dispatch(report, invalid));
  }
  for (const invalid of [{ ...report, reason: 'private-page-data' }, { ...report, kind: 'unknown' }]) {
    await assert.rejects(f.controller.dispatch(invalid, from), /Unsupported message/);
  }
  assert.deepEqual(f.api.storage.local.data.history, before);
  for (const reason of ['error', 'mediation']) {
    assert.equal((await f.controller.dispatch({ ...report, reason }, from)).fallback, true);
    const record = f.api.storage.local.data.history[0];
    assert.notEqual(translate(record.text, 'zh-CN'), record.text);
  }
});

test('registration diagnostics do not change requests when activity storage fails', async () => {
  for (const unsupported of [false, true]) {
    const f = fixture(); const from = await f.toDuo();
    const save = f.api.storage.local.set;
    f.api.storage.local.set = async value => {
      if (Object.hasOwn(value, 'history')) throw new Error('Activity storage unavailable');
      return save(value);
    };
    const options = creation(unsupported ? { extensions: { prf: {} } } : {});
    const result = await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options }, from);
    assert.equal(unsupported ? result.fallback : result.pending, true);
  }
});

test('an unmatched default request is deferred while routine status polls stay silent', async () => {
  const f = fixture(); await f.start({ setup: true }); const from = await f.toDuo();
  const before = structuredClone(f.api.storage.local.data.history);
  await f.controller.dispatch({ type: 'STATUS' }, from);
  await f.controller.dispatch({ type: 'STATUS' }, from);
  const result = await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'get',
    options: { rpId: 'duosecurity.com', challenge: creation().challenge } }, from);
  assert.equal(result.defer, true);
  assert.equal(f.api.storage.local.data.history.length, before.length + 1);
  assert.match(f.api.storage.local.data.history[0].text, /request intercepted/);
});

test('automatic credential matching follows the saved account and excludes unfinished registrations', async () => {
  const f = fixture({ credentials: [
    { id: 'other', userName: 'other', accountUsername: 'other', createdAt: 1 },
    { id: 'matching', userName: 'Test-Student@uchicago.edu', createdAt: 2 },
    { id: 'pending', userName: 'test-student', createdAt: 3, registrationPending: true }
  ] });
  f.api.storage.local.data.settings.selectedCredentialId = '';
  const selected = await f.controller.dispatch({ type: 'UI_GET' }, ui());
  assert.equal(selected.selectedCredentialId, 'matching');
  await f.start();
  assert.equal(f.state().flows[7].duo.mode, 'login');
  await f.controller.dispatch({ type: 'UI_SAVE_ACCOUNT', username: 'other', password: 'new-test-password' }, ui());
  assert.equal((await f.controller.settings()).selectedCredentialId, 'other');
  await f.controller.dispatch({ type: 'UI_SAVE_ACCOUNT', username: 'unmatched', password: 'new-test-password' }, ui());
  assert.equal((await f.controller.settings()).selectedCredentialId, '');
});

test('a usable key overrides an old manual preference and cannot be disabled by legacy settings', async () => {
  const { f, credential } = await withKey();
  f.api.storage.local.data.settings.automaticLogin = false;
  await f.start(); const from = await f.toDuo();
  assert.equal((await f.controller.dispatch({ type: 'STATUS' }, from)).duo.automatic, true);
  assert.equal((await f.controller.dispatch({ type: 'DUO_MENU', open: true }, from)).click, true);
  assert.ok((await begin(f, from, credential)).response);
  assert.equal(f.prompt(), undefined);
  await f.controller.dispatch({ type: 'UI_SAVE_SETTINGS', automaticLogin: false }, ui());
  assert.equal((await f.controller.settings()).automaticLogin, true);
  assert.equal((await f.controller.settings()).selectedCredentialId, credential.id);
});

test('automatic verification stays on until the last usable account key is deleted', async () => {
  const f = fixture({ credentials: [
    { id: 'first', rpId: 'duosecurity.com', userName: 'test-student' },
    { id: 'second', rpId: 'duosecurity.com', userName: 'test-student' }
  ] });
  await f.controller.dispatch({ type: 'UI_DELETE', id: 'first' }, ui());
  assert.equal((await f.controller.settings()).automaticLogin, true);
  assert.equal((await f.controller.settings()).selectedCredentialId, 'second');
  await f.controller.dispatch({ type: 'UI_DELETE', id: 'second' }, ui());
  assert.equal((await f.controller.settings()).automaticLogin, false);
  await f.start(); const from = await f.toDuo();
  assert.equal((await f.controller.dispatch({ type: 'STATUS' }, from)).duo.automatic, false);
  assert.equal(f.state().flows[7].grant, null);
});

test('remembering a Duo device requires a current approved tab and site access', async () => {
  const request = { type: 'DUO_STEP', step: 'remember-device' };
  for (const cause of ['paused', 'expired', 'other-tab', 'stale-document', 'missing-access']) {
    const f = fixture(); await f.start(); let from = await f.toDuo();
    assert.equal((await f.controller.dispatch(request, from)).click, true);
    if (cause === 'paused') await f.controller.dispatch({ type: 'UI_TOGGLE', enabled: false }, ui('popup.html'));
    if (cause === 'expired') f.advance(300_001);
    if (cause === 'other-tab') { from = { ...from, tab: { id: 8 } }; f.frames.set(8, { url: from.url, documentId: from.documentId }); }
    if (cause === 'stale-document') f.frames.get(7).documentId = 'replacement';
    if (cause === 'missing-access') f.permissions.clear();
    if (['stale-document', 'missing-access'].includes(cause)) await assert.rejects(f.controller.dispatch(request, from));
    else assert.notEqual((await f.controller.dispatch(request, from)).click, true);
  }
});

test('enrollment waits for identity, confirms a new device, and returns through redirects to the new key', async () => {
  const f = fixture(); f.permissions.add(DUO_MATCH);
  await f.controller.dispatch({ type: 'UI_SAVE_SETTINGS', automaticLogin: false }, ui());
  await f.start({ setup: true });
  const from = await f.toDuo();
  const step = (page, action, extra = {}) => f.controller.dispatch({ type: 'DUO_STEP', step: action, ...extra }, page);
  assert.equal((await f.controller.dispatch({ type: 'DUO_MENU', open: true }, from)).click, true);
  await f.controller.dispatch({ type: 'DUO_MENU', open: false }, from);
  assert.equal((await step(from, 'manage')).click, true);
  for (const action of ['manage', 'login-key', 'back']) assert.equal((await step(from, action)).click, false);
  assert.equal((await f.controller.dispatch({ type: 'DUO_MENU', open: true }, from)).click, false);
  for (const kind of ['create', 'get']) {
    assert.equal((await f.controller.dispatch({ type: 'PK_BEGIN', kind, options: creation() }, from)).fallback, true);
    assert.equal(f.prompt(), undefined);
  }
  const manager = await follow(f, 'https://uw1.devicemanagement.duosecurity.com/frame/device-management/portal');
  const old = 'a'.repeat(64), added = 'b'.repeat(64);
  await step(manager, 'inventory', { keys: [old] });
  for (const action of ['add-device', 'security-key', 'register']) {
    assert.equal((await step(manager, action)).click, true);
    assert.equal((await step(manager, action)).click, false);
  }
  await step(manager, 'registered', { keys: [old, added] });
  assert.equal(f.state().flows[7].duo.phase, 'registering');
  const job = await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'create', options: creation({ extensions: { appidExclude: DUO + '/legacy' } }) }, manager);
  await f.approve(f.prompt());
  assert.ok((await f.controller.dispatch({ type: 'PK_POLL', id: job.id }, manager)).response);
  const credential = (await f.vault.read()).credentials[0];
  assert.equal(credential.accountUsername, 'test-student');
  assert.equal(credential.registrationPending, true);
  assert.equal((await f.controller.settings()).automaticLogin, false);
  assert.equal((await f.controller.dispatch({ type: 'UI_GET' }, ui())).selectedCredentialId, '');
  f.controller = new Controller(f.api, f.vault, f.clock);
  for (const keys of [[old], [added], [old, added, 'c'.repeat(64)], ['not-a-fingerprint']]) {
    await step(manager, 'registered', { keys });
    assert.equal(f.state().flows[7].duo.phase, 'registering');
    assert.equal((await f.controller.settings()).automaticLogin, false);
  }
  await step(manager, 'registered', { keys: [old, added] });
  assert.equal((await f.vault.read()).credentials[0].registrationPending, false);
  assert.equal((await f.controller.settings()).selectedCredentialId, credential.id);
  assert.equal((await f.controller.settings()).automaticLogin, true);
  assert.equal((await step(manager, 'back')).click, true);
  assert.equal((await step(manager, 'back')).click, false);
  await follow(f, 'https://sso.school-service.example/return');
  const returning = await follow(f, DUO + '/frame/v4/auth');
  f.advance(31_000);
  assert.equal((await step(returning, 'login-menu', { open: true })).click, true);
  await step(returning, 'login-menu', { open: false });
  assert.equal((await step(returning, 'login-menu', { open: true })).click, false);
  assert.equal((await step(returning, 'login-key')).click, true);
  await step(returning, 'key-selected');
  assert.equal((await step(returning, 'login-key')).click, false);
  const assertionJob = await begin(f, returning, credential, { extensions: { appid: DUO + '/legacy' } });
  assert.ok(assertionJob.response);
  assert.equal(f.prompt(), undefined);
  const result = await f.controller.dispatch({ type: 'PK_POLL', id: assertionJob.id }, returning);
  assert.equal(result.response.id, credential.id);
  assert.deepEqual(result.response.clientExtensionResults, { appid: false });
  assert.equal((await f.vault.read()).credentials.length, 1);
});


test('manual is the default and automatic verification cannot be enabled without an eligible key', async () => {
  const f = fixture(); delete f.api.storage.local.data.settings.automaticLogin;
  assert.equal((await f.controller.settings()).automaticLogin, false);
  await assert.rejects(f.controller.dispatch({ type: 'UI_SAVE_SETTINGS', automaticLogin: true }, ui()), /Add a passkey/);
  await f.start(); const from = await f.toDuo();
  assert.equal(f.state().flows[7].duo.phase, 'manual');
  assert.equal((await f.controller.dispatch({ type: 'DUO_MENU', open: true }, from)).click, false);
});

test('confirmed setup clears only scoped cookies and opens one preapproved student sign-in', async () => {
  const f = fixture();
  f.setCookies([
    { name: 'okta', domain: 'uchicago.okta.com', path: '/', secure: false, storeId: '0' },
    { name: 'duo', domain: '.api-test123.duosecurity.com', path: '/prompt', secure: true, storeId: '0', partitionKey: { topLevelSite: 'https://uchicago.okta.com', hasCrossSiteAncestor: true } },
    { name: 'ais', domain: '.ais92hbprd.ais.uchicago.edu', path: '/', secure: true, storeId: '0' },
    { name: 'shared', domain: '.uchicago.edu', path: '/', secure: true, storeId: '0' },
    { name: 'other', domain: '.example.com', path: '/', secure: true, storeId: '0' }
  ]);
  await f.controller.dispatch({ type: 'UI_SETUP_PASSKEY' }, ui());
  const setup = f.prompt();
  assert.equal(setup.kind, 'setup');
  assert.equal(f.frames.has(8), false);
  await f.controller.dispatch({ type: 'PROMPT_DECIDE', id: setup.id, action: 'approve' }, ui(`confirm.html?id=${setup.id}`));
  const tabId = 8, frame = f.frames.get(tabId);
  assert.equal(frame.url, 'https://portal.uchicago.edu/ais/');
  assert.deepEqual(f.cookies().map(c => c.name), ['shared', 'other']);
  assert.equal(f.cookieOps.filter(item => item.type === 'remove').length, 3);
  const from = { ...sender('https://portal.uchicago.edu', tabId, frame.documentId), url: frame.url };
  assert.equal((await f.controller.dispatch({ type: 'ENTRY_DETECTED' }, from)).status, 'active');
  assert.equal(f.state().flows[tabId].status, 'active');
  assert.equal(f.state().flows[tabId].duo.setup, true);
  assert.equal(f.state().flows[tabId].duo.mode, 'enroll');
  assert.equal(Object.values(f.state().prompts).length, 0);
  assert.equal((await f.controller.settings()).automaticLogin, false);
});

test('setup retries when a school tab rewrites a scoped cookie during cleanup', async () => {
  const f = fixture();
  f.setCookies([{ name: 'okta', domain: 'uchicago.okta.com', path: '/', secure: true, storeId: '0' }]);
  const remove = f.api.cookies.remove.bind(f.api.cookies); let attempts = 0;
  f.api.cookies.remove = async details => { if (++attempts === 1) return; return remove(details); };
  await f.controller.dispatch({ type: 'UI_SETUP_PASSKEY' }, ui());
  const setup = f.prompt();
  await f.controller.dispatch({ type: 'PROMPT_DECIDE', id: setup.id, action: 'approve' }, ui(`confirm.html?id=${setup.id}`));
  assert.equal(attempts, 2);
  assert.deepEqual(f.cookies(), []);
  assert.equal(f.frames.get(8).url, 'https://portal.uchicago.edu/ais/');
});

test('setup does not navigate when scoped cookie cleanup cannot finish', async () => {
  const f = fixture();
  f.setCookies([{ name: 'okta', domain: 'uchicago.okta.com', path: '/', secure: true, storeId: '0' }]);
  f.api.cookies.remove = async details => { f.cookieOps.push({ type: 'remove', details }); };
  await f.controller.dispatch({ type: 'UI_SETUP_PASSKEY' }, ui());
  const setup = f.prompt();
  await assert.rejects(f.controller.dispatch({ type: 'PROMPT_DECIDE', id: setup.id, action: 'approve' },
    ui(`confirm.html?id=${setup.id}`)), /Unable to prepare a fresh sign-in/);
  assert.equal(f.frames.has(8), false);
  assert.deepEqual(f.cookies().map(c => c.name), ['okta']);
});

test('canceling setup keeps cookies and does not open a sign-in tab', async () => {
  const f = fixture();
  f.setCookies([{ name: 'okta', domain: 'uchicago.okta.com', path: '/', secure: true, storeId: '0' }]);
  await f.controller.dispatch({ type: 'UI_SETUP_PASSKEY' }, ui());
  const setup = f.prompt();
  await f.controller.dispatch({ type: 'PROMPT_DECIDE', id: setup.id, action: 'cancel' }, ui(`confirm.html?id=${setup.id}`));
  assert.deepEqual(f.cookies().map(c => c.name), ['okta']);
  assert.equal(f.frames.has(8), false);
});

test('legacy dynamic adapters are removed while static hooks preserve early isolated-before-main ordering', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  const scripts = manifest.content_scripts.filter(s => s.matches.includes(DUO_MATCH));
  assert.deepEqual(scripts.map(s => [s.world, s.run_at, s.all_frames]), [
    ['ISOLATED', 'document_start', false], ['MAIN', 'document_start', false]
  ]);
  const f = fixture();
  for (const id of ['duo-main', 'duo-isolated', 'unrelated']) f.scripts.set(id, { id });
  await f.controller.syncScripts();
  assert.deepEqual([...f.scripts.keys()], ['unrelated']);
});

test('only a current delivered assertion followed by explicit rejection marks a key unavailable', async () => {
  const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
  const result = await begin(f, from, credential);
  const rejection = { type: 'PK_REJECTED', id: result.id, reason: 'not-registered' };
  assert.equal((await f.controller.dispatch(rejection, from)).recorded, false);
  assert.equal((await f.controller.dispatch({ type: 'PK_DELIVERED', id: result.id }, from)).recorded, true);
  assert.equal((await f.controller.dispatch({ ...rejection, reason: 'timeout' }, from)).recorded, false);
  assert.equal((await f.vault.read()).credentials[0].rejectedAt, undefined);
  assert.equal((await f.controller.dispatch(rejection, from)).recorded, true);
  assert.ok((await f.vault.read()).credentials[0].rejectedAt);
  assert.equal((await f.controller.settings()).automaticLogin, false);
  assert.equal((await f.controller.dispatch({ type: 'STATUS' }, from)).duo.automatic, false);
  assert.equal((await f.controller.dispatch(rejection, from)).recorded, false);
  const prompt = f.prompt(), expires = f.state().flows[7].expiresAt;
  assert.equal(prompt.kind, 'repair');
  await f.controller.dispatch({ type: 'PROMPT_DECIDE', id: prompt.id, action: 'enroll' }, ui('confirm.html?id=' + prompt.id));
  assert.equal(f.state().flows[7].duo.mode, 'enroll');
  assert.equal(f.state().flows[7].grant, null);
  assert.equal(f.state().flows[7].expiresAt, expires);
  assert.equal((await f.vault.read()).credentials[0].id, credential.id);
});

test('canceling invalid-key replacement releases Duo and the next sign-in enters device management directly', async () => {
  const { f, credential } = await withKey(); await f.start(); let from = await f.toDuo();
  const result = await begin(f, from, credential);
  await f.controller.dispatch({ type: 'PK_DELIVERED', id: result.id }, from);
  await f.controller.dispatch({ type: 'PK_REJECTED', id: result.id, reason: 'not-registered' }, from);
  let prompt = f.prompt(); assert.equal(prompt.kind, 'repair');
  await f.controller.dispatch({ type: 'PROMPT_DECIDE', id: prompt.id, action: 'cancel' }, ui('confirm.html?id=' + prompt.id));
  const status = await f.controller.dispatch({ type: 'STATUS' }, from);
  assert.equal(status.duo.phase, 'manual');
  assert.equal((await f.controller.dispatch({ type: 'PK_BEGIN', kind: 'get', options: assertion(credential) }, from)).fallback, true);
  assert.equal((await f.vault.read()).credentials.length, 1);

  await f.controller.exclusive(() => f.controller.invalidateTab(7));
  f.frames.set(7, { documentId: 'okta-document', url: `${OKTA}/login` });
  await f.start();
  assert.equal(f.state().flows[7].duo.mode, 'enroll');
  assert.equal(f.state().flows[7].duo.phase, 'start');
  assert.equal(f.state().flows[7].duo.setup, true);
  from = await f.toDuo();
  await f.controller.dispatch({ type: 'DUO_MENU', open: false }, from);
  assert.equal((await f.controller.dispatch({ type: 'DUO_STEP', step: 'manage' }, from)).click, true);
  assert.equal(f.prompt(), undefined);
  assert.equal((await f.vault.read()).credentials.length, 1);
});

test('a newer request, changed document, or expired result cannot invalidate an older key', async () => {
  for (const reason of ['new-request', 'document', 'expired']) {
    const { f, credential } = await withKey(); await f.start(); let from = await f.toDuo();
    const result = await begin(f, from, credential, { timeout: 30_000 });
    await f.controller.dispatch({ type: 'PK_DELIVERED', id: result.id }, from);
    if (reason === 'new-request') await begin(f, from, credential);
    if (reason === 'document') from = await follow(f, DUO + '/frame/v4/auth');
    if (reason === 'expired') f.advance(30_000);
    assert.equal((await f.controller.dispatch({ type: 'PK_REJECTED', id: result.id, reason: 'not-registered' }, from)).recorded, false);
    assert.equal((await f.vault.read()).credentials[0].rejectedAt, undefined);
  }
});

test('unmatched and unsupported selected-key requests wait for a choice and never mark local keys invalid', async () => {
  for (const extra of [{ allowCredentials: [{ type: 'public-key', id: creation().challenge }] }, { extensions: { prf: {} } }]) {
    const { f, credential } = await withKey(); await f.start(); const from = await f.toDuo();
    await f.controller.dispatch({ type: 'DUO_STEP', step: 'key-selected' }, from);
    const result = await begin(f, from, credential, extra);
    assert.equal(result.pending, true); assert.equal(f.prompt().fallbackOnly, true);
    assert.equal((await f.vault.read()).credentials[0].rejectedAt, undefined);
    const second = await begin(f, from, credential, { challenge: 'x'.repeat(70_000) });
    assert.equal(second.error.name, 'NotAllowedError');
    assert.equal(Object.keys(f.state().jobs).length, 1);
  }
});


test('expiry, retry, account changes, and replacement setup never delete stored keys', async () => {
  const records = [
    { id: 'old-key', userName: 'test-student', rpId: 'duosecurity.com', rejectedAt: 1 },
    { id: 'pending-key', userName: 'test-student', rpId: 'duosecurity.com', registrationPending: true }
  ];
  const f = fixture({ credentials: records });
  await f.start({ setup: true });
  f.advance(600_000); await f.controller.cleanup();
  await f.controller.dispatch({ type: 'UI_RETRY', tabId: 7 }, ui('popup.html'));
  await f.controller.dispatch({ type: 'UI_SAVE_ACCOUNT', username: 'another-account', password: 'test-only-password' }, ui());
  await f.controller.dispatch({ type: 'UI_SETUP_PASSKEY' }, ui());
  assert.deepEqual((await f.vault.read()).credentials, records);
});


test('setup with a working key opens device management first, then handles its identity request', async () => {
  const { f, credential } = await withKey(); await f.start({ setup: true }); const from = await f.toDuo();
  assert.equal((await begin(f, from, credential)).defer, true);
  assert.equal((await f.vault.read()).credentials[0].signCount, 0);
  await f.controller.dispatch({ type: 'DUO_MENU', open: false }, from);
  assert.equal((await f.controller.dispatch({ type: 'DUO_STEP', step: 'manage' }, from)).click, true);
  assert.equal((await begin(f, from, credential)).response.id, credential.id);
  assert.equal(f.state().flows[7].duo.phase, 'identity');
});
