import { Controller } from './core/controller.js';
import { Vault, indexedRepository } from './core/vault.js';
import { createLanguagePreference, translate } from './core/locale.js';

const controller = new Controller(chrome, new Vault(indexedRepository()));
const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);
function quietly(promise) { promise.catch(() => { /* No credentials or page data in console logs. */ }); }
async function wakeDocument(details) {
  if (details?.frameId !== 0 || !Number.isInteger(details.tabId) || !details.documentId) return;
  await chrome.tabs.sendMessage(details.tabId, { type: 'FLOW_WAKE' }, { documentId: details.documentId }).catch(() => {});
}
async function navigation(details) {
  await ready;
  await controller.navigation(details);
  await wakeDocument(details);
}
async function maintain() {
  const targets = await controller.cleanup();
  await Promise.all(targets.map(wakeDocument));
}
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
chrome.webNavigation.onCommitted.addListener(details => quietly(navigation(details)));
chrome.webNavigation.onHistoryStateUpdated.addListener(details => quietly(navigation(details)));
chrome.webNavigation.onDOMContentLoaded.addListener(details => quietly(ready.then(() => wakeDocument(details))));
chrome.webNavigation.onCompleted.addListener(details => quietly(ready.then(() => wakeDocument(details))));
chrome.tabs.onRemoved.addListener(id => quietly(ready.then(() => controller.exclusive(() => controller.invalidateTab(id)))));
chrome.windows.onRemoved.addListener(id => quietly(ready.then(() => controller.windowClosed(id))));
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'cleanup') quietly(ready.then(maintain)); });
function initialize() {
  quietly(ready.then(() => controller.exclusive(() => controller.syncScripts())).then(maintain));
  quietly(chrome.alarms.create('cleanup', { periodInMinutes: 0.5 }));
}
chrome.runtime.onInstalled.addListener(details => {
  initialize();
  if (details.reason === 'install') quietly(ready.then(() => chrome.runtime.openOptionsPage()));
});
chrome.runtime.onStartup.addListener(initialize);
chrome.permissions.onRemoved.addListener(() => quietly(ready.then(() => controller.exclusive(async () => { await controller.invalidateAll(); await controller.syncScripts(); }))));
chrome.permissions.onAdded.addListener(() => quietly(ready.then(() => controller.exclusive(() => controller.syncScripts()))));
initialize();
