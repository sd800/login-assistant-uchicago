import { translate, formatDate, formatPasskeyCount } from './core/locale.js';

export function createPageLocalization(preference, document) {
  const bindings = new Map();
  let initialized = false;
  let unsubscribe;
  const t = (message, params = {}) => translate(message, preference.locale, params);
  function draw(element, binding) {
    const value = binding.render();
    if (binding.attribute) element.setAttribute(binding.attribute, value);
    else element.textContent = value;
  }
  function bind(element, render, attribute) {
    const binding = { render, attribute };
    const group = bindings.get(element) || new Map();
    group.set(attribute || 'textContent', binding);
    bindings.set(element, group);
    draw(element, binding);
  }
  function text(element, message, params = {}) {
    bind(element, () => t(message, typeof params === 'function' ? params() : params));
  }
  function refresh() {
    document.documentElement.lang = preference.locale;
    for (const [element, group] of bindings) {
      if (element.isConnected === false) bindings.delete(element);
      else for (const binding of group.values()) draw(element, binding);
    }
    const picker = document.getElementById('language');
    if (picker) picker.value = preference.locale;
  }
  return {
    t, bind, text,
    date: (timestamp, timeZone) => formatDate(timestamp, timeZone, preference.locale),
    passkeyCount: count => formatPasskeyCount(count, preference.locale),
    getLocale: () => preference.locale,
    setLocale: value => preference.set(value),
    async initialize() {
      // Read the preference before drawing any text, including the tab title.
      try { await preference.initialize(); }
      finally {
        try {
          if (!initialized) {
            initialized = true;
            for (const element of document.querySelectorAll('[data-i18n]')) {
              text(element, element.dataset.i18n || element.textContent.trim());
            }
            for (const attribute of ['aria-label', 'title']) {
              for (const element of document.querySelectorAll('[data-i18n-' + attribute + ']')) {
                const message = element.getAttribute('data-i18n-' + attribute);
                bind(element, () => t(message), attribute);
              }
            }
            for (const element of document.querySelectorAll('[data-language-name]')) {
              const language = element.dataset.languageName;
              bind(element, () => translate(language === 'en-US' ? 'English' : 'Simplified Chinese', language));
            }
            unsubscribe = preference.subscribe(refresh);
          }
          refresh();
        } finally {
          // A failed storage read still leaves a usable page in the available locale.
          document.body.removeAttribute('data-locale-pending');
        }
      }
    },
    dispose() { unsubscribe?.(); preference.dispose(); bindings.clear(); }
  };
}
