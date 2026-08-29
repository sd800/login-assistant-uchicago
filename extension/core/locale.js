import chinese from '../locales/zh-CN.js';

export const LOCALE = 'en-US';
export const LANGUAGE_KEY = 'uiLanguage';
export const SUPPORTED_LOCALES = Object.freeze([LOCALE, 'zh-CN']);
export const normalizeLocale = value => SUPPORTED_LOCALES.includes(value) ? value : LOCALE;
export const resolveLocale = (value, uiLanguage = LOCALE) => SUPPORTED_LOCALES.includes(value) ? value :
  typeof uiLanguage === 'string' && /^zh(?:[-_]|$)/i.test(uiLanguage.trim()) ? 'zh-CN' : LOCALE;

// English phrases are stable lookup keys; unknown browser errors stay intact.
export function translate(message, locale = LOCALE, params = {}) {
  const source = String(message);
  const template = normalizeLocale(locale) === 'zh-CN' && Object.hasOwn(chinese, source) ? chinese[source] : source;
  return template.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
}

export function formatDate(timestamp, timeZone, locale = LOCALE) {
  const selected = normalizeLocale(locale);
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return translate('Not available', selected);
  const options = {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: selected === LOCALE, timeZoneName: 'short'
  };
  // A language choice changes presentation, never the device's time zone.
  if (timeZone) options.timeZone = timeZone;
  return new Intl.DateTimeFormat(selected, options).format(date);
}

export function formatPasskeyCount(count, locale = LOCALE) {
  return translate(count === 1 ? '{count} saved passkey' : '{count} saved passkeys', locale,
    { count: new Intl.NumberFormat(normalizeLocale(locale)).format(count) });
}

// Injectable storage keeps language independent of the vault and sign-in state.
export function createLanguagePreference(storage, changes, uiLanguage = LOCALE) {
  const defaultLocale = resolveLocale(null, uiLanguage);
  let locale = defaultLocale;
  let revision = 0;
  let listening = false;
  let ready;
  const listeners = new Set();
  function apply(value) {
    const next = SUPPORTED_LOCALES.includes(value) ? value : defaultLocale;
    if (next === locale) return;
    locale = next;
    for (const listener of listeners) listener(locale);
  }
  function changed(values, area) {
    if (area !== 'local' || !Object.hasOwn(values, LANGUAGE_KEY)) return;
    revision++;
    apply(values[LANGUAGE_KEY].newValue);
  }
  function initialize() {
    if (!listening) { changes.addListener(changed); listening = true; }
    if (!ready) {
      const started = revision;
      ready = Promise.resolve().then(() => storage.get(LANGUAGE_KEY)).then(values => {
        if (revision === started) apply(values[LANGUAGE_KEY]);
        return locale;
      }).catch(error => { ready = undefined; throw error; });
    }
    return ready;
  }
  return {
    get locale() { return locale; },
    initialize,
    async set(value) {
      if (!SUPPORTED_LOCALES.includes(value)) throw new Error('Choose English or Simplified Chinese.');
      await initialize();
      const started = revision;
      await storage.set({ [LANGUAGE_KEY]: value });
      // Do not overwrite a newer cross-window change when this write resolves.
      if (revision === started) apply(value);
      return locale;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      if (listening) changes.removeListener(changed);
      listening = false; ready = undefined; revision++; listeners.clear();
    }
  };
}
