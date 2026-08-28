import '../content/routes.js';
export const { OKTA_ORIGIN, PORTAL_ORIGIN, COURSES_ORIGIN, CANVAS_LOGIN_URL, STUDENT_LOGIN_URL, isOktaLoginUrl, entryForUrl, entryTarget, isEntryTransit } = globalThis.UChiLoginRoutes;
export const CONFIRM_TEXT = "Sign in to UChicago with saved account?";
export const PRESENCE_MS = 30_000;
export const FLOW_MS = 5 * 60_000;
export const PROMPT_MS = 2 * 60_000;
export const HANDOFF_MS = 60_000;
export const DUO_MATCH = 'https://*.duosecurity.com/*';
export const HISTORY_MS = 24 * 60 * 60_000;

export function continuesSignInFlow(flow, details, now) {
  if (!liveFlow(flow, now)) return false;
  const qualifiers = details.transitionQualifiers || [];
  if (qualifiers.some(value => ['from_address_bar', 'forward_back'].includes(value)) ||
      ['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated'].includes(details.transitionType)) return false;
  let fromDuo = false;
  try { fromDuo = duoOrigin(flow.authOrigin) === flow.authOrigin; } catch { /* Not a Duo document. */ }
  const fromAuth = flow.stage === 'auth' && (flow.authOrigin === OKTA_ORIGIN || fromDuo);
  const fromEntry = flow.stage === 'handoff' && flow.entryStarted && flow.handoffUntil > now;
  const inTransit = flow.stage === 'transit' && flow.transitUntil > now;
  if (!fromAuth && !fromEntry && !inTransit) return false;
  return qualifiers.some(value => ['server_redirect', 'client_redirect'].includes(value)) ||
    ((fromAuth || inTransit) && details.transitionType === 'form_submit') ||
    (fromAuth && details.transitionType === 'link' && (fromDuo || flow.duoHandoffUntil > now));
}

export function parseHttps(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid URL."); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error("Use an HTTPS URL without a custom port or embedded credentials.");
  }
  return url;
}

export function duoOrigin(value) {
  const url = parseHttps(value);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.duosecurity\.com$/.test(url.hostname)) {
    throw new Error("Unsupported Duo address.");
  }
  return url.origin;
}

export function allowedRp(rpId, origin, configuredOrigin) {
  if (!configuredOrigin || origin !== configuredOrigin) return false;
  try {
    const host = new URL(duoOrigin(configuredOrigin)).hostname;
    return rpId === host || rpId === 'duosecurity.com';
  } catch { return false; }
}

export function validSender(sender, origin) {
  try {
    return Number.isInteger(sender.tab?.id) && sender.frameId === 0 &&
      parseHttps(sender.url).origin === origin &&
      (!sender.origin || sender.origin === origin);
  } catch { return false; }
}

export function liveFlow(flow, now = Date.now()) {
  return flow?.status === 'active' && flow.expiresAt > now;
}

export function canUseGrant(grant, { tabId, flowId, rpId, credentialId, requireUV, now = Date.now() }) {
  return !!grant && grant.tabId === tabId && grant.flowId === flowId &&
    grant.rpId === rpId && grant.credentialId === credentialId &&
    grant.issuedAt <= now && now - grant.issuedAt < PRESENCE_MS &&
    (!requireUV || grant.uv === true);
}

export function validateAccount(username, password) {
  if (typeof username !== 'string' || !username.trim() || username.length > 254 || /[\r\n\0]/.test(username)) {
    throw new Error("Enter your CNetID or UCMEDID.");
  }
  if (typeof password !== 'string' || !password || password.length > 1024) {
    throw new Error("Enter your password using no more than 1,024 characters.");
  }
  return { username: username.trim(), password };
}

export function publicCredential(credential) {
  return {
    id: credential.id, rpId: credential.rpId, userName: credential.userName,
    createdAt: credential.createdAt, lastUsedAt: credential.lastUsedAt,
    discoverable: credential.discoverable
  };
}
