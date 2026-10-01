import { $, api, status, date, t, bindText, localize, initializeLocale, getLocale, setLocale } from '../ui/ui.js';
import { registerDevice, verifyDevice } from '../ui/device-auth.js';
let snapshot;
let pendingPassphrase;
let deviceDisablePending = false;
const PASSWORD_WILL_BE_SAVED = "Your username and password will be securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.";
const PASSWORD_HAS_BEEN_SAVED = "Your username and password have been securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.";
const PASSKEYS_WILL_BE_SAVED = "Passkeys will be securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.";
const PASSKEY_HAS_BEEN_SAVED = "Your passkey has been securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.";
const PASSKEYS_HAVE_BEEN_SAVED = "Your passkeys have been securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.";
const PIN_WILL_BE_SAVED = "Set a verification passphrase to protect the local encryption key and authorize sign-in.";
const PIN_HAS_BEEN_SAVED = "Your verification passphrase protects the local encryption key and is used for sign-in verification.";
function passwordIsSaved() {
  return !!snapshot?.hasPassword && $('username').value.trim() === snapshot.username;
}
function showPasswordStorage() {
  localize($('password-help-text'), () => t(passwordIsSaved() ? PASSWORD_HAS_BEEN_SAVED : PASSWORD_WILL_BE_SAVED));
  $('password-help').hidden = false;
}
function showPasskeyStorage() {
  const count = snapshot?.credentials?.length || 0;
  const message = count === 0 ? PASSKEYS_WILL_BE_SAVED : count === 1 ? PASSKEY_HAS_BEEN_SAVED : PASSKEYS_HAVE_BEEN_SAVED;
  localize($('passkey-storage-help'), () => t(message));
  $('passkey-storage-help').hidden = false;
}
function showPinStorage() {
  if (!snapshot) return;
  localize($('pin-storage-help-text'), () => t(snapshot.hasPin ? PIN_HAS_BEEN_SAVED : PIN_WILL_BE_SAVED));
  $('pin-storage-help').hidden = false;
}
function clearPassphraseEntry() {
  pendingPassphrase = null;
  $('new-pin').value = '';
  $('confirm-pin').value = '';
}
function showAuthorizationStates() {
  const hasPin = !!snapshot.hasPin;
  const device = snapshot.authMode === 'device';
  $('passphrase-state').className = 'auth-state' + (hasPin ? ' ready' : '');
  $('passphrase-check').hidden = !hasPin;
  bindText($('passphrase-state-text'), hasPin ? 'Verification passphrase set' : 'Verification passphrase not set');
  $('device-state').className = 'auth-state' + (device ? ' ready' : '');
  $('device-check').hidden = !device;
  bindText($('device-state-text'), device ? 'Device verification enabled' : 'Device verification not enabled');
  $('pin-form').hidden = device || !!pendingPassphrase;
  $('pin-confirm-form').hidden = device || !pendingPassphrase;
  $('remove-pin-actions').hidden = device || !hasPin || !!pendingPassphrase;
  $('device-new-pin-field').hidden = !device || !deviceDisablePending;
  $('device-new-pin').required = device && deviceDisablePending;
  $('device-confirm-pin-field').hidden = !device || !deviceDisablePending;
  $('device-confirm-pin').required = device && deviceDisablePending;
  $('device-cancel').hidden = !device || !deviceDisablePending;
  bindText($('device-toggle'), device ? deviceDisablePending ? 'Confirm' : 'Turn off device verification' : 'Enable device verification');
}
function passwordRequirement() {
  $('password').required = !passwordIsSaved();
  showPasswordStorage();
}
function disable(ids, value) { for (const id of ids) $(id).disabled = value; }
function showDuoMode() {
  const automatic = !!snapshot?.canAutomate;
  $('duo-mode-state').className = 'duo-mode ' + (automatic ? 'automatic' : 'manual');
  $('duo-automatic-icon').hidden = !automatic;
  $('duo-manual-icon').hidden = automatic;
  bindText($('duo-mode'), automatic ? "Automatic verification" : "Manual verification");
  bindText($('duo-mode-help'), automatic
    ? "After you confirm sign-in, the assistant uses this account's saved passkey to verify with Duo automatically."
    : "Without a usable passkey for this account, complete Duo verification yourself.");
  $('passkey-setup').hidden = automatic;
  $('add-passkey').disabled = automatic || !snapshot?.enabled || !snapshot?.username || !snapshot?.hasPassword;
}
async function load({ account = false, pin = false } = {}) {
  const next = await api({ type: 'UI_GET' });
  snapshot = next;
  $('locked-panel').hidden = !snapshot.locked;
  $('settings-protected').hidden = !!snapshot.locked;
  $('unlock-passphrase-field').hidden = !['pin', 'pin-legacy'].includes(snapshot.authMode);
  bindText($('unlock-button'), snapshot.authMode === 'device' ? 'Verify with device' : 'Unlock');
  if (snapshot.locked) { clearPassphraseEntry(); deviceDisablePending = false; return; }
  if (pendingPassphrase && (pendingPassphrase.hadPin !== !!snapshot.hasPin || pendingPassphrase.mode !== snapshot.authMode)) clearPassphraseEntry();
  if (snapshot.authMode !== 'device') deviceDisablePending = false;
  // Refresh only the saved section. Other forms keep their current drafts.
  if (account) { $('username').value = snapshot.username; $('password').value = ''; }
  passwordRequirement();
  localize($('password'), () => t(snapshot.hasPassword ? "Saved — leave blank to keep" : "Enter your school password"), 'placeholder');
  if (pin) clearPassphraseEntry();
  showAuthorizationStates();
  if ($('pin-settings').open) showPinStorage();
  showDuoMode();
  $('credentials').replaceChildren();
  showPasskeyStorage();
  if (!snapshot.credentials.length) {
    const empty = document.createElement('li'); empty.className = 'help';
    bindText(empty, "No saved passkeys."); $('credentials').append(empty);
  }
  const credentials = [...snapshot.credentials].sort((a, b) =>
    Number(b.id === snapshot.selectedCredentialId) - Number(a.id === snapshot.selectedCredentialId) || b.createdAt - a.createdAt);
  for (const credential of credentials) {
    const row = document.createElement('li'); row.className = 'credential';
    const info = document.createElement('div'); info.className = 'credential-info';
    const heading = document.createElement('div'); heading.className = 'credential-title';
    const title = document.createElement('strong'); title.textContent = credential.accountUsername || credential.userName;
    const account = document.createElement('span'); account.className = 'credential-account';
    const lock = document.createElement('span'); lock.className = 'credential-lock'; lock.setAttribute('aria-hidden', 'true');
    lock.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg>';
    account.append(lock, title); heading.append(account);
    if (credential.id === snapshot.selectedCredentialId) {
      const label = document.createElement('small'); label.className = 'credential-label';
      bindText(label, "Current account"); heading.append(label);
    }
    if (credential.rejectedAt) {
      const badge = document.createElement('small'); badge.className = 'credential-state invalid';
      bindText(badge, "Invalid"); heading.append(badge);
    }
    const meta = document.createElement('small'); bindText(meta, '{site} · Added {date}', () => ({ site: credential.rpId, date: date(credential.createdAt) }));
    info.append(heading, meta);
    if (credential.rejectedAt) {
      const rejected = document.createElement('small'); bindText(rejected, "Duo no longer recognizes this passkey. It is kept here until you delete it. Add a new passkey to use automatic verification."); info.append(rejected);
    } else if (credential.registrationPending) {
      const pending = document.createElement('small'); bindText(pending, "Waiting for Duo to finish registration."); info.append(pending);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button credential-delete';
    remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg>';
    localize(remove, () => t('Delete passkey for {account}', { account: credential.accountUsername || credential.userName }), 'aria-label');
    localize(remove, () => t('Delete passkey'), 'title');
    remove.addEventListener('click', async event => {
      if (!event.isTrusted || remove.disabled || !confirm(t("Delete this saved passkey? This cannot be undone. Its registration in Duo will remain."))) return;
      remove.disabled = true;
      try { await api({ type: 'UI_DELETE', id: credential.id }); await load(); }
      catch (error) { status($('credentials-status'), error.message, true); }
      finally { remove.disabled = false; }
    });
    row.append(info, remove); $('credentials').append(row);
  }
  $('history').replaceChildren();
  for (const item of snapshot.history) {
    const li = document.createElement('li'); const time = document.createElement('time');
    localize(time, () => date(item.at));
    const text = document.createElement('span'); bindText(text, item.text, item.params || {});
    li.append(time, text); $('history').append(li);
  }
  if (!snapshot.history.length) { const li = document.createElement('li'); bindText(li, "No activity yet."); $('history').append(li); }
}
$('username').addEventListener('input', passwordRequirement);
$('pin-settings').addEventListener('toggle', () => {
  if ($('pin-settings').open) showPinStorage();
  else {
    clearPassphraseEntry();
    deviceDisablePending = false;
    $('device-new-pin').value = '';
    $('device-confirm-pin').value = '';
    if (snapshot && !snapshot.locked) showAuthorizationStates();
  }
});
$('language').addEventListener('change', async event => {
  if (!event.isTrusted) return;
  const selected = $('language').value;
  $('language').disabled = true;
  try { await setLocale(selected); status($('language-status'), 'Language saved.'); }
  catch { $('language').value = getLocale(); status($('language-status'), 'Unable to save the language. Try again.', true); }
  finally { $('language').disabled = false; }
});
$('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.isTrusted || $('save-account').disabled) return;
  disable(['save-account', 'username', 'password'], true);
  try {
    await api({ type: 'UI_SAVE_ACCOUNT', username: $('username').value, password: $('password').value });
    await load({ account: true });
    status($('account-status'), "Account saved.");
    if (!snapshot.canAutomate && snapshot.enabled) {
      try { await api({ type: 'UI_SETUP_PASSKEY' }); }
      catch (error) { status($('duo-status'), error.message, true); }
    }
  } catch (error) { status($('account-status'), error.message, true); }
  finally { disable(['save-account', 'username', 'password'], false); }
});
$('add-passkey').addEventListener('click', async event => {
  if (!event.isTrusted || $('add-passkey').disabled) return;
  $('add-passkey').disabled = true;
  try {
    await api({ type: 'UI_SETUP_PASSKEY' });
    status($('duo-status'), "Confirm the setup prompt to continue. Automatic verification turns on after the passkey is added.");
  } catch (error) { status($('duo-status'), error.message, true); }
  finally { showDuoMode(); }
});
$('pin-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!event.isTrusted || pendingPassphrase || snapshot?.authMode === 'device') return;
  const value = $('new-pin').value;
  if (value.length < 6 || value.length > 128) {
    status($('pin-status'), 'Use 6–128 characters for your verification passphrase.', true);
    return;
  }
  pendingPassphrase = { value, hadPin: !!snapshot.hasPin, mode: snapshot.authMode };
  $('new-pin').value = '';
  status($('pin-status'), '');
  showAuthorizationStates();
  $('confirm-pin').focus?.();
});
$('cancel-pin-confirm').addEventListener('click', event => {
  if (!event.isTrusted) return;
  clearPassphraseEntry();
  showAuthorizationStates();
  status($('pin-status'), '');
});
$('pin-confirm-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!event.isTrusted || !pendingPassphrase) return;
  if ($('confirm-pin').value !== pendingPassphrase.value) {
    $('confirm-pin').value = '';
    status($('pin-status'), 'The verification passphrases do not match. Try again.', true);
    $('confirm-pin').focus?.();
    return;
  }
  $('confirm-pin-save').disabled = true;
  try {
    await api({ type: 'UI_PIN', newPin: pendingPassphrase.value });
    clearPassphraseEntry();
    await load({ pin: true });
    status($('pin-status'), 'Verification passphrase saved.');
  } catch (error) {
    $('confirm-pin').value = '';
    await load().catch(() => {});
    status($('pin-status'), error.message, true);
  } finally { $('confirm-pin-save').disabled = false; }
});
$('remove-pin').addEventListener('click', async event => {
  if (!event.isTrusted || $('remove-pin').disabled || !snapshot?.hasPin || snapshot.authMode === 'device' ||
      !confirm(t('Remove your verification passphrase? Future sign-ins will no longer ask for it until you set one again. Your saved account and passkeys will remain on this device.'))) return;
  $('remove-pin').disabled = true;
  try {
    await api({ type: 'UI_PIN_REMOVE' });
    clearPassphraseEntry();
    await load({ pin: true });
    status($('pin-status'), 'Verification passphrase removed.');
  } catch (error) { status($('pin-status'), error.message, true); }
  finally { $('remove-pin').disabled = false; }
});
$('unlock-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!event.isTrusted || !snapshot?.locked) return;
  $('unlock-button').disabled = true;
  try {
    if (snapshot.authMode === 'device') {
      const secret = await verifyDevice(snapshot.deviceCredentialId, snapshot.prfSalt);
      await api({ type: 'UI_UNLOCK_DEVICE', credentialId: snapshot.deviceCredentialId, secret });
    } else await api({ type: 'UI_UNLOCK_PIN', pin: $('unlock-passphrase').value });
    $('unlock-passphrase').value = '';
    await load({ account: true, pin: true });
  } catch (error) {
    $('unlock-passphrase').value = '';
    status($('unlock-status'), error.message, true);
    await load().catch(() => {});
  } finally { $('unlock-button').disabled = false; }
});
$('device-toggle').addEventListener('click', async event => {
  if (!event.isTrusted || $('device-toggle').disabled) return;
  if (snapshot.authMode === 'device' && !deviceDisablePending) {
    deviceDisablePending = true;
    showAuthorizationStates();
    $('device-new-pin').focus?.();
    return;
  }
  $('device-toggle').disabled = true;
  try {
    if (snapshot.authMode === 'device') {
      if ($('device-new-pin').value.length < 6 || $('device-new-pin').value.length > 128) {
        throw new Error('Use 6–128 characters for your verification passphrase.');
      }
      if ($('device-new-pin').value !== $('device-confirm-pin').value) {
        throw new Error('The verification passphrases do not match. Try again.');
      }
      const secret = await verifyDevice(snapshot.deviceCredentialId, snapshot.prfSalt);
      await api({ type: 'UI_DEVICE_OFF', credentialId: snapshot.deviceCredentialId, secret, passphrase: $('device-new-pin').value });
    } else {
      const device = await registerDevice();
      await api({ type: 'UI_DEVICE_SET', ...device });
    }
    $('device-new-pin').value = '';
    $('device-confirm-pin').value = '';
    deviceDisablePending = false;
    await load({ account: true, pin: true });
    status($('device-status'), 'Authorization step updated.');
  } catch (error) {
    $('device-new-pin').value = '';
    $('device-confirm-pin').value = '';
    status($('device-status'), error.message, true);
    await load().catch(() => {});
  } finally { $('device-toggle').disabled = false; }
});
$('device-cancel').addEventListener('click', event => {
  if (!event.isTrusted) return;
  deviceDisablePending = false;
  $('device-new-pin').value = '';
  $('device-confirm-pin').value = '';
  showAuthorizationStates();
  status($('device-status'), '');
});
$('clear').addEventListener('click', async event => {
  if (!event.isTrusted || !confirm(t('Delete local data? Your saved account, password, passkeys, and verification passphrase will be removed. Settings, language, and activity will also be reset. This cannot be undone. Make sure you have another way to verify with Duo.'))) return;
  try { await api({ type: 'UI_CLEAR' }); await load({ account: true, pin: true }); status($('clear-status'), "Local data deleted."); }
  catch (error) { status($('clear-status'), error.message, true); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !['settings', 'history'].some(key => Object.hasOwn(changes, key))) return;
  if ($('save-account').disabled) return;
  void load().catch(() => {});
});
try { await initializeLocale(); } catch { status($('language-status'), 'Unable to load the saved language. Reload this page to try again.', true); }
try { await load({ account: true, pin: true }); } catch (error) { status($('account-status'), error.message, true); }
