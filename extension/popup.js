import { $, api, status, t, localize, initializeLocale } from './ui.js';
let enabled = false;
let changing = false;
function drawToggle() {
  $('toggle').setAttribute('aria-checked', String(enabled));
  localize($('toggle'), () => t(enabled ? "On · Click to disable" : "Off · Click to enable"), 'title');
}
async function load() {
  const data = await api({ type: 'UI_GET' });
  enabled = data.enabled;
  drawToggle();
  $('toggle').disabled = false;
  localize($('account'), () => data.username || t("No account saved"));
  const accountSaved = !!data.username && data.hasPassword;
  const passkeySaved = data.credentials.length > 0;
  $('account-saved').hidden = !accountSaved;
  $('passkey-saved').hidden = !passkeySaved;
  $('saved-indicators').hidden = !accountSaved && !passkeySaved;
}
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('retry').addEventListener('click', async event => {
  if (!event.isTrusted || $('retry').disabled) return;
  $('retry').disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await api({ type: 'UI_RETRY', tabId: tab.id }); window.close();
  } catch (error) { status($('status'), error.message, true); }
  finally { $('retry').disabled = false; }
});
$('toggle').addEventListener('click', async event => {
  if (!event.isTrusted || changing || $('toggle').disabled) return;
  changing = true; $('toggle').disabled = true;
  try {
    const next = !enabled;
    await api({ type: 'UI_TOGGLE', enabled: next });
    enabled = next; drawToggle(); status($('status'), '');
  } catch (error) {
    try { enabled = (await api({ type: 'UI_GET' })).enabled; drawToggle(); } catch { /* Keep the last known state if storage is unavailable. */ }
    status($('status'), error.message, true);
  }
  finally { changing = false; $('toggle').disabled = false; }
});
try { await initializeLocale(); } catch { status($('status'), 'Unable to load the saved language. Reload this page to try again.', true); }
try { await load(); } catch (error) { status($('status'), error.message, true); }
