import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LOCALE, LANGUAGE_KEY, normalizeLocale, formatDate, formatPasskeyCount, translate, createLanguagePreference } from '../extension/core/locale.js';
import { CONFIRM_TEXT, validateAccount } from '../extension/core/policy.js';
import chinese from '../extension/locales/zh-CN.js';
import { createPageLocalization } from '../extension/localization.js';

test('date formatting uses US month order and a 12-hour clock with a time zone', () => {
  assert.equal(LOCALE, 'en-US');
  const value = formatDate(Date.UTC(2026, 7, 28, 20, 5), 'America/Chicago');
  assert.match(value, /^Aug 28, 2026, 3:05\sPM CDT$/);
});

test('localization does not force all users into the Chicago time zone', () => {
  const instant = Date.UTC(2026, 7, 28, 20, 5);
  assert.match(formatDate(instant, 'Asia/Shanghai'), /^Aug 29, 2026, 4:05\sAM GMT\+8$/);
  assert.match(formatDate(Date.UTC(2026, 0, 28, 20, 5), 'America/Chicago'), /2:05\sPM CST$/);
  assert.equal(formatDate('invalid'), 'Not available');
});

test('passkey counts use natural US singular and plural forms', () => {
  assert.equal(formatPasskeyCount(0), '0 saved passkeys');
  assert.equal(formatPasskeyCount(1), '1 saved passkey');
  assert.equal(formatPasskeyCount(2), '2 saved passkeys');
  assert.equal(formatPasskeyCount(1000), '1,000 saved passkeys');
});

test('sign-in confirmation has consistent text, controls, and keyboard hints', async () => {
  assert.equal(CONFIRM_TEXT, 'Sign in to UChicago with saved account?');
  const html = await readFile(new URL('../extension/confirm.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../extension/confirm.js', import.meta.url), 'utf8');
  assert.match(html, /id="cancel"[^>]*>Cancel<\/button>/);
  assert.match(html, /id="approve"[^>]*disabled[^>]*>Confirm<\/button>/);
  assert.match(script, /bindText\(\$\('approve'\), 'Confirm'\)/);
  const details = html.match(/<details class="disclosure consent-details">([\s\S]*?)<\/details>/)[1];
  assert.match(details, /id="consent-help"[^>]*><\/p>\s*<p[^>]*id="keyboard-help"[^>]*data-i18n/);
  const keyboardHelp = details.match(/id="keyboard-help"[^>]*>([^<]+)<\/p>/)[1];
  assert.notEqual(translate(keyboardHelp, 'zh-CN'), keyboardHelp);

  assert.equal(translate(CONFIRM_TEXT, 'en-US'), CONFIRM_TEXT);
  assert.equal(translate(CONFIRM_TEXT, 'zh-CN'), '\u4f7f\u7528\u5df2\u4fdd\u5b58\u7684\u8d26\u53f7\u767b\u5f55 UChicago\uff1f');
});

test('product localization never rewrites account names or passwords', () => {
  const username = 'student-\u00e9';
  const password = 'My \u6c49\u5b57 passphrase 42!';
  assert.deepEqual(validateAccount(username, password), { username, password });
});

test('Chinese dates and counts follow the selected locale without changing time zones', () => {
  assert.equal(formatDate(Date.UTC(2026, 7, 28, 20, 5), 'Asia/Shanghai', 'zh-CN'), '2026\u5e748\u670829\u65e5 GMT+8 04:05');
  assert.match(formatDate(Date.UTC(2026, 7, 28, 20, 5), 'America/Chicago', 'zh-CN'), /15:05/);
  assert.equal(formatPasskeyCount(1000, 'zh-CN'), '\u5df2\u4fdd\u5b58 1,000 \u4e2a\u901a\u884c\u5bc6\u94a5');
  assert.equal(formatDate('invalid', undefined, 'zh-CN'), '\u6682\u65e0');
  assert.equal(normalizeLocale('unsupported'), 'en-US');
  assert.equal(translate('Cancel', 'unsupported'), 'Cancel');
});

test('the translation catalog preserves parameters and localizes Settings', () => {
  const parameters = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [english, translated] of Object.entries(chinese)) {
    assert.ok(translated.trim(), 'Empty translation: ' + english);
    assert.deepEqual(parameters(translated), parameters(english), 'Mismatched parameters: ' + english);
  }
  assert.equal(translate('Settings', 'zh-CN'), '\u8bbe\u7f6e');
  assert.equal(translate('Account & passkey settings', 'en-US'), 'Account & passkey settings');
  assert.equal(Object.hasOwn(chinese, 'Account & passkey settings'), false);
  const site = '<img src=x onerror=alert(1)>';
  assert.equal(translate('{site} · Created {date}', 'zh-CN', { site, date: '2026' }), site + ' · \u521b\u5efa\u4e8e 2026');
  assert.equal(translate('Unknown browser error', 'zh-CN'), 'Unknown browser error');
  assert.equal(translate('constructor', 'zh-CN'), 'constructor');
});

test('all static interface copy is localized and language choices use stable locale values', async () => {
  const css = await readFile(new URL('../extension/ui.css', import.meta.url), 'utf8');
  assert.match(css, /body\[data-locale-pending\]\s*\{\s*visibility:\s*hidden;\s*\}/);
  for (const page of ['settings.html', 'popup.html', 'confirm.html']) {
    const html = await readFile(new URL('../extension/' + page, import.meta.url), 'utf8');
    assert.match(html, /<body\b[^>]*\bdata-locale-pending(?:\s|>)/, 'The initial HTML must hide untranslated content.');
    assert.match(html, /<title data-i18n="[^"]+">UChicago<\/title>/, 'Use a neutral tab title until localization is ready.');
    for (const match of html.matchAll(/<([a-z][\w-]*)\b([^<>]*)>([^<>]+)<\/\1>/gi)) {
      const value = match[3].trim().replaceAll('&amp;', '&');
      if (!/[A-Za-z]/.test(value) || value === 'UChicago' || match[2].includes('translate="no"') || match[2].includes('data-language-name')) continue;
      assert.ok(match[2].includes('data-i18n'), 'Unmarked copy in ' + page + ': ' + value);
      assert.ok(Object.hasOwn(chinese, value), 'Missing translation: ' + value);
    }
  }
  const settings = await readFile(new URL('../extension/settings.html', import.meta.url), 'utf8');
  assert.match(settings, /select id="language" aria-describedby="language-help"/);
  assert.match(settings, /option value="en-US" data-language-name="en-US"/);
  assert.match(settings, /option value="zh-CN" data-language-name="zh-CN"/);
  const popup = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  assert.match(popup, /id="settings"[^>]*aria-label="Settings"[^>]*data-i18n-aria-label="Settings"/);
});

function languageStorage(initial = {}) {
  const data = structuredClone(initial);
  const listeners = new Set();
  const writes = [];
  const emit = (values, area = 'local') => { for (const listener of listeners) listener(values, area); };
  return {
    data, writes, listeners, emit,
    changes: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
    storage: {
      async get(key) { return { [key]: structuredClone(data[key]) }; },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: data[key], newValue: value };
          data[key] = structuredClone(value);
        }
        writes.push(structuredClone(values));
        emit(changes);
      }
    }
  };
}

test('unset language uses the Chrome UI language without saving an override', async () => {
  const cases = [
    ...['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-SG', 'zh-Hans', 'zh-Hant-HK', 'ZH-cn', 'zh_TW']
      .map(value => [value, 'zh-CN']),
    ...['en-US', 'en-GB', 'fr', 'ja', 'de', 'zho', 'zhfoo', '', undefined, null, 123]
      .map(value => [value, 'en-US'])
  ];
  for (const [uiLanguage, expected] of cases) {
    for (const saved of [undefined, null, 'invalid']) {
      const shared = languageStorage({ [LANGUAGE_KEY]: saved });
      const preference = createLanguagePreference(shared.storage, shared.changes, uiLanguage);
      assert.equal(preference.locale, expected);
      assert.equal(await preference.initialize(), expected);
      assert.deepEqual(shared.writes, []);
      preference.dispose();
    }
  }
});

test('saved choices override the browser language until cleared', async () => {
  for (const [uiLanguage, fallback] of [['zh-TW', 'zh-CN'], ['fr-FR', 'en-US']]) {
    for (const saved of ['en-US', 'zh-CN']) {
      const shared = languageStorage({ [LANGUAGE_KEY]: saved });
      const preference = createLanguagePreference(shared.storage, shared.changes, uiLanguage);
      assert.equal(await preference.initialize(), saved);
      assert.deepEqual(shared.writes, []);
      await shared.storage.set({ [LANGUAGE_KEY]: null });
      assert.equal(preference.locale, fallback);
      const reopened = createLanguagePreference(shared.storage, shared.changes, uiLanguage);
      assert.equal(await reopened.initialize(), fallback);
      assert.deepEqual(shared.writes, [{ [LANGUAGE_KEY]: null }]);
      preference.dispose(); reopened.dispose();
    }
  }
});

test('language persists across windows and reopening without rewriting authentication settings', async () => {
  const settings = { enabled: true, duoOrigin: 'https://api-test123.duosecurity.com', selectedCredentialId: 'key-one' };
  const history = [{ at: 1, text: 'Sign-in approved.' }];
  const shared = languageStorage({ settings, history });
  const first = createLanguagePreference(shared.storage, shared.changes);
  const second = createLanguagePreference(shared.storage, shared.changes);
  await Promise.all([first.initialize(), second.initialize()]);
  await first.set('zh-CN');
  assert.equal(second.locale, 'zh-CN');
  const reopened = createLanguagePreference(shared.storage, shared.changes);
  assert.equal(await reopened.initialize(), 'zh-CN');
  assert.deepEqual(shared.writes, [{ [LANGUAGE_KEY]: 'zh-CN' }]);
  assert.deepEqual(shared.data.settings, settings);
  assert.deepEqual(shared.data.history, history);
  shared.emit({ settings: { newValue: {} } });
  shared.emit({ [LANGUAGE_KEY]: { newValue: 'en-US' } }, 'sync');
  assert.equal(first.locale, 'zh-CN');
  shared.emit({ [LANGUAGE_KEY]: {} });
  assert.equal(first.locale, 'en-US');
  first.dispose(); second.dispose(); reopened.dispose();
  assert.equal(shared.listeners.size, 0);
});

test('a delayed initial read cannot undo a newer language change', async () => {
  const shared = languageStorage();
  let finishRead;
  shared.storage.get = () => new Promise(resolve => { finishRead = resolve; });
  const preference = createLanguagePreference(shared.storage, shared.changes);
  const ready = preference.initialize();
  await Promise.resolve();
  shared.emit({ [LANGUAGE_KEY]: { newValue: 'zh-CN' } });
  finishRead({ [LANGUAGE_KEY]: 'en-US' });
  await ready;
  assert.equal(preference.locale, 'zh-CN');
});

test('failed or invalid language saves retain the current choice', async () => {
  const shared = languageStorage({ [LANGUAGE_KEY]: 'zh-CN' });
  const preference = createLanguagePreference(shared.storage, shared.changes);
  await preference.initialize();
  shared.storage.set = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(preference.set('en-US'), /Storage unavailable/);
  await assert.rejects(preference.set('invalid'), /Choose English/);
  assert.equal(preference.locale, 'zh-CN');
  assert.equal(shared.data[LANGUAGE_KEY], 'zh-CN');
});

test('an older write completion cannot overwrite a newer cross-window selection', async () => {
  const shared = languageStorage();
  const first = createLanguagePreference(shared.storage, shared.changes);
  const second = createLanguagePreference(shared.storage, shared.changes);
  await Promise.all([first.initialize(), second.initialize()]);
  let finishFirst;
  const write = shared.storage.set;
  shared.storage.set = async values => {
    await write(values);
    if (values[LANGUAGE_KEY] === 'zh-CN') await new Promise(resolve => { finishFirst = resolve; });
  };
  const pending = first.set('zh-CN');
  await new Promise(resolve => setImmediate(resolve));
  await second.set('en-US');
  finishFirst();
  await pending;
  assert.equal(first.locale, 'en-US');
  assert.equal(second.locale, 'en-US');
  assert.equal(shared.data[LANGUAGE_KEY], 'en-US');
});

function pageDocument() {
  const element = (textContent = '', marked = false) => ({
    textContent, value: '', disabled: false, checked: false, isConnected: true,
    dataset: marked ? { i18n: '' } : {},
    setAttribute(name, value) { this[name] = value; },
    set innerHTML(_) { throw new Error('Translations must never insert HTML'); }
  });
  const elements = {
    language: element(), title: element('Settings', true), approve: element('Confirm', true),
    cancel: element('Cancel', true), username: element(), password: element(), pin: element(),
    credential: element(), error: element(), history: element(), date: element(), count: element()
  };
  return {
    elements, documentElement: { lang: 'en-US' },
    body: {
      pending: true,
      hasAttribute(name) { return name === 'data-locale-pending' && this.pending; },
      removeAttribute(name) { if (name === 'data-locale-pending') this.pending = false; }
    },
    getElementById: id => elements[id],
    querySelectorAll(selector) {
      const property = selector === '[data-i18n]' ? 'i18n' : 'languageName';
      return Object.values(elements).filter(node => Object.hasOwn(node.dataset, property));
    }
  };
}

test('the first visible content uses the resolved language after a delayed read', async () => {
  for (const [saved, uiLanguage, expected] of [
    ['zh-CN', 'en-US', 'zh-CN'], ['en-US', 'zh-TW', 'en-US'],
    [undefined, 'zh-CN', 'zh-CN'], [undefined, 'zh-TW', 'zh-CN'],
    [undefined, 'fr-FR', 'en-US'], [null, 'zh-Hant', 'zh-CN'], ['invalid', 'zh', 'zh-CN']
  ]) {
    const shared = languageStorage();
    let finishRead;
    shared.storage.get = () => new Promise(resolve => { finishRead = resolve; });
    const doc = pageDocument();
    doc.elements.title.dataset.i18n = 'Settings';
    doc.elements.title.textContent = 'UChicago';
    const visible = [];
    const reveal = doc.body.removeAttribute.bind(doc.body);
    doc.body.removeAttribute = name => {
      visible.push({ lang: doc.documentElement.lang, title: doc.elements.title.textContent,
        approve: doc.elements.approve.textContent, cancel: doc.elements.cancel.textContent,
        picker: doc.elements.language.value });
      reveal(name);
    };
    const page = createPageLocalization(createLanguagePreference(shared.storage, shared.changes, uiLanguage), doc);
    const ready = page.initialize();
    await Promise.resolve();
    assert.equal(doc.body.hasAttribute('data-locale-pending'), true);
    assert.equal(doc.elements.title.textContent, 'UChicago', 'Do not briefly replace the neutral tab title with English.');
    assert.equal(visible.length, 0);
    finishRead({ [LANGUAGE_KEY]: saved });
    await ready;
    const locale = expected;
    assert.equal(doc.body.hasAttribute('data-locale-pending'), false);
    assert.deepEqual(visible, [{ lang: locale, title: translate('Settings', locale),
      approve: translate('Confirm', locale), cancel: translate('Cancel', locale), picker: locale }]);
    page.dispose();
  }
});

test('a failed language read reveals the browser default and can be retried', async () => {
  for (const [uiLanguage, fallback, saved] of [['en-US', 'en-US', 'zh-CN'], ['zh-TW', 'zh-CN', 'en-US']]) {
    const shared = languageStorage();
    shared.storage.get = async () => { throw new Error('Storage unavailable'); };
    const doc = pageDocument();
    const page = createPageLocalization(createLanguagePreference(shared.storage, shared.changes, uiLanguage), doc);
    await assert.rejects(page.initialize(), /Storage unavailable/);
    assert.equal(doc.body.hasAttribute('data-locale-pending'), false);
    assert.equal(doc.documentElement.lang, fallback);
    assert.equal(doc.elements.title.textContent, translate('Settings', fallback));
    assert.equal(doc.elements.approve.textContent, translate('Confirm', fallback));
    shared.storage.get = async () => ({ [LANGUAGE_KEY]: saved });
    await page.initialize();
    assert.equal(doc.elements.title.textContent, translate('Settings', saved));
    assert.equal(doc.elements.language.value, saved);
    assert.equal(doc.body.hasAttribute('data-locale-pending'), false);
    page.dispose();
  }
});

test('a newer cross-window language selection wins before the initial reveal', async () => {
  const shared = languageStorage();
  let finishRead;
  shared.storage.get = () => new Promise(resolve => { finishRead = resolve; });
  const doc = pageDocument();
  doc.elements.title.dataset.i18n = 'Settings';
  doc.elements.title.textContent = 'UChicago';
  const page = createPageLocalization(createLanguagePreference(shared.storage, shared.changes), doc);
  const ready = page.initialize();
  await Promise.resolve();
  shared.emit({ [LANGUAGE_KEY]: { newValue: 'zh-CN' } });
  assert.equal(doc.body.hasAttribute('data-locale-pending'), true);
  assert.equal(doc.elements.title.textContent, 'UChicago');
  finishRead({ [LANGUAGE_KEY]: 'en-US' });
  await ready;
  assert.equal(doc.documentElement.lang, 'zh-CN');
  assert.equal(doc.elements.title.textContent, chinese.Settings);
  assert.equal(doc.elements.language.value, 'zh-CN');
  assert.equal(doc.body.hasAttribute('data-locale-pending'), false);
  page.dispose();
});

test('live localization updates labels and statuses without disturbing drafts or confirmation controls', async () => {
  const shared = languageStorage();
  const settings = pageDocument();
  const confirmation = pageDocument();
  delete confirmation.elements.language;
  const first = createPageLocalization(createLanguagePreference(shared.storage, shared.changes), settings);
  const second = createPageLocalization(createLanguagePreference(shared.storage, shared.changes), confirmation);
  await Promise.all([first.initialize(), second.initialize()]);
  settings.elements.password.value = 'unsaved password';
  settings.elements.credential.value = 'unsaved-selection';
  confirmation.elements.pin.value = 'typed-pin';
  confirmation.elements.approve.disabled = true;
  const account = '<b>Cancel</b>';
  first.bind(settings.elements.username, () => account);
  first.bind(settings.elements.password, () => first.t('Saved — leave blank to keep'), 'placeholder');
  first.bind(settings.elements.date, () => first.date(Date.UTC(2026, 7, 28, 20, 5), 'Asia/Shanghai'));
  first.bind(settings.elements.count, () => first.passkeyCount(2));
  second.text(confirmation.elements.title, CONFIRM_TEXT);
  second.text(confirmation.elements.error, 'Enter your verification PIN.');
  first.text(settings.elements.history, 'Sign-in approved.');
  await first.setLocale('zh-CN');
  assert.equal(settings.documentElement.lang, 'zh-CN');
  assert.equal(confirmation.documentElement.lang, 'zh-CN');
  assert.equal(confirmation.elements.title.textContent, chinese[CONFIRM_TEXT]);
  assert.equal(confirmation.elements.error.textContent, chinese['Enter your verification PIN.']);
  assert.equal(settings.elements.history.textContent, chinese['Sign-in approved.']);
  assert.equal(settings.elements.password.placeholder, chinese['Saved — leave blank to keep']);
  assert.match(settings.elements.date.textContent, /04:05/);
  assert.equal(settings.elements.count.textContent, formatPasskeyCount(2, 'zh-CN'));
  assert.equal(settings.elements.username.textContent, account);
  assert.equal(settings.elements.password.value, 'unsaved password');
  assert.equal(settings.elements.credential.value, 'unsaved-selection');
  assert.equal(confirmation.elements.pin.value, 'typed-pin');
  assert.equal(confirmation.elements.approve.disabled, true);
  await first.setLocale('en-US');
  assert.equal(confirmation.elements.title.textContent, CONFIRM_TEXT);
  assert.equal(confirmation.elements.approve.textContent, 'Confirm');
  assert.equal(confirmation.elements.cancel.textContent, 'Cancel');
  assert.equal(confirmation.elements.error.textContent, 'Enter your verification PIN.');
  first.dispose(); second.dispose();
});

test('settings labels and privacy help are localized and the popup stays compact', async () => {
  const popup = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../extension/settings.html', import.meta.url), 'utf8');
  assert.doesNotMatch(popup, /Stored on this device|Independent project/);
  assert.equal(Object.hasOwn(chinese, 'Stored on this device · Independent project'), false);
  assert.match(settings, /id="save-account"[^>]*>Save<\/button>/);
  assert.doesNotMatch(settings, /selected-credential|Ask each time/);
  assert.equal(translate("Local data", 'zh-CN'), "\u672c\u5730\u6570\u636e");
  assert.equal(translate("Delete local data", 'zh-CN'), "\u6e05\u9664\u672c\u5730\u6570\u636e");
  assert.equal(translate("Independent project. Not affiliated with, sponsored by, or endorsed by the University of Chicago, Okta, Duo Security, or any other organization.", 'zh-CN'), "\u672c\u63d2\u4ef6\u4e3a\u72ec\u7acb\u9879\u76ee\uff0c\u4e0e\u829d\u52a0\u54e5\u5927\u5b66\u3001Okta\u3001Duo Security \u53ca\u5176\u4ed6\u4efb\u4f55\u673a\u6784\u5747\u65e0\u96b6\u5c5e\u5173\u7cfb\uff0c\u4e5f\u672a\u83b7\u5f97\u8fd9\u4e9b\u673a\u6784\u7684\u8d5e\u52a9\u6216\u80cc\u4e66\u3002");
  assert.equal(translate("Account and password saved", 'zh-CN'), "\u8d26\u53f7\u5bc6\u7801\u5df2\u4fdd\u5b58");
  assert.equal(translate("Passkey saved", 'zh-CN'), "\u901a\u884c\u5bc6\u94a5\u5df2\u4fdd\u5b58");
  assert.match(settings, /id="clear"[^>]*>Delete local data<\/button>/);
  assert.match(settings, /Uninstalling the extension deletes all data it has saved\./);
  assert.match(settings, /<details class="disclosure" id="privacy-notice">/);
  assert.equal(translate("Privacy", "zh-CN"), "\u9690\u79c1\u8bf4\u660e");
  assert.equal(translate('Confirm to log in to uchicago.edu.', 'zh-CN'), '\u786e\u8ba4\u4ee5\u767b\u5f55 uchicago.edu');
  assert.equal(translate('Your username and password have been securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.', 'zh-CN'),
    '\u7528\u6237\u540d\u548c\u5bc6\u7801\u5df2\u4f7f\u7528\u7b26\u5408\u884c\u4e1a\u6807\u51c6\u7684\u52a0\u5bc6\u65b9\u5f0f\u5b89\u5168\u4fdd\u5b58\u5728\u672c\u8bbe\u5907\u4e0a\uff0c\u4ec5\u7528\u4e8e\u60a8\u6bcf\u6b21\u660e\u786e\u6388\u6743\u7684\u767b\u5f55\u3002');
  assert.equal(translate('Passkeys will be securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.', 'zh-CN'),
    '\u901a\u884c\u5bc6\u94a5\u5c06\u4f7f\u7528\u7b26\u5408\u884c\u4e1a\u6807\u51c6\u7684\u52a0\u5bc6\u65b9\u5f0f\u5b89\u5168\u4fdd\u5b58\u5728\u672c\u8bbe\u5907\u4e0a\uff0c\u4ec5\u7528\u4e8e\u60a8\u6bcf\u6b21\u660e\u786e\u6388\u6743\u7684\u767b\u5f55\u3002');
  assert.equal(translate('Your passkey has been securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.', 'zh-CN'),
    '\u60a8\u7684\u901a\u884c\u5bc6\u94a5\u5df2\u4f7f\u7528\u7b26\u5408\u884c\u4e1a\u6807\u51c6\u7684\u52a0\u5bc6\u65b9\u5f0f\u5b89\u5168\u4fdd\u5b58\u5728\u672c\u8bbe\u5907\u4e0a\uff0c\u4ec5\u7528\u4e8e\u60a8\u6bcf\u6b21\u660e\u786e\u6388\u6743\u7684\u767b\u5f55\u3002');
  assert.equal(translate('Your passkeys have been securely saved on this device using industry-standard encryption, and will only be used for each sign-in you explicitly authorize.', 'zh-CN'),
    '\u60a8\u5df2\u4fdd\u5b58\u7684\u901a\u884c\u5bc6\u94a5\u5747\u4f7f\u7528\u7b26\u5408\u884c\u4e1a\u6807\u51c6\u7684\u52a0\u5bc6\u65b9\u5f0f\u5b89\u5168\u4fdd\u5b58\u5728\u672c\u8bbe\u5907\u4e0a\uff0c\u4ec5\u7528\u4e8e\u60a8\u6bcf\u6b21\u660e\u786e\u6388\u6743\u7684\u767b\u5f55\u3002');
  assert.equal(translate('The extension runs entirely on your device. Your account details and passkeys are securely stored locally using industry-standard encryption.', 'zh-CN'),
    '\u672c\u63d2\u4ef6\u5b8c\u5168\u5728\u672c\u5730\u8fd0\u884c\u3002\u8d26\u53f7\u4fe1\u606f\u548c\u901a\u884c\u5bc6\u94a5\u5747\u4f7f\u7528\u7b26\u5408\u884c\u4e1a\u6807\u51c6\u7684\u52a0\u5bc6\u65b9\u5f0f\u5b89\u5168\u4fdd\u5b58\u5728\u672c\u8bbe\u5907\u4e0a\u3002');
  assert.equal(translate('Optional. Enter this PIN when Duo asks you to verify your identity.', 'zh-CN'),
    '\u53ef\u6309\u9700\u8bbe\u7f6e\u3002Duo \u8981\u6c42\u9a8c\u8bc1\u8eab\u4efd\u65f6\uff0c\u8bf7\u8f93\u5165\u6b64 PIN\u3002');
  assert.equal(translate('If you choose to set up a verification PIN, it will be securely saved on this device using industry-standard encryption and will only be used for sign-in verification.', 'zh-CN'),
    '\u5982\u679c\u60a8\u9009\u62e9\u8bbe\u7f6e\u9a8c\u8bc1 PIN\uff0c\u5b83\u5c06\u4f7f\u7528\u7b26\u5408\u884c\u4e1a\u6807\u51c6\u7684\u52a0\u5bc6\u65b9\u5f0f\u5b89\u5168\u4fdd\u5b58\u5728\u672c\u8bbe\u5907\u4e0a\uff0c\u5e76\u4e14\u4ec5\u7528\u4e8e\u767b\u5f55\u9a8c\u8bc1\u3002');
  assert.equal(translate('Your verification PIN has been securely saved on this device using industry-standard encryption and will only be used for sign-in verification.', 'zh-CN'),
    '\u9a8c\u8bc1 PIN \u5df2\u4f7f\u7528\u7b26\u5408\u884c\u4e1a\u6807\u51c6\u7684\u52a0\u5bc6\u65b9\u5f0f\u5b89\u5168\u4fdd\u5b58\u5728\u672c\u8bbe\u5907\u4e0a\uff0c\u5e76\u4e14\u4ec5\u7528\u4e8e\u767b\u5f55\u9a8c\u8bc1\u3002');
  for (const message of ['Save', 'Duo & passkeys', 'Manual verification', 'Automatic verification',
    'Without a usable passkey for this account, complete Duo verification yourself.',
    "After you confirm sign-in, the assistant uses this account's saved passkey to verify with Duo automatically.",
    'Opening the student sign-in.', 'Opening the Canvas sign-in.', 'The sign-in link has changed. The assistant has stopped.']) {
    assert.notEqual(translate(message, 'zh-CN'), message);
  }
});

test('icon titles and accessible labels update together without replacing the SVG content', async () => {
  const shared = languageStorage();
  const doc = pageDocument();
  const icon = doc.elements.username;
  const power = doc.elements.pin;
  icon.textContent = 'Settings SVG stays intact';
  power.textContent = 'Power SVG stays intact';
  icon.getAttribute = () => 'Settings';
  power.getAttribute = () => 'Sign-in assistant';
  power.setAttribute('aria-checked', 'true');
  const query = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = selector => ['[data-i18n-aria-label]', '[data-i18n-title]'].includes(selector) ? [icon, power] : query(selector);
  const page = createPageLocalization(createLanguagePreference(shared.storage, shared.changes), doc);
  await page.initialize();
  let enabled = true;
  const powerTitle = () => page.t(enabled ? 'On · Click to disable' : 'Off · Click to enable');
  page.bind(power, powerTitle, 'title');
  assert.equal(icon['aria-label'], 'Settings');
  assert.equal(icon.title, 'Settings');
  assert.equal(power.title, 'On · Click to disable');
  await page.setLocale('zh-CN');
  assert.equal(icon['aria-label'], chinese.Settings);
  assert.equal(icon.title, chinese.Settings);
  assert.equal(power['aria-label'], chinese['Sign-in assistant']);
  assert.equal(power.title, chinese['On · Click to disable']);
  assert.equal(power['aria-checked'], 'true');
  enabled = false;
  power.setAttribute('aria-checked', 'false');
  page.bind(power, powerTitle, 'title');
  assert.equal(power.title, chinese['Off · Click to enable']);
  await page.setLocale('en-US');
  assert.equal(icon['aria-label'], 'Settings');
  assert.equal(icon.title, 'Settings');
  assert.equal(power['aria-label'], 'Sign-in assistant');
  assert.equal(power.title, 'Off · Click to enable');
  assert.equal(power['aria-checked'], 'false');
  assert.equal(icon.textContent, 'Settings SVG stays intact');
  assert.equal(power.textContent, 'Power SVG stays intact');
  page.dispose();
});
