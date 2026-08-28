import { $, api, status, date, t, bindText, localize, initializeLocale, getLocale, setLocale } from './ui.js';
let snapshot;
function passwordRequirement() {
  $('password').required = !snapshot?.hasPassword || $('username').value.trim() !== snapshot.username;
}
function disable(ids, value) { for (const id of ids) $(id).disabled = value; }
async function load({ account = false, settings = false, pin = false } = {}) {
  const next = await api({ type: 'UI_GET' });
  const selectedDraft = $('selected-credential').value;
  const changedAccount = snapshot && snapshot.username !== next.username;
  snapshot = next;
  // Refresh only the saved section. Other forms keep their current drafts.
  if (account) { $('username').value = snapshot.username; $('password').value = ''; }
  passwordRequirement();
  localize($('password'), () => t(snapshot.hasPassword ? "Saved — leave blank to keep" : "Enter your school password"), 'placeholder');
  if (pin) { $('old-pin').value = ''; $('new-pin').value = ''; }
  $('old-pin-field').hidden = !snapshot.hasPin;
  $('old-pin').required = snapshot.hasPin;
  const defaultChoice = new Option('', '');
  bindText(defaultChoice, "Ask each time or use another provider");
  $('selected-credential').replaceChildren(defaultChoice);
  $('credentials').replaceChildren();
  if (!snapshot.credentials.length) {
    const p = document.createElement('p'); p.className = 'muted';
    bindText(p, "No saved passkeys. See Getting started to add one."); $('credentials').append(p);
  }
  for (const credential of snapshot.credentials) {
    $('selected-credential').append(new Option(credential.userName + ' · ' + credential.rpId + ' · ' + credential.id.slice(0, 8) + '…', credential.id));
    const row = document.createElement('div'); row.className = 'credential';
    const title = document.createElement('strong'); title.textContent = credential.userName;
    const meta = document.createElement('small'); bindText(meta, '{site} · Created {date}', () => ({ site: credential.rpId, date: date(credential.createdAt) }));
    const used = document.createElement('small'); bindText(used, credential.lastUsedAt ? 'Last attempt: {date}. Check Duo for the result.' : "Not used yet. Check that registration completed in Duo.", () => ({ date: date(credential.lastUsedAt) }));
    const remove = document.createElement('button'); remove.className = 'text danger'; bindText(remove, "Delete passkey");
    remove.addEventListener('click', async event => {
      if (!event.isTrusted || remove.disabled || !confirm(t("Delete this saved passkey? This cannot be undone. Its registration in Duo will remain."))) return;
      remove.disabled = true;
      try { await api({ type: 'UI_DELETE', id: credential.id }); await load(); }
      catch (error) { status($('credentials-status'), error.message, true); }
      finally { remove.disabled = false; }
    });
    row.append(title, meta, used, remove); $('credentials').append(row);
  }
  const selection = settings || changedAccount ? snapshot.selectedCredentialId : selectedDraft;
  $('selected-credential').value = snapshot.credentials.some(c => c.id === selection) ? selection : '';
  $('history').replaceChildren();
  for (const item of snapshot.history) {
    const li = document.createElement('li'); const time = document.createElement('time');
    localize(time, () => date(item.at));
    const text = document.createElement('span'); bindText(text, item.text);
    li.append(time, text); $('history').append(li);
  }
  if (!snapshot.history.length) { const li = document.createElement('li'); bindText(li, "No activity yet."); $('history').append(li); }
}
$('username').addEventListener('input', passwordRequirement);
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
  } catch (error) { status($('account-status'), error.message, true); }
  finally { disable(['save-account', 'username', 'password'], false); }
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.isTrusted || $('save').disabled) return;
  disable(['save', 'selected-credential'], true);
  try {
    await api({ type: 'UI_SAVE_SETTINGS', selectedCredentialId: $('selected-credential').value });
    await load({ settings: true });
    status($('save-status'), "Settings saved.");
  } catch (error) { status($('save-status'), error.message, true); }
  finally { disable(['save', 'selected-credential'], false); }
});
$('pin-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!event.isTrusted) return;
  try { await api({ type: 'UI_PIN', oldPin: $('old-pin').value, newPin: $('new-pin').value }); await load({ pin: true }); status($('pin-status'), "Verification PIN updated."); }
  catch (error) { status($('pin-status'), error.message, true); }
  finally { $('old-pin').value = ''; $('new-pin').value = ''; }
});
$('clear').addEventListener('click', async event => {
  if (!event.isTrusted || !confirm(t("Delete local account data? Your saved account, password, passkeys, and PIN will be removed. Settings, language, and activity will also be reset. This cannot be undone. Make sure you have another way to verify with Duo."))) return;
  try { await api({ type: 'UI_CLEAR' }); await load({ account: true, settings: true, pin: true }); status($('clear-status'), "Local account data deleted."); }
  catch (error) { status($('clear-status'), error.message, true); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !['settings', 'history'].some(key => Object.hasOwn(changes, key))) return;
  if ($('save-account').disabled || $('save').disabled) return;
  void load().catch(() => {});
});
try { await initializeLocale(); } catch { status($('language-status'), 'Unable to load the saved language. Reload this page to try again.', true); }
try { await load({ account: true, settings: true, pin: true }); } catch (error) { status($('account-status'), error.message, true); }
