import { createLanguagePreference } from './core/locale.js';
import { createPageLocalization } from './localization.js';

const language = createPageLocalization(createLanguagePreference(chrome.storage.local, chrome.storage.onChanged, chrome.i18n.getUILanguage()), document);
export const { t, date, passkeyCount, getLocale, setLocale, bind: localize, text: bindText, initialize: initializeLocale } = language;
export const $ = id => document.getElementById(id);
export async function api(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "The assistant is unavailable. Reload the extension and try again.");
  return response.result;
}
export function status(element, text, error = false) {
  bindText(element, text);
  element.hidden = false;
  element.classList.toggle('error', error);
}
