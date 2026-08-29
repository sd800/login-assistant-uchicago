import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_TEXT, FLOW_MS, duoOrigin, allowedRp, validSender, canUseGrant, validateAccount, entryForUrl, entryTarget, isEntryTransit, isOktaLoginUrl } from '../extension/core/policy.js';
import { DUO, sender } from './helpers.mjs';

test('sign-in confirmation title', () => assert.equal(CONFIRM_TEXT, 'Sign in to UChicago with saved account?'));
test('Duo URLs accept valid HTTPS subdomains at any depth', () => {
  for (const origin of [DUO, 'https://a.b.duosecurity.com', 'https://uw1.devicemanagement.duosecurity.com']) {
    assert.equal(duoOrigin(`${origin}/frame/device-management/portal?secret=redacted`), origin);
  }
  for (const url of ['http://api-test.duosecurity.com', 'https://duosecurity.com', 'https://api.duosecurity.com.evil.com',
    'https://evil.com/?duosecurity.com', 'https://notduosecurity.com', 'https://uw1.devicemanagement.duosecurity.com.evil.com',
    'https://a..duosecurity.com', 'https://-a.duosecurity.com', 'https://a-.duosecurity.com',
    'https://user:pass@api.duosecurity.com', 'https://api.duosecurity.com:444']) assert.throws(() => duoOrigin(url), url);
});
test('RP validation permits only the approved host and its Duo parent domains', () => {
  assert.equal(allowedRp('duosecurity.com', DUO, DUO), true);
  assert.equal(allowedRp('api-test123.duosecurity.com', DUO, DUO), true);
  for (const rp of ['com', 'security.com', 'duosecurity.com.evil.com', 'other.duosecurity.com']) assert.equal(allowedRp(rp, DUO, DUO), false);
  assert.equal(allowedRp('duosecurity.com', 'https://other.duosecurity.com', DUO), false);
  const manager = 'https://uw1.devicemanagement.duosecurity.com';
  for (const rp of ['duosecurity.com', 'devicemanagement.duosecurity.com', 'uw1.devicemanagement.duosecurity.com']) {
    assert.equal(allowedRp(rp, manager, manager), true, rp);
  }
  for (const rp of ['com', 'other.duosecurity.com', 'uw2.devicemanagement.duosecurity.com',
    'child.uw1.devicemanagement.duosecurity.com', 'devicemanagement.duosecurity.com.evil.com', '', null]) {
    assert.equal(allowedRp(rp, manager, manager), false, String(rp));
  }
});
test('no subframes, missing tab, HTTP or other origins', () => {
  const good = sender(DUO);
  assert.equal(validSender(good, DUO), true);
  for (const bad of [{ ...good, frameId: 1 }, { ...good, tab: null }, { ...good, origin: 'https://evil.com' }, { ...good, url: 'http://api-test123.duosecurity.com' }]) assert.equal(validSender(bad, DUO), false);
});
test('flow grants bind account, keys, RP, tab, deadline, and verified PIN', () => {
  const grant = { tabId: 7, flowId: 'flow', credentials: [{ id: 'key', rpId: 'duosecurity.com' }],
    username: 'student', issuedAt: 100, expiresAt: 100 + FLOW_MS, uv: false };
  const request = { tabId: 7, flowId: 'flow', credentialId: 'key', rpId: 'duosecurity.com', username: 'student', now: 90_100, requireUV: false };
  assert.equal(canUseGrant(grant, request), true);
  for (const changes of [{ tabId: 8 }, { flowId: 'other' }, { credentialId: 'other' }, { rpId: 'other' },
    { username: 'other' }, { now: 99 }, { now: 100 + FLOW_MS }, { requireUV: true }]) {
    assert.equal(canUseGrant(grant, { ...request, ...changes }), false);
  }
  assert.equal(canUseGrant({ ...grant, uv: true }, { ...request, requireUV: true }), true);
  assert.equal(canUseGrant({ ...grant, expiresAt: 101 + FLOW_MS }, request), false);
  assert.equal(canUseGrant(null, request), false);
});
test('account validation preserves password exactly', () => {
  assert.deepEqual(validateAccount(' student ', ' p a s s '), { username: 'student', password: ' p a s s ' });
  assert.throws(() => validateAccount('', 'pass'));
  assert.throws(() => validateAccount('user\nnum', 'pass'));
  assert.throws(() => validateAccount('user', ''));
});

test('only the intended public entry pages can prompt', () => {
  for (const path of ['/ais', '/ais/', '/ais/?source=bookmark#tab1']) assert.equal(entryForUrl('https://portal.uchicago.edu' + path), 'portal');
  assert.equal(entryForUrl('https://courses.uchicago.edu/?source=bookmark'), 'courses');
  assert.equal(entryForUrl('https://my.uchicago.edu/'), 'myuchicago');
  for (const url of ['http://my.uchicago.edu/', 'https://my.uchicago.edu/help', 'https://my.uchicago.edu.evil.com/']) assert.equal(entryForUrl(url), null);
  assert.equal(entryTarget('myuchicago'), entryTarget('portal'));
  for (const value of ['http://courses.uchicago.edu/', 'https://courses.uchicago.edu/help', 'https://portal.uchicago.edu/ais/help', 'https://portal.uchicago.edu/ais-other', 'https://courses.uchicago.edu.evil.com/', 'https://user:pass@courses.uchicago.edu/', 'https://courses.uchicago.edu:444/']) assert.equal(entryForUrl(value), null, value);
  assert.equal(isEntryTransit('courses', entryTarget('courses')), true);
  assert.equal(isEntryTransit('portal', entryTarget('portal')), true);
  assert.equal(isEntryTransit('courses', entryTarget('portal')), false);
  assert.equal(isEntryTransit('courses', 'https://canvas.uchicago.edu/courses'), false);
});

test('Okta application SAML URLs accept opaque query parameters without broadening origin or recovery paths', () => {
  assert.equal(isOktaLoginUrl('https://uchicago.okta.com/app/uchicago_canvas_1/test/sso/saml?SAMLRequest=synthetic&RelayState=synthetic'), true);
  for (const value of ['https://uchicago.okta.com/', 'https://uchicago.okta.com/app/UserHome', 'https://uchicago.okta.com/app/settings', 'https://uchicago.okta.com/login/reset_password', 'https://uchicago.okta.com.evil.com/app/test', 'https://uchicago.okta.com/app/%ZZ']) assert.equal(isOktaLoginUrl(value), false, value);
});
