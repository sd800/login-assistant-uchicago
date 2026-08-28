import { Controller } from './core/controller.js';
import { Vault, indexedRepository } from './core/vault.js';
import { createLanguagePreference, translate } from './core/locale.js';

const controller = new Controller(chrome, new Vault(indexedRepository()));
const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);
function quietly(promise) { promise.catch(() => { /* No credentials or page data in console logs. */ }); }
const language = createLanguagePreference(chrome.storage.local, chrome.storage.onChanged, chrome.i18n.getUILanguage());
function updateTitle() { return chrome.action.setTitle({ title: translate('UChicago Login Assistant', language.locale) }); }
language.subscribe(() => quietly(updateTitle()));
quietly(ready.then(() => language.initialize()).finally(updateTitle));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  ready.then(() => controller.dispatch(message, sender)).then(
    result => respond({ ok: true, result }),
    error => respond({ ok: false, error: error.message || "Unable to complete the request. Try again." })
  );
  return true;
});
chrome.webNavigation.onCommitted.addListener(details => quietly(ready.then(() => controller.navigation(details))));
chrome.webNavigation.onHistoryStateUpdated.addListener(details => quietly(ready.then(() => controller.navigation(details))));
chrome.tabs.onRemoved.addListener(id => quietly(ready.then(() => controller.exclusive(() => controller.invalidateTab(id)))));
chrome.windows.onRemoved.addListener(id => quietly(ready.then(() => controller.windowClosed(id))));
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'cleanup') quietly(ready.then(() => controller.cleanup())); });
function initialize() {
  quietly(ready.then(() => controller.exclusive(() => controller.syncScripts())).then(() => controller.cleanup()));
  quietly(chrome.alarms.create('cleanup', { periodInMinutes: 1 }));
}
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
chrome.permissions.onRemoved.addListener(() => quietly(ready.then(() => controller.exclusive(async () => { await controller.invalidateAll(); await controller.syncScripts(); }))));
chrome.permissions.onAdded.addListener(() => quietly(ready.then(() => controller.exclusive(() => controller.syncScripts()))));
initialize();
