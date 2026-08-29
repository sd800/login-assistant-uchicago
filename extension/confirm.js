import { $, api, status, bindText, localize, t, initializeLocale } from './ui.js';
import { CONFIRM_TEXT } from './core/policy.js';
import { PORTAL_URL } from './core/shortcut.js';
const inline = new URL(location.href).pathname === '/start.html';
let id = new URL(location.href).searchParams.get('id');
let request;
let busy = false;
function approvalUnavailable() {
  return !request || request.fallbackOnly || request.deadline <= Date.now() || (request.requireUV && !request.hasPin);
}
async function decide(action) {
  if (busy) return;
  if (action === 'approve' && (approvalUnavailable() || $('approve').disabled || !$('confirm-form').reportValidity())) return;
  busy = true;
  $('approve').disabled = true;
  $('enroll').disabled = true;
  try {
    const result = await api({ type: inline ? 'SHORTCUT_DECIDE' : 'PROMPT_DECIDE', id, action, pin: $('pin').value, credentialId: request?.credentialId || $('choices').value });
    $('pin').value = '';
    if (inline && result.target) location.replace(result.target); else window.close();
  } catch (error) {
    $('pin').value = '';
    if (inline && action === 'cancel') { location.replace(PORTAL_URL); return; }
    status($('status'), error.message, true);
    $('approve').disabled = approvalUnavailable();
  } finally { busy = false; $('enroll').disabled = false; }
}
function cancelRequest() {
  if (busy) return;
  if (!inline && (!request || request.deadline <= Date.now())) { window.close(); return; }
  return decide('cancel');
}
$('confirm-form').addEventListener('submit', event => { event.preventDefault(); if (event.isTrusted) return decide('approve'); });
$('cancel').addEventListener('click', event => { if (event.isTrusted) return cancelRequest(); });
$('enroll').addEventListener('click', event => { if (event.isTrusted && request?.allowEnrollment) return decide('enroll'); });
$('fallback').addEventListener('click', event => { if (event.isTrusted) return decide('fallback'); });
document.addEventListener('keydown', event => {
  // Leave IME composition and browser/assistive-technology shortcuts untouched.
  if (!event.isTrusted || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!event.repeat) return cancelRequest();
    return;
  }
  if (event.key !== 'Enter' && event.key !== ' ') return;
  // Other controls keep native activation, selection, and text-entry behavior.
  const control = event.target?.closest?.('input, textarea, select, button, a, summary, [contenteditable], [role="button"], [role="combobox"], [role="switch"]');
  if (event.target?.isContentEditable || (control && control !== $('approve'))) return;
  event.preventDefault();
  if (!event.repeat) return decide('approve');
});
try { await initializeLocale(); } catch { status($('status'), 'Unable to load the saved language. Reload this page to try again.', true); }
try {
  request = await api({ type: inline ? 'SHORTCUT_OPEN' : 'PROMPT_GET', id });
  if (inline && request.target) { location.replace(request.target); } else {
  id = request.id || id;
  bindText($('title'), request.kind === 'setup' ? "Add a passkey for one-click sign-in?" : request.kind === 'repair' ? "Add a replacement passkey?" : request.fallbackOnly ? "Passkey unavailable" : request.kind === 'login' ? CONFIRM_TEXT : request.kind === 'create' ? "Add a passkey" : request.credentialId && request.requireUV ? "Verify your identity" : "Use a saved Duo passkey?");
  if (request.kind === 'login') {
    $('sign-in-explanation').hidden = false;
    bindText($('sign-in-explanation'), "Confirm to log in to uchicago.edu.");
  }
  if (request.kind === 'create') bindText($('approve'), 'Continue');
  else bindText($('approve'), 'Confirm');
  $('details').hidden = false;
  localize($('username'), () => request.username || request.choices?.[0]?.userName || t("UChicago account"));
  if (request.rpId && request.kind !== 'login') { $('rp-label').hidden = false; $('rp').hidden = false; $('rp').textContent = request.rpId; }
  if (request.choices?.length && !request.credentialId) {
    $('choices-field').hidden = false;
    for (const credential of request.choices) {
      const option = document.createElement('option');
      option.value = credential.id;
      option.textContent = `${credential.userName} · ${credential.id.slice(0, 8)}…`;
      $('choices').append(option);
    }
  }
  $('approve').hidden = request.fallbackOnly === true;
  $('enroll').hidden = !request.allowEnrollment || request.kind === 'repair';
  $('pin-field').hidden = ['setup', 'repair'].includes(request.kind) || !request.hasPin || request.fallbackOnly === true || (request.kind === 'login' && request.automaticDuo === false);
  if (request.requireUV) { bindText($('pin-label'), "Verification PIN"); $('pin').required = true; }
  if (request.notice) {
    $('notice').hidden = false;
    bindText($('notice'), request.notice);
  } else if (request.requireUV && !request.hasPin) {
    $('notice').hidden = false;
    bindText($('notice'), "Duo requires identity verification. Use another passkey provider, or set a verification PIN in settings and try again.");
  } else if (request.kind === 'setup') {
    $('notice').hidden = false;
    bindText($('notice'), "The assistant will sign in with your saved account and help you add a Duo passkey. If Duo asks you to verify your identity, complete that step to continue.");
  } else if (request.kind === 'create') {
    $('notice').hidden = false;
    bindText($('notice'), "The passkey will be saved here. Adding a passkey is necessary for the one-click account sign-in feature.");
  }
  bindText($('consent-help'), request.kind === 'login' ? "Your confirmation covers automatic passkey verification for this sign-in in this tab." : request.kind === 'create' ? "Confirming allows this page to complete this passkey request." : "Confirming allows this page to complete this passkey request once.");
  if (request.kind === 'login' && request.automaticDuo === false) bindText($('consent-help'), "The assistant will fill your saved account on Okta. Complete Duo verification yourself if asked.");
  if (request.fallbackOnly) {
    bindText($('consent-help'), "Choose how to continue. Adding a new passkey keeps your existing local keys.");
    bindText($('keyboard-help'), "Esc to cancel. Use Tab to choose an action.");
  }
  if (['setup', 'repair'].includes(request.kind)) bindText($('consent-help'), "Confirm to start passkey setup. Existing local passkeys will be kept.");
  if (request.kind === 'create') bindText($('keyboard-help'), "Enter / Space to continue; Esc to cancel. Focused controls keep their usual keys.");
  $('fallback').hidden = ['login', 'repair', 'setup'].includes(request.kind);
  $('approve').disabled = approvalUnavailable();
  setInterval(() => { if (Date.now() >= request.deadline) { $('approve').disabled = true; status($('status'), inline ? "This request has expired. Reload this page to try again." : "This request has expired. Close this window and try again on the sign-in page.", true); } }, 1000);
  }
} catch (error) {
  const expired = error.message === "This confirmation has expired. Return to the sign-in page and try again.";
  bindText($('title'), expired ? "Request expired" : "Unable to load confirmation");
  status($('status'), error.message, true);
}
