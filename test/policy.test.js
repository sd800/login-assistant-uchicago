import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_TEXT, duoOrigin, allowedRp, validSender, canUseGrant, validateAccount, entryForUrl, entryTarget, isEntryTransit, isOktaLoginUrl } from '../extension/core/policy.js';
import { DUO, sender } from './helpers.mjs';

test('sign-in confirmation title', () => assert.equal(CONFIRM_TEXT, 'Sign in to UChicago with saved account?'));
test('Duo URLs normalize only to an exact HTTPS tenant', () => {
  assert.equal(duoOrigin(`${DUO}/frame/v4/auth?secret=redacted`), DUO);
  for (const url of ['http://api-test.duosecurity.com', 'https://duosecurity.com', 'https://api.duosecurity.com.evil.com', 'https://evil.com/?duosecurity.com', 'https://a.b.duosecurity.com', 'https://user:pass@api.duosecurity.com', 'https://api.duosecurity.com:444']) assert.throws(() => duoOrigin(url));
});
test('RP validation requires approved origin and exact parent domain', () => {
  assert.equal(allowedRp('duosecurity.com', DUO, DUO), true);
  assert.equal(allowedRp('api-test123.duosecurity.com', DUO, DUO), true);
  for (const rp of ['com', 'security.com', 'duosecurity.com.evil.com', 'other.duosecurity.com']) assert.equal(allowedRp(rp, DUO, DUO), false);
  assert.equal(allowedRp('duosecurity.com', 'https://other.duosecurity.com', DUO), false);
});
test('no subframes, missing tab, HTTP or other origins', () => {
  const good = sender(DUO);
  assert.equal(validSender(good, DUO), true);
  for (const bad of [{ ...good, frameId: 1 }, { ...good, tab: null }, { ...good, origin: 'https://evil.com' }, { ...good, url: 'http://api-test123.duosecurity.com' }]) assert.equal(validSender(bad, DUO), false);
});
test('presence grants are single-account, single-tab, bounded and require real UV when requested', () => {
  const grant = { tabId: 7, flowId: 'flow', credentialId: 'key', rpId: 'duosecurity.com', issuedAt: 100, uv: false };
  const request = { tabId: 7, flowId: 'flow', credentialId: 'key', rpId: 'duosecurity.com', now: 150, requireUV: false };
  assert.equal(canUseGrant(grant, request), true);
  for (const changes of [{ tabId: 8 }, { flowId: 'other' }, { credentialId: 'other' }, { rpId: 'other' }, { now: 99 }, { now: 30_100 }, { requireUV: true }]) assert.equal(canUseGrant(grant, { ...request, ...changes }), false);
  assert.equal(canUseGrant({ ...grant, uv: true }, { ...request, requireUV: true }), true);
  assert.equal(canUseGrant(null, request), false);
});
test('account validation preserves password exactly', () => {
  assert.deepEqual(validateAccount(' student ', ' p a s s '), { username: 'student', password: ' p a s s ' });
  assert.throws(() => validateAccount('', 'pass'));
  assert.throws(() => validateAccount('user\nnum', 'pass'));
  assert.throws(() => validateAccount('user', ''));
});

test('only the two intended public entry pages can prompt', () => {
  for (const path of ['/ais', '/ais/', '/ais/?source=bookmark#tab1']) assert.equal(entryForUrl('https://portal.uchicago.edu' + path), 'portal');
  assert.equal(entryForUrl('https://courses.uchicago.edu/?source=bookmark'), 'courses');
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
