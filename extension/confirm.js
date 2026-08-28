import { $, api, status, bindText, localize, t, initializeLocale } from './ui.js';
import { CONFIRM_TEXT } from './core/policy.js';
const id = new URL(location.href).searchParams.get('id');
let request;
let busy = false;
function approvalUnavailable() {
  return !request || request.deadline <= Date.now() || (request.requireUV && !request.hasPin);
}
async function decide(action) {
  if (busy) return;
  if (action === 'approve' && (approvalUnavailable() || $('approve').disabled || !$('confirm-form').reportValidity())) return;
  busy = true;
  $('approve').disabled = true;
  try {
    await api({ type: 'PROMPT_DECIDE', id, action, pin: $('pin').value, credentialId: $('choices').value });
    $('pin').value = '';
    window.close();
  } catch (error) {
    $('pin').value = '';
    status($('status'), error.message, true);
    $('approve').disabled = approvalUnavailable();
  } finally { busy = false; }
}
function cancelRequest() {
  if (busy) return;
  if (!request || request.deadline <= Date.now()) { window.close(); return; }
  return decide('cancel');
}
$('confirm-form').addEventListener('submit', event => { event.preventDefault(); if (event.isTrusted) return decide('approve'); });
$('cancel').addEventListener('click', event => { if (event.isTrusted) return cancelRequest(); });
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
  request = await api({ type: 'PROMPT_GET', id });
  bindText($('title'), request.kind === 'login' ? CONFIRM_TEXT : request.kind === 'create' ? "Save a new Duo passkey?" : "Use a saved Duo passkey?");
  bindText($('approve'), 'Confirm');
  $('details').hidden = false;
  localize($('username'), () => request.username || request.choices?.[0]?.userName || t("UChicago account"));
  if (request.rpId && request.kind !== 'login') { $('rp-label').hidden = false; $('rp').hidden = false; $('rp').textContent = request.rpId; }
  if (request.choices?.length) {
    $('choices-field').hidden = false;
    for (const credential of request.choices) {
      const option = document.createElement('option');
      option.value = credential.id;
      option.textContent = `${credential.userName} · ${credential.id.slice(0, 8)}…`;
      $('choices').append(option);
    }
  }
  $('pin-field').hidden = !request.hasPin;
  if (request.requireUV) { bindText($('pin-label'), "Verification PIN"); $('pin').required = true; }
  if (request.requireUV && !request.hasPin) {
    $('notice').hidden = false;
    bindText($('notice'), "Duo requires identity verification. Use another passkey provider, or set a verification PIN in settings and try again.");
  } else if (request.kind === 'create') {
    $('notice').hidden = false;
    bindText($('notice'), "The passkey will be saved here. Wait for Duo to confirm registration, and keep another verification method.");
  }
  bindText($('consent-help'), request.kind === 'login' ? "Your confirmation applies to this sign-in. A matching passkey can use it once within 30 seconds. Duo may ask for further verification." : "Confirming allows this page to complete this passkey request once.");
  $('fallback').hidden = request.kind === 'login';
  $('approve').disabled = approvalUnavailable();
  setInterval(() => { if (Date.now() >= request.deadline) { $('approve').disabled = true; status($('status'), "This request has expired. Close this window and try again on the sign-in page.", true); } }, 1000);
} catch (error) { bindText($('title'), "Request expired"); status($('status'), error.message, true); }
