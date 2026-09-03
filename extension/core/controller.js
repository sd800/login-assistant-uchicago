import { OKTA_ORIGIN, CONFIRM_TEXT, FLOW_MS, PROMPT_MS, canUseGrant, duoOrigin, liveFlow, validSender, validateAccount, publicCredential, isOktaLoginUrl, entryForUrl, entryTarget, isEntryTransit, HANDOFF_MS, DUO_MATCH, HISTORY_MS, continuesSignInFlow, parseHttps, credentialsForAccount, credentialForAccount, sameAccount, isDuoDeviceManagementUrl } from './policy.js';
import { clearSignInCookies } from './cookies.js';
import { randomId, b64, sha256, utf8 } from './encoding.js';
import { emptyVault, newPin, verifyPin } from './vault.js';
import { checkRequest, createCredential, getAssertion, matchingCredentials } from './passkeys.js';
import { LANGUAGE_KEY, resolveLocale, translate } from './locale.js';
import { SHORTCUT_RULE_ID, SHORTCUT_PAGE, PORTAL_URL, shortcutRule } from './shortcut.js';

const defaults = () => ({ enabled: true, automaticLogin: false, selectedCredentialId: '' });
const emptyState = () => ({ flows: {}, prompts: {}, jobs: {}, setups: {} });
const automatesDuo = (flow, settings) => flow?.duo?.setup === true || (settings.automaticLogin && !['manual', 'repair'].includes(flow?.duo?.phase));
const failure = (name, message) => ({ error: { name, message } });

export class Controller {
  constructor(api, vault, clock = () => Date.now()) {
    this.api = api;
    this.vault = vault;
    this.now = clock;
    this.tail = Promise.resolve();
  }
  exclusive(fn) {
    const task = this.tail.then(async () => {
      this.state = (await this.api.storage.session.get('state')).state || emptyState();
      try { return await fn(); } finally { await this.api.storage.session.set({ state: this.state }); }
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async settings() {
    const { settings = defaults() } = await this.api.storage.local.get('settings');
    return { enabled: settings.enabled !== false, automaticLogin: settings.automaticLogin === true, selectedCredentialId: settings.selectedCredentialId || '' };
  }
  async selectAccountCredential(data, settings) {
    const selected = credentialForAccount(data.credentials, data.username, settings.selectedCredentialId);
    const selectedId = selected?.id || '';
    // Verification mode follows usable account keys, not a saved toggle from
    // older versions. Reconcile only when the derived values have changed.
    const automaticLogin = !!selected;
    if (selectedId !== settings.selectedCredentialId || settings.automaticLogin !== automaticLogin) {
      settings.selectedCredentialId = selectedId;
      settings.automaticLogin = automaticLogin;
      await this.api.storage.local.set({ settings });
    }
    return selected;
  }
  authorizePasskeys(flow, credentials, username, uv) {
    const previous = flow.grant;
    const grant = Array.isArray(previous?.credentials) && Array.isArray(previous?.requests) ? previous : { tabId: flow.tabId, flowId: flow.id, username,
      issuedAt: this.now(), expiresAt: flow.expiresAt, credentials: [], requests: [], uv: false };
    for (const credential of credentials) if (!grant.credentials.some(c => c.id === credential.id)) {
      grant.credentials.push({ id: credential.id, rpId: credential.rpId });
    }
    grant.uv ||= uv;
    flow.grant = grant;
  }
  async persist() { await this.api.storage.session.set({ state: this.state }); }
  async recentHistory() {
    const { history = [] } = await this.api.storage.local.get('history');
    const now = this.now();
    const recent = (Array.isArray(history) ? history : []).filter(item =>
      item && Number.isFinite(item.at) && item.at > now - HISTORY_MS && item.at <= now && typeof item.text === 'string').slice(0, 20);
    if (JSON.stringify(recent) !== JSON.stringify(history)) await this.api.storage.local.set({ history: recent });
    return recent;
  }
  async note(text, params) {
    const history = await this.recentHistory();
    await this.api.storage.local.set({ history: [{ at: this.now(), text, ...(params ? { params } : {}) }, ...history].slice(0, 20) });
  }
  async passkeyFallback(kind, reason, features = []) {
    if (kind === 'create') {
      const messages = {
        enterprise: "Duo requested enterprise attestation. Chrome is handling passkey registration.",
        platform: "Duo requested a built-in authenticator. Chrome is handling passkey registration.",
        algorithm: "Duo did not offer ES256. Chrome is handling passkey registration.",
        extensions: "Duo requested unsupported WebAuthn features. Chrome is handling passkey registration.",
        expired: "Sign-in approval expired before passkey registration. Chrome is handling it.",
        'no-flow': "No active sign-in approval was found for this tab. Chrome is handling passkey registration.",
        'flow-mismatch': "This Duo page was not linked to the approved sign-in. Chrome is handling passkey registration.",
        paused: "The assistant is paused. Chrome is handling Duo passkey registration.",
        mediation: "Duo requested browser-managed passkey creation. Chrome is handling it.",
        'request-limit': "The Duo passkey request exceeded the supported size. Chrome is handling registration.",
        error: "The extension could not process the Duo passkey request. Chrome is handling registration."
      };
      const text = reason === 'extensions' && features.length
        ? "Duo requested unsupported WebAuthn features: {features}. Chrome is handling passkey registration."
        : messages[reason] || messages.error;
      // Recording a fallback must never prevent Chrome from handling the request.
      await this.note(text, reason === 'extensions' && features.length ? { features: features.join(', ') } : undefined).catch(() => {});
    }
    if (kind === 'get') {
      const messages = {
        expired: "Sign-in approval expired before Duo verification. Chrome is handling it.",
        'no-flow': "No active sign-in approval was found for this tab. Chrome is handling Duo verification.",
        'flow-mismatch': "This Duo page was not linked to the approved sign-in. Chrome is handling verification.",
        paused: "The assistant is paused. Chrome is handling Duo verification.",
        'no-match': "No saved passkey matches Duo's request. Chrome is handling verification.",
        'request-limit': "Duo's verification request exceeded the supported size. Chrome is handling it.",
        error: "The extension could not process Duo's verification request. Chrome is handling it."
      };
      const text = reason === 'extensions' && features.length
        ? "Duo requested unsupported WebAuthn features: {features}. Chrome is handling verification."
        : messages[reason] || messages.error;
      await this.note(text, reason === 'extensions' && features.length ? { features: features.join(', ') } : undefined).catch(() => {});
    }
    return { fallback: true };
  }
  ui(sender, pages) {
    if (sender.id !== this.api.runtime.id || !sender.url) return false;
    const url = new URL(sender.url);
    return pages.some(page => `${url.protocol}//${url.host}${url.pathname}` === this.api.runtime.getURL(page));
  }
  requireUI(sender, pages) { if (!this.ui(sender, pages)) throw new Error("Open the extension to use this action."); }
  async frameMatches(sender) {
    const frame = await this.api.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
    return !!frame && (!frame.documentLifecycle || frame.documentLifecycle === 'active') && frame.documentId === sender.documentId && new URL(frame.url).origin === new URL(sender.url).origin;
  }
  async closeWindow(id) { if (id !== undefined) await this.api.windows.remove(id).catch(() => {}); }
  async protectFlowTab(flow) {
    if (!flow || flow.tabProtected) return;
    try {
      const tab = await this.api.tabs.get(flow.tabId);
      flow.restoreAutoDiscardable = tab.autoDiscardable !== false;
      if (flow.restoreAutoDiscardable) await this.api.tabs.update(flow.tabId, { autoDiscardable: false });
      flow.tabProtected = true;
    } catch { /* The tab may have closed while approval was being recorded. */ }
  }
  async releaseFlowTab(flow) {
    if (!flow?.tabProtected) return;
    const restore = flow.restoreAutoDiscardable === true;
    delete flow.tabProtected;
    delete flow.restoreAutoDiscardable;
    if (restore) await this.api.tabs.update(flow.tabId, { autoDiscardable: true }).catch(() => {});
  }
  wakeTargets() {
    return Object.values(this.state.flows).filter(flow => liveFlow(flow, this.now())).map(flow => ({
      tabId: flow.tabId, frameId: 0,
      documentId: flow.stage === 'auth' ? flow.authDocumentId : flow.stage === 'entry' ? flow.documentId : ''
    })).filter(target => target.documentId);
  }
  async showPrompt(prompt) {
    prompt.id = randomId();
    prompt.deadline = this.now() + PROMPT_MS;
    this.state.prompts[prompt.id] = prompt;
    if (prompt.inline) return prompt;
    const window = await this.api.windows.create({
      url: this.api.runtime.getURL(`confirm.html?id=${prompt.id}`),
      type: 'popup', width: 420, height: prompt.kind === 'login' && !prompt.hasPin ? 390 : 540, focused: true
    });
    prompt.windowId = window.id;
    return prompt;
  }
  isShortcutUrl(value) {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname}` === this.api.runtime.getURL(SHORTCUT_PAGE);
    } catch { return false; }
  }
  async shortcutFrame(tabId, documentId) {
    // webNavigation.getFrame() excludes extension pages. Query our own active
    // contexts instead, still binding approval to one top-level tab document.
    const contexts = await this.api.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tabId], frameIds: [0] });
    const current = contexts.filter(context => context.contextType === 'TAB' && context.tabId === tabId && context.frameId === 0);
    if (current.length !== 1 || current[0].documentId !== documentId || !this.isShortcutUrl(current[0].documentUrl)) return null;
    return { documentId: current[0].documentId, url: current[0].documentUrl };
  }
  async hasShortcutAccess() {
    return await this.api.permissions.contains({ origins: ['https://my.uchicago.edu/*'] }) ||
      await this.api.permissions.contains({ origins: ['http://my.uchicago.edu/*'] });
  }
  async syncShortcut() {
    const settings = await this.settings();
    let wanted = false;
    if (settings.enabled && await this.hasShortcutAccess()) {
      // Leave the normal portal available if the account cannot be loaded.
      const data = await this.vault.read().catch(() => null);
      wanted = !!data?.username && !!data?.password;
    }
    const current = await this.api.declarativeNetRequest.getDynamicRules({ ruleIds: [SHORTCUT_RULE_ID] });
    const rule = shortcutRule(), existing = current[0];
    const same = current.length === 1 && existing.priority === rule.priority &&
      existing.action?.type === 'redirect' && existing.action.redirect?.extensionPath === rule.action.redirect.extensionPath &&
      existing.condition?.regexFilter === rule.condition.regexFilter &&
      existing.condition.resourceTypes?.join() === 'main_frame' && existing.condition.requestMethods?.join() === 'get';
    if (wanted ? same : current.length === 0) return;
    await this.api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [SHORTCUT_RULE_ID], addRules: wanted ? [rule] : [] });
  }
  async shortcutPortal(sender) {
    await this.invalidateTab(sender.tab.id);
    this.state.flows[sender.tab.id] = { status: 'cancelled', shortcut: true,
      entryKind: 'myuchicago', documentId: sender.documentId,
      portalCancelUntil: this.now() + HANDOFF_MS, expiresAt: this.now() + HANDOFF_MS };
    return { target: PORTAL_URL };
  }
  async shortcutMessage(message, sender, settings) {
    this.requireUI(sender, [SHORTCUT_PAGE]);
    if (!Number.isInteger(sender.tab?.id) || sender.frameId !== 0 || !sender.documentId) throw new Error("Open the assistant from your UChicago sign-in tab.");
    if ((sender.documentLifecycle && sender.documentLifecycle !== 'active') ||
        !await this.shortcutFrame(sender.tab.id, sender.documentId)) throw new Error("This confirmation page is no longer active. Reload it to try again.");
    if (message.type === 'SHORTCUT_DECIDE' && message.action === 'cancel') return this.shortcutPortal(sender);
    if (!settings.enabled || !await this.hasShortcutAccess()) return this.shortcutPortal(sender);
    if (message.type === 'SHORTCUT_OPEN') {
      const data = await this.vault.read();
      if (!data.username || !data.password) return this.shortcutPortal(sender);
      const result = await this.requestLogin(sender, settings, 'myuchicago', true);
      const flow = this.state.flows[sender.tab.id];
      const prompt = Object.values(this.state.prompts).find(p => p.inline && p.flowId === flow?.id);
      return result.status === 'asking' && prompt ? { ...prompt, hasPin: !!data.pin } : this.shortcutPortal(sender);
    }
    if (message.type !== 'SHORTCUT_DECIDE' || message.action !== 'approve') throw new Error("Unrecognized confirmation action.");
    await this.promptMessage({ ...message, type: 'PROMPT_DECIDE' }, sender, settings, true);
    const flow = this.state.flows[sender.tab.id];
    flow.entryStarted = true; flow.stage = 'handoff'; flow.handoffUntil = this.now() + HANDOFF_MS;
    await this.note("Opening the student sign-in.");
    return { done: true, target: entryTarget('myuchicago') };
  }
  async syncScripts() {
    // Duo hooks now load statically at document_start, before page scripts can
    // cache native methods. Remove persistent registrations from earlier builds.
    const ids = ['duo-main', 'duo-isolated'];
    const registered = await this.api.scripting.getRegisteredContentScripts({ ids });
    const legacy = registered.filter(script => ids.includes(script.id));
    if (legacy.length) await this.api.scripting.unregisterContentScripts({ ids: legacy.map(script => script.id) });
    await this.syncShortcut();
  }
  dispatch(message, sender) { return this.exclusive(() => this.handle(message, sender)); }
  async requestLogin(sender, settings, entryKind = null, inline = false) {
    const flow = this.state.flows[sender.tab.id];
    // A document_start message can arrive before the navigation event.
    if (flow?.shortcut && flow.portalCancelUntil > this.now() && entryKind === 'portal') {
      flow.shortcut = false; flow.entryKind = 'portal'; flow.documentId = sender.documentId;
      delete flow.portalCancelUntil;
      return { status: 'cancelled' };
    }
    if (liveFlow(flow, this.now())) {
      if (!entryKind && (!flow.entryKind || flow.stage === 'auth' ||
          (flow.stage === 'transit' && flow.transitUntil > this.now()) || (flow.entryStarted && flow.handoffUntil > this.now()))) {
        flow.stage = 'auth';
        flow.authOrigin = OKTA_ORIGIN;
        flow.authDocumentId = sender.documentId;
        return { status: 'active' };
      }
      if (entryKind && flow.entryKind === entryKind && flow.documentId === sender.documentId) return { status: 'active' };
    }
    if (flow?.status === 'active') {
      flow.status = 'expired'; flow.grant = null;
      await this.releaseFlowTab(flow);
    }
    if (flow?.documentId === sender.documentId && ['asking', 'cancelled', 'error', 'expired'].includes(flow.status)) return { status: flow.status };
    const data = await this.vault.read();
    if (!data.username || !data.password) return { status: 'needs-setup' };
    const selected = await this.selectAccountCredential(data, settings);
    const intent = this.state.setups?.[sender.tab.id];
    const setup = (typeof intent === 'number' ? intent : intent?.deadline) > this.now() &&
      (typeof intent === 'number' || intent.username === data.username);
    const approvedSetup = setup && intent.approved === true;
    const replacement = !setup && !selected && data.credentials.some(c =>
      c.rejectedAt && sameAccount(c.accountUsername || c.userName, data.username));
    if (this.state.setups) delete this.state.setups[sender.tab.id];
    const guidedSetup = setup || replacement;
    const next = {
      duo: { phase: guidedSetup || (settings.automaticLogin && selected) ? 'start' : 'manual',
        mode: guidedSetup || !selected ? 'enroll' : 'login', setup: guidedSetup, replacement },
      id: randomId(), tabId: sender.tab.id, documentId: sender.documentId,
      entryKind, shortcut: inline, stage: entryKind ? 'entry' : 'auth', authOrigin: entryKind ? '' : OKTA_ORIGIN,
      authDocumentId: sender.documentId, status: approvedSetup ? 'active' : 'asking',
      attempts: {}, expiresAt: this.now() + FLOW_MS
    };
    this.state.flows[sender.tab.id] = next;
    if (approvedSetup) {
      next.expiresAt = intent.deadline;
      this.authorizePasskeys(next, credentialsForAccount(data.credentials, data.username, settings.selectedCredentialId), data.username, false);
      await this.protectFlowTab(next);
      await this.note("Sign-in approved.");
      return { status: 'active' };
    }
    await this.showPrompt({
      kind: 'login', inline, tabId: sender.tab.id, documentId: sender.documentId, flowId: next.id,
      origin: new URL(sender.url).origin, entryKind, title: CONFIRM_TEXT,
      username: data.username, automaticDuo: automatesDuo(next, settings), credentialId: selected?.id, rpId: selected?.rpId,
      credentialName: selected?.userName, requireUV: false, hasPin: !!data.pin
    });
    return { status: 'asking' };
  }
  async handle(message, sender) {
    if (!message || typeof message.type !== 'string' || sender.id !== this.api.runtime.id) throw new Error("Invalid extension message.");
    const settings = await this.settings();
    if (message.type.startsWith('SHORTCUT_')) return this.shortcutMessage(message, sender, settings);
    if (message.type.startsWith('UI_')) {
      this.requireUI(sender, ['settings.html', 'popup.html']);
      return this.uiMessage(message, sender, settings);
    }
    if (message.type.startsWith('PROMPT_')) return this.promptMessage(message, sender, settings);
    const isOkta = validSender(sender, OKTA_ORIGIN) && await this.api.permissions.contains({ origins: [OKTA_ORIGIN + '/*'] });
    const entryKind = entryForUrl(sender.url);
    const isEntry = entryKind && validSender(sender, new URL(sender.url).origin) &&
      await this.api.permissions.contains({ origins: [new URL(sender.url).origin + '/*'] });
    let duoSite = '';
    try { duoSite = duoOrigin(sender.url); } catch { /* Not a supported Duo origin. */ }
    const isDuoPage = duoSite && validSender(sender, duoSite) &&
      await this.api.permissions.contains({ origins: [duoSite + '/*'] });
    const currentFlow = this.state.flows[sender.tab.id];
    const isDuo = !!isDuoPage && liveFlow(currentFlow, this.now()) &&
      currentFlow.authOrigin === duoSite && currentFlow.authDocumentId === sender.documentId;
    if ((!isOkta && !isDuoPage && !isEntry) || !await this.frameMatches(sender)) throw new Error("The page or tab has changed. Return to the sign-in page and try again.");
    const flowFallbackReason = !settings.enabled ? 'paused'
      : currentFlow && currentFlow.expiresAt <= this.now() ? 'expired'
      : !liveFlow(currentFlow, this.now()) ? 'no-flow' : 'flow-mismatch';
    // A report may explain an unapproved request, but grants no credential access.
    if (message.type === 'PK_FALLBACK' && isDuoPage) {
      if (!['create', 'get'].includes(message.kind) || !['flow', 'error', 'mediation'].includes(message.reason) || (message.kind === 'get' && message.reason === 'mediation')) throw new Error("Unsupported message.");
      return this.passkeyFallback(message.kind, message.reason === 'flow' ? flowFallbackReason : message.reason);
    }
    if (isDuoPage && !isDuo) {
      if (message.type === 'PK_BEGIN') return this.passkeyFallback(message.kind, flowFallbackReason);
      if (message.type !== 'STATUS') return { fallback: true };
      return { status: 'outside-flow', active: false, trusted: false,
        pending: settings.enabled && liveFlow(currentFlow, this.now()) && ['auth', 'handoff', 'transit'].includes(currentFlow.stage) };
    }
    if (isOkta && message.type.startsWith('LOGIN_')) {
      const frame = await this.api.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
      if (!isOktaLoginUrl(sender.url) || !isOktaLoginUrl(frame?.url)) return { status: 'not-login', skipped: true };
    }
    if (isEntry) {
      const frame = await this.api.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
      if (entryForUrl(frame?.url) !== entryKind) throw new Error("The page or tab has changed. Return to the sign-in page and try again.");
      if (!['ENTRY_DETECTED', 'ENTRY_STEP', 'FLOW_ERROR'].includes(message.type)) throw new Error("Unsupported message.");
    }
    if (!settings.enabled) return message.type === 'PK_BEGIN' ? this.passkeyFallback(message.kind, 'paused')
      : message.type.startsWith('PK_') ? { fallback: true } : { status: 'disabled' };
    const flow = this.state.flows[sender.tab.id];
    if (isDuo && flow.duo?.phase === 'repair' && !flow.duo.repairPrompted) {
      const data = await this.vault.read();
      await this.offerReplacement(flow, sender, data.username);
    }
    if (message.type === 'STATUS') {
      let identityNotice;
      if (isDuo && flow.duo?.setup && flow.duo.phase === 'identity' && !isDuoDeviceManagementUrl(sender.url)) {
        const stored = await this.api.storage.local.get(LANGUAGE_KEY);
        const locale = resolveLocale(stored[LANGUAGE_KEY], this.api.i18n?.getUILanguage?.());
        identityNotice = { locale, title: translate("Verify with Duo", locale),
          message: translate("Choose a verification method and complete verification. Passkey setup will continue afterward.", locale) };
      }
      return { status: flow?.status || 'idle', active: liveFlow(flow, this.now()), trusted: isDuo, duoMenuHandled: !!flow?.duoMenuHandled,
        duo: flow?.duo ? { phase: flow.duo.phase, mode: flow.duo.mode, automatic: automatesDuo(flow, settings), navigationId: flow.duo.navigationId, identityNotice } : undefined };
    }
    if (message.type === 'DUO_MENU' && isDuo) return this.duoMenu(flow, settings, message.open);
    if (message.type === 'DUO_STEP' && isDuo) return this.duoStep(message, sender, settings);
    if (message.type === 'ENTRY_DETECTED' && entryKind) return this.requestLogin(sender, settings, entryKind);
    if (message.type === 'ENTRY_STEP' && entryKind) {
      if (!liveFlow(flow, this.now()) || flow.entryKind !== entryKind || flow.documentId !== sender.documentId) throw new Error("Confirm this sign-in before continuing.");
      if (flow.entryStarted) return { skipped: true };
      if (flow.stage !== 'entry' || message.target !== entryTarget(entryKind)) throw new Error("The sign-in link has changed. The assistant has stopped.");
      flow.entryStarted = true;
      flow.stage = 'handoff';
      flow.handoffUntil = this.now() + HANDOFF_MS;
      await this.note(entryKind === 'courses' ? "Opening the Canvas sign-in." : "Opening the student sign-in.");
      // Entry pages receive a fixed destination, never account or passkey data.
      return { target: entryTarget(entryKind) };
    }
    if (message.type === 'LOGIN_DETECTED' && isOkta) return this.requestLogin(sender, settings);
    if (message.type === 'LOGIN_READY' && isOkta) {
      return { ready: liveFlow(flow, this.now()) && flow.stage === 'auth' && flow.authDocumentId === sender.documentId &&
        flow.attempts[`${sender.documentId}:${message.step}`] === true, expiresAt: flow?.expiresAt };
    }
    if (message.type === 'LOGIN_STEP' && isOkta) {
      if (!liveFlow(flow, this.now()) || flow.stage !== 'auth') throw new Error("Confirm this sign-in before continuing.");
      if (!['username', 'password', 'combined', 'duo'].includes(message.step)) throw new Error("Unrecognized sign-in step.");
      const key = `${sender.documentId}:${message.step}`;
      const passwordKey = sender.documentId + ':password';
      const usesPassword = ['password', 'combined'].includes(message.step);
      if (flow.attempts[key] || (usesPassword && flow.attempts[passwordKey])) return { skipped: true };
      if (Object.keys(flow.attempts).length >= 8) {
        flow.status = 'error'; flow.grant = null;
        await this.releaseFlowTab(flow);
        throw new Error("The sign-in took too many steps. The assistant has stopped.");
      }
      const data = await this.vault.read();
      if (message.step === 'duo') flow.duoHandoffUntil = this.now() + HANDOFF_MS;
      flow.attempts[key] = true;
      if (usesPassword) flow.attempts[passwordKey] = true;
      await this.note(`Continuing sign-in: ${{ username: 'username', password: 'password', combined: 'username and password', duo: 'Duo redirect' }[message.step]}.`);
      return { username: ['username', 'combined'].includes(message.step) ? data.username : undefined, password: ['password', 'combined'].includes(message.step) ? data.password : undefined };
    }
    if (message.type === 'FLOW_ERROR') {
      if (flow) {
        flow.status = 'error'; flow.grant = null;
        await this.releaseFlowTab(flow);
      }
      await this.note("The assistant stopped because of a page error or an unsupported step. Check the sign-in page.");
      return { status: 'error' };
    }
    if (message.type === 'PK_BEGIN' && isDuo) return this.beginPasskey(message, sender, settings);
    if (['PK_DELIVERED', 'PK_REJECTED'].includes(message.type) && isDuo) return this.passkeyOutcome(message, sender, settings);
    if (['PK_POLL', 'PK_CANCEL'].includes(message.type) && isDuo) {
      const job = this.state.jobs[message.id];
      if (!job || job.tabId !== sender.tab.id || job.documentId !== sender.documentId) return failure('NotAllowedError', "This authentication request is no longer available.");
      if (message.type === 'PK_CANCEL') {
        await this.cancelJob(job.id);
        return { cancelled: true };
      }
      if (job.deadline <= this.now()) await this.cancelJob(job.id);
      return job.result || { pending: true };
    }
    throw new Error("Unsupported message.");
  }
  async uiMessage(message, sender, settings) {
    const data = await this.vault.read();
    if (message.type === 'UI_GET') {
      const selected = await this.selectAccountCredential(data, settings);
      return { ...settings, canAutomate: !!selected, username: data.username, hasPassword: !!data.password, hasPin: !!data.pin, credentials: data.credentials.map(publicCredential), history: await this.recentHistory() };
    }
    if (['UI_SAVE', 'UI_SAVE_ACCOUNT', 'UI_SAVE_SETTINGS'].includes(message.type)) {
      this.requireUI(sender, ['settings.html']);
      const saveAccount = message.type !== 'UI_SAVE_SETTINGS';
      const saveSettings = message.type !== 'UI_SAVE_ACCOUNT';
      if (message.type === 'UI_SAVE_ACCOUNT' && typeof message.username === 'string' &&
          message.username.trim() !== data.username && !message.password) {
        throw new Error("Enter a password when changing accounts.");
      }
      const account = saveAccount ? validateAccount(message.username, message.password || data.password) : null;
      const changedAccount = !!account && account.username !== data.username;
      let next = { ...settings };
      if (saveSettings) {
        if (message.selectedCredentialId && !data.credentials.some(c => c.id === message.selectedCredentialId)) throw new Error("The selected passkey is no longer available.");
        if (message.automaticLogin !== undefined && typeof message.automaticLogin !== 'boolean') throw new Error("Choose whether to use automatic sign-in.");
        next = { ...settings, enabled: message.type === 'UI_SAVE' ? message.enabled === true : settings.enabled,
          automaticLogin: message.automaticLogin ?? settings.automaticLogin,
          selectedCredentialId: message.selectedCredentialId ?? settings.selectedCredentialId };
      }
      if (changedAccount) next.selectedCredentialId = '';
      const selected = credentialForAccount(data.credentials, account?.username || data.username, next.selectedCredentialId);
      if (message.automaticLogin === true && !selected) throw new Error("Add a passkey for the saved account before choosing automatic verification.");
      next.automaticLogin = !!selected;
      next.selectedCredentialId = selected?.id || '';
      if (saveAccount) await this.vault.write({ ...data, ...account });
      if (saveSettings || changedAccount || next.automaticLogin !== settings.automaticLogin ||
          next.selectedCredentialId !== settings.selectedCredentialId) await this.api.storage.local.set({ settings: next });
      await this.invalidateAll();
      if (saveSettings) await this.syncScripts(); else await this.syncShortcut();
      return { saved: true };
    }
    if (message.type === 'UI_SETUP_PASSKEY') {
      this.requireUI(sender, ['settings.html']);
      if (!settings.enabled) throw new Error("Enable the assistant before adding a passkey.");
      if (!data.username || !data.password) throw new Error("Save your account before adding a passkey.");
      if (credentialForAccount(data.credentials, data.username, settings.selectedCredentialId)) return { available: true };
      if (!Object.values(this.state.prompts).some(p => p.kind === 'setup' && p.username === data.username && p.deadline > this.now())) {
        await this.showPrompt({ kind: 'setup', username: data.username, requireUV: false });
      }
      return { asking: true };
    }
    if (message.type === 'UI_PIN') {
      this.requireUI(sender, ['settings.html']);
      if (data.pin && !await this.checkPin(message.oldPin, data.pin)) throw new Error("The current verification PIN is incorrect.");
      data.pin = message.newPin ? await newPin(message.newPin) : null;
      await this.vault.write(data);
      await this.invalidateAll();
      return { saved: true };
    }
    if (message.type === 'UI_DELETE') {
      this.requireUI(sender, ['settings.html']);
      data.credentials = data.credentials.filter(c => c.id !== message.id);
      await this.vault.write(data);
      await this.selectAccountCredential(data, settings);
      await this.invalidateAll();
      return { deleted: true };
    }
    if (message.type === 'UI_CLEAR') {
      this.requireUI(sender, ['settings.html']);
      await this.vault.write(emptyVault());
      await this.invalidateAll();
      await this.api.storage.local.set({ settings: defaults(), history: [], suggestedDuoOrigin: '', pinGuard: {}, [LANGUAGE_KEY]: null });
      await this.syncScripts();
      return { deleted: true };
    }
    if (message.type === 'UI_RETRY') {
      const tab = await this.api.tabs.get(message.tabId);
      const shortcut = this.isShortcutUrl(tab.url);
      if (!shortcut && !isOktaLoginUrl(tab.url) && !entryForUrl(tab.url)) throw new Error("Open the assistant from your UChicago sign-in tab.");
      await this.invalidateTab(tab.id);
      if (shortcut) await this.api.tabs.reload(tab.id);
      else await this.api.tabs.sendMessage(tab.id, { type: 'RECHECK' });
      return { started: true };
    }
    if (message.type === 'UI_TOGGLE') {
      await this.api.storage.local.set({ settings: { ...settings, enabled: message.enabled === true } });
      await this.invalidateAll();
      await this.syncScripts();
      return { saved: true };
    }
    throw new Error("Unrecognized extension action.");
  }
  async checkPin(value, record) {
    const { pinGuard = {} } = await this.api.storage.local.get('pinGuard');
    if (pinGuard.until > this.now()) throw new Error("Too many incorrect PIN attempts. Try again in 5 minutes.");
    const correct = await verifyPin(value, record);
    if (correct) { await this.api.storage.local.set({ pinGuard: {} }); return true; }
    const count = (pinGuard.until ? 0 : pinGuard.count || 0) + 1;
    await this.api.storage.local.set({ pinGuard: count >= 5 ? { count: 0, until: this.now() + 300_000 } : { count } });
    return false;
  }
  duoMenu(flow, settings, open) {
    if (!automatesDuo(flow, settings) || !['start', 'menu', 'returning'].includes(flow.duo?.phase)) return { click: false };
    // Authorizing a click is not proof that the menu appeared. The content
    // script clicks once per document and acknowledges the visible menu later.
    if (open === true) return { click: !flow.duoMenuHandled };
    if (open !== false) return { click: false };
    if (flow.duo.phase === 'returning') flow.duo.mode = 'login';
    flow.duoMenuHandled = true;
    flow.duo.phase = 'menu';
    return { click: false, phase: 'menu' };
  }
  async duoStep(message, sender, settings) {
    const flow = this.state.flows[sender.tab.id];
    const duo = flow.duo;
    if (!duo) return { click: false };
    // The caller has already passed the active-flow, current-document, and site checks.
    if (message.step === 'remember-device') return { click: true };
    if (!automatesDuo(flow, settings)) return { click: false };
    const manager = isDuoDeviceManagementUrl(sender.url);
    const sameManager = manager && duo.managerOrigin === new URL(sender.url).origin;
    const keys = message.keys;
    const validKeys = Array.isArray(keys) && keys.length <= 100 &&
      keys.every(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key));
    const move = (phase, click = false) => { duo.phase = phase; return { click, phase }; };
    if (message.step === 'key-selected' && !manager && ['start', 'menu', 'returning'].includes(duo.phase)) {
      flow.duoMenuHandled = true;
      await this.note("Choosing Security key for sign-in.").catch(() => {});
      return move('authenticating');
    }
    if (message.step === 'identity' && ['start', 'menu'].includes(duo.phase)) {
      flow.duoMenuHandled = true;
      await this.note("Complete Duo's identity check to manage devices. The assistant will wait.").catch(() => {});
      return move('identity');
    }
    if (message.step === 'manage' && duo.phase === 'menu' && duo.mode === 'enroll' && !manager) {
      await this.note("Opening Manage devices. Complete the identity check in Duo.").catch(() => {});
      return move('identity', true);
    }
    if (message.step === 'inventory' && ['start', 'menu', 'identity'].includes(duo.phase) &&
        duo.mode === 'enroll' && manager && validKeys) {
      duo.baseline = [...keys]; duo.managerOrigin = new URL(sender.url).origin;
      return move('devices');
    }
    if (message.step === 'add-device' && duo.phase === 'devices' && sameManager) return move('choose-device', true);
    if (message.step === 'security-key' && duo.phase === 'choose-device' && sameManager) return move('setup-key', true);
    if (message.step === 'register' && duo.phase === 'setup-key' && sameManager) return move('registering', true);
    if (message.step === 'registered' && duo.phase === 'registering' && sameManager && validKeys &&
        duo.pendingCredentialId && Array.isArray(duo.baseline)) {
      const remaining = [...keys];
      for (const previous of duo.baseline) {
        const index = remaining.indexOf(previous);
        if (index < 0) return { click: false };
        remaining.splice(index, 1);
      }
      // Require one new security-key card, after this flow created its own local credential.
      if (remaining.length !== 1) return { click: false };
      const data = await this.vault.read();
      const credential = data.credentials.find(c => c.id === duo.pendingCredentialId && c.registrationPending);
      if (!credential) return { click: false };
      credential.registrationPending = false;
      credential.registrationConfirmedAt = this.now();
      await this.vault.write(data);
      settings.selectedCredentialId = credential.id;
      settings.automaticLogin = true;
      await this.api.storage.local.set({ settings });
      await this.note("Passkey setup is complete. Automatic verification is now on.").catch(() => {});
      return move('registered');
    }
    if (message.step === 'back' && duo.phase === 'registered' && sameManager) {
      flow.duoMenuHandled = false;
      await this.note("Returning to sign-in with the new security key.").catch(() => {});
      return move('returning', true);
    }
    if (message.step === 'login-menu' && duo.phase === 'returning' && !manager) {
      return this.duoMenu(flow, settings, message.open);
    }
    if (message.step === 'login-key' && duo.phase === 'menu' && duo.mode === 'login' && !manager) {
      return { click: true };
    }
    return { click: false };
  }
  async offerReplacement(flow, sender, username) {
    flow.grant = null;
    flow.duo = { ...flow.duo, phase: 'repair', setup: false, repairPrompted: true };
    const prompt = await this.showPrompt({ kind: 'repair', tabId: flow.tabId, documentId: sender.documentId,
      flowId: flow.id, origin: new URL(sender.url).origin, username, allowEnrollment: true,
      notice: "Your saved passkey is no longer valid. Add a new one for one-click sign-in? You can cancel and verify with Duo yourself." });
    prompt.deadline = Math.min(prompt.deadline, flow.expiresAt);
  }
  releaseDuo(prompt) {
    const flow = this.state.flows[prompt.tabId];
    if (!flow || flow.id !== prompt.flowId) return;
    flow.grant = null;
    flow.duo = { ...flow.duo, phase: 'manual', setup: false, repairPrompted: true };
    for (const job of Object.values(this.state.jobs)) if (job.flowId === flow.id && !job.result) {
      job.result = { fallback: true, manual: true };
    }
  }
  async passkeyOutcome(message, sender, settings) {
    const flow = this.state.flows[sender.tab.id];
    const job = this.state.jobs[message.id];
    if (!job || job.deadline <= this.now() || job.kind !== 'get' || job.fallbackOnly || job.tabId !== sender.tab.id ||
        job.documentId !== sender.documentId || job.flowId !== flow.id || flow.lastPasskeyJobId !== job.id || !job.result?.response || !job.credentialId) return { recorded: false };
    if (message.type === 'PK_DELIVERED') {
      if (job.stage !== 'generated') return { recorded: false };
      job.stage = 'delivered'; job.deliveredAt = this.now();
      await this.note("Passkey response handed to the Duo page. Its verification result is not yet known.").catch(() => {});
      return { recorded: true };
    }
    if (message.reason !== 'not-registered' || job.stage !== 'delivered') return { recorded: false };
    const data = await this.vault.read();
    const credential = data.credentials.find(item => item.id === job.credentialId);
    if (!credential) return { recorded: false };
    // Only an explicit page rejection after delivery can disable automatic use.
    // Timeouts, cancellations, missing allow-list entries, and DOM inventory gaps cannot.
    credential.rejectedAt = this.now();
    credential.accountUsername ||= data.username;
    await this.vault.write(data);
    job.stage = 'rejected';
    await this.selectAccountCredential(data, settings);
    await this.offerReplacement(flow, sender, data.username);
    await this.note("Duo reported that the delivered security key is not registered. Automatic use of that key is paused.").catch(() => {});
    return { recorded: true };
  }
  async passkeyUnavailable(message, sender, settings, reason, features = []) {
    if (message.kind !== 'get' || !automatesDuo(this.state.flows[sender.tab.id], settings)) return this.passkeyFallback(message.kind, reason, features);
    if (this.state.flows[sender.tab.id]?.duo?.phase === 'identity') return { ...await this.passkeyFallback(message.kind, reason, features), manual: true };
    const flow = this.state.flows[sender.tab.id];
    const notice = reason === 'no-match'
      ? "This request does not match a saved passkey. That alone does not mean your key was deleted. You can add a new passkey or use another provider."
      : "This Duo request needs a feature this extension does not support. Choose another passkey provider to continue.";
    const job = { id: randomId(), kind: 'get', fallbackOnly: true, origin: duoOrigin(sender.url),
      flowId: flow.id, tabId: sender.tab.id, documentId: sender.documentId,
      deadline: Math.min(flow.expiresAt, this.now() + Math.min(PROMPT_MS, Math.max(1_000, Number(message.options?.timeout) || PROMPT_MS))) };
    this.state.jobs[job.id] = job;
    const prompt = await this.showPrompt({ kind: 'get', jobId: job.id, tabId: job.tabId,
      documentId: job.documentId, choices: [], requireUV: false, fallbackOnly: true, allowEnrollment: reason === 'no-match', notice });
    prompt.deadline = Math.min(prompt.deadline, job.deadline);
    await this.note(reason === 'extensions' && features.length
      ? "Duo requested unsupported WebAuthn features: {features}. Waiting for a provider choice."
      : notice, reason === 'extensions' && features.length ? { features: features.join(', ') } : undefined).catch(() => {});
    return { id: job.id, pending: true };
  }
  async beginPasskey(message, sender, settings) {
    const flow = this.state.flows[sender.tab.id];
    const phase = flow.duo?.phase;
    const automatic = automatesDuo(flow, settings);
    if (message.kind === 'get') delete flow.lastPasskeyJobId;
    if (phase === 'repair') return { defer: true };
    if (message.kind === 'get' && !automatic) return { fallback: true, manual: true };
    const switching = message.kind === 'get' && automatic && ['start', 'menu', 'returning'].includes(phase);
    if (Object.values(this.state.jobs).some(j => j.tabId === sender.tab.id && !j.result && j.deadline > this.now())) return failure('NotAllowedError', "Another authentication request is already waiting for approval.");
    // Identity checks without a usable local key stay with the user's provider.
    if (phase === 'identity' && message.kind !== 'get') return { fallback: true };
    if (!['create', 'get'].includes(message.kind) || JSON.stringify(message.options || {}).length > 65_536) return this.passkeyUnavailable(message, sender, settings, 'request-limit');
    await this.note(message.kind === 'create' ? "Duo passkey registration request received." : "Duo passkey verification request intercepted.").catch(() => {});
    const origin = duoOrigin(sender.url);
    if (message.browserManaged === true) return switching ? { defer: true } : this.passkeyUnavailable(message, sender, settings, 'mediation');
    let request;
    try { request = checkRequest(message.kind, message.options, origin, origin); }
    catch (error) { return error.name === 'NotSupportedError'
      ? switching ? { defer: true } : this.passkeyUnavailable(message, sender, settings, error.reason, error.features) : failure(error.name, error.message); }
    const data = await this.vault.read();
    const choices = message.kind === 'get' ? matchingCredentials(message.options, request.rpId, data.credentials.filter(c => !c.registrationPending && !c.rejectedAt)) : [];
    const selected = credentialForAccount(choices, data.username, settings.selectedCredentialId);
    if (switching && (!selected || flow.duo.mode === 'enroll')) return { defer: true };
    if (phase === 'identity' && !selected) return { fallback: true, manual: true };
    if (message.kind === 'get' && !selected) return this.passkeyUnavailable(message, sender, settings, 'no-match');
    if (message.kind === 'create' && data.credentials.length >= 20) return failure('NotAllowedError', "You have reached the limit of 20 saved passkeys. Delete an unused passkey before adding another.");
    const job = { id: randomId(), kind: message.kind, options: message.options, origin, flowId: flow.id, tabId: sender.tab.id, documentId: sender.documentId, deadline: Math.min(flow.expiresAt, this.now() + Math.min(PROMPT_MS, Math.max(1_000, Number(message.options.timeout) || PROMPT_MS))), ...request };
    this.state.jobs[job.id] = job;
    if (switching && selected) flow.duo.phase = 'authenticating';
    if (selected) choices.sort((a, b) => Number(b.id === selected.id) - Number(a.id === selected.id));
    if (job.kind === 'get' && automatic && selected) {
      const scope = { tabId: job.tabId, flowId: flow.id, rpId: job.rpId, credentialId: selected.id,
        username: data.username, requireUV: false, now: this.now() };
      if (!canUseGrant(flow.grant, scope)) {
        job.result = failure('NotAllowedError', "Start a new school sign-in to approve this passkey.");
        return { id: job.id, ...job.result };
      }
      if (canUseGrant(flow.grant, { ...scope, requireUV: job.requireUV })) {
        const fingerprint = b64(await sha256(utf8(job.rpId + ':' + job.options.challenge)));
        if (flow.grant.requests.includes(fingerprint) || flow.grant.requests.length >= 12) {
          job.result = failure('NotAllowedError', "This sign-in cannot process another copy of this request. Start a new school sign-in.");
          return { id: job.id, ...job.result };
        }
        flow.grant.requests.push(fingerprint);
        await this.executeJob(job, selected.id, { up: true, uv: flow.grant.uv === true }, settings);
        return { id: job.id, ...job.result };
      }
    }
    const prompt = await this.showPrompt({ kind: job.kind, jobId: job.id, tabId: job.tabId, documentId: job.documentId, rpId: job.rpId, username: job.kind === 'create' ? job.options.user.name : undefined, choices: choices.map(publicCredential), credentialId: selected?.id, requireUV: job.requireUV });
    prompt.deadline = Math.min(prompt.deadline, job.deadline);
    return { id: job.id, pending: true };
  }
  async executeJob(job, credentialId, proof, settings) {
    if (job.started) throw new Error("This request has already started and cannot be signed again.");
    job.started = true;
    // Persist the accepted challenge and started state before cryptography. A
    // terminated worker must never sign the same operation a second time.
    await this.persist();
    try {
      const frame = await this.api.webNavigation.getFrame({ tabId: job.tabId, frameId: 0 });
      const flow = this.state.flows[job.tabId];
      if (!liveFlow(flow, this.now()) || flow.id !== job.flowId || flow.authOrigin !== job.origin ||
          flow.authDocumentId !== job.documentId || !await this.api.permissions.contains({ origins: [job.origin + '/*'] }) ||
          !frame || frame.documentId !== job.documentId || new URL(frame.url).origin !== job.origin || job.deadline <= this.now()) throw new Error("The page or authentication request has expired.");
      const data = await this.vault.read();
      if (job.kind === 'create') {
        const result = await createCredential({ options: job.options, origin: job.origin, configuredOrigin: job.origin, credentials: data.credentials, proof });
        result.credential.accountUsername = data.username;
        const enrollment = flow.duo && Array.isArray(flow.duo.baseline) &&
          flow.duo.managerOrigin === job.origin && ['devices', 'choose-device', 'setup-key', 'registering'].includes(flow.duo.phase);
        if (enrollment) result.credential.registrationPending = true;
        data.credentials.push(result.credential);
        await this.vault.write(data); // Persist key before returning a registration response.
        if (enrollment) {
          flow.duo.pendingCredentialId = result.credential.id;
          flow.duo.phase = 'registering';
        }
        if (automatesDuo(flow, settings)) this.authorizePasskeys(flow, [result.credential], data.username, proof.uv === true);
        job.result = { response: result.response };
        await this.note("Passkey saved locally. Waiting for Duo to finish registration.").catch(() => {});
      } else {
        const credential = data.credentials.find(c => c.id === credentialId);
        if (!credential) throw new Error("The selected passkey could not be found.");
        const result = await getAssertion({ options: job.options, origin: job.origin, configuredOrigin: job.origin, credential, proof });
        data.credentials = data.credentials.map(c => c.id === credential.id ? result.credential : c);
        await this.vault.write(data); // Persist counter before delivering the assertion.
        flow.lastPasskeyJobId = job.id;
        job.credentialId = credential.id;
        job.stage = 'generated';
        job.result = { response: result.response };
        await this.note("Passkey response generated. Waiting for Duo to accept it.").catch(() => {});
      }
    } catch (error) { job.result = failure(error.name || 'NotAllowedError', error.message); }
  }
  async promptMessage(message, sender, settings, inline = false) {
    this.requireUI(sender, inline ? [SHORTCUT_PAGE] : ['confirm.html']);
    const id = inline ? message.id : new URL(sender.url).searchParams.get('id');
    if (message.id !== id) throw new Error("This confirmation window does not match the request.");
    const prompt = this.state.prompts[id];
    if (!prompt || prompt.deadline <= this.now()) throw new Error("This confirmation has expired. Return to the sign-in page and try again.");
    if (!!prompt.inline !== inline || (inline && (prompt.tabId !== sender.tab.id || prompt.documentId !== sender.documentId))) throw new Error("This confirmation window does not match the request.");
    const data = await this.vault.read();
    if (message.type === 'PROMPT_GET') return { ...prompt, hasPin: !!data.pin };
    if (message.type !== 'PROMPT_DECIDE' || !['approve', 'cancel', 'fallback', 'enroll'].includes(message.action)) throw new Error("Unrecognized confirmation action.");
    if (message.action === 'fallback' && ['repair', 'setup'].includes(prompt.kind)) throw new Error("Unrecognized confirmation action.");
    if (['cancel', 'fallback'].includes(message.action)) {
      if (prompt.kind === 'repair') this.releaseDuo(prompt);
      if (prompt.kind === 'login') {
        const flow = this.state.flows[prompt.tabId];
        if (flow) {
          flow.status = 'cancelled'; flow.grant = null;
          await this.releaseFlowTab(flow);
        }
      } else {
        const job = this.state.jobs[prompt.jobId];
        if (job) job.result = message.action === 'fallback' ? { fallback: true, explicit: true } : failure('NotAllowedError', "Canceled by the user.");
      }
      delete this.state.prompts[id];
      return { done: true };
    }
    if (prompt.kind === 'setup') {
      if (message.action !== 'approve' || !settings.enabled || prompt.username !== data.username || !data.password) {
        throw new Error("Your saved account or settings changed. Start passkey setup again.");
      }
      if (credentialForAccount(data.credentials, data.username, settings.selectedCredentialId)) {
        delete this.state.prompts[id]; return { done: true };
      }
      await clearSignInCookies(this.api);
      if (prompt.deadline <= this.now()) throw new Error("This confirmation has expired. Return to the sign-in page and try again.");
      // Cookie preparation finishes before navigation. Bind this consent to
      // one new tab and account, leaving ordinary sign-ins unchanged.
      const tab = await this.api.tabs.create({ url: PORTAL_URL, active: true });
      this.state.setups ||= {};
      this.state.setups[tab.id] = { deadline: this.now() + FLOW_MS, username: data.username, approved: true };
      delete this.state.prompts[id];
      return { done: true };
    }
    if (prompt.fallbackOnly && message.action === 'approve') throw new Error("Use another passkey provider or cancel this request.");
    const frame = inline ? await this.shortcutFrame(prompt.tabId, prompt.documentId)
      : await this.api.webNavigation.getFrame({ tabId: prompt.tabId, frameId: 0 });
    const expectedOrigin = ['login', 'repair'].includes(prompt.kind) ? prompt.origin || OKTA_ORIGIN : this.state.jobs[prompt.jobId]?.origin;
    if (!frame || frame.documentId !== prompt.documentId || new URL(frame.url).origin !== expectedOrigin) throw new Error(inline
      ? "This confirmation page is no longer active. Reload it to try again."
      : "The sign-in page has changed. Close this window and try again.");
    if (prompt.kind === 'login' && (inline ? !this.isShortcutUrl(frame.url) : prompt.entryKind ? entryForUrl(frame.url) !== prompt.entryKind : !isOktaLoginUrl(frame.url))) throw new Error("The sign-in page has changed. Close this window and try again.");
    if (inline ? !await this.hasShortcutAccess() : !await this.api.permissions.contains({ origins: [expectedOrigin + '/*'] })) throw new Error("The sign-in page has changed. Close this window and try again.");
    if (message.action === 'enroll' || (prompt.kind === 'repair' && message.action === 'approve')) {
      const flow = this.state.flows[prompt.tabId];
      const flowId = prompt.flowId || this.state.jobs[prompt.jobId]?.flowId;
      if (!prompt.allowEnrollment || !liveFlow(flow, this.now()) || flow.id !== flowId) throw new Error("This sign-in request has expired.");
      for (const job of Object.values(this.state.jobs)) if (job.tabId === prompt.tabId && !job.result) await this.cancelJob(job.id);
      flow.grant = null;
      flow.duoMenuHandled = false;
      flow.duo = { phase: 'start', mode: 'enroll', setup: true, navigationId: randomId() };
      delete this.state.prompts[id];
      await this.note("Starting passkey setup. Existing local keys have not been deleted.").catch(() => {});
      return { done: true };
    }
    let uv = false;
    if (message.pin) {
      uv = await this.checkPin(message.pin, data.pin);
      if (!uv) throw new Error("Incorrect verification PIN. Try again.");
    }
    if (prompt.requireUV && !uv) throw new Error(data.pin ? "Enter your verification PIN." : "Identity verification is required. Use another passkey provider, or set a verification PIN in settings.");
    if (prompt.kind === 'login') {
      const flow = this.state.flows[prompt.tabId];
      if (flow?.id !== prompt.flowId || flow.status !== 'asking') throw new Error("This sign-in request has expired.");
      flow.status = 'active';
      flow.expiresAt = this.now() + FLOW_MS;
      flow.grant = null;
      if (automatesDuo(flow, settings)) this.authorizePasskeys(flow, credentialsForAccount(data.credentials, data.username, settings.selectedCredentialId), data.username, uv);
      await this.protectFlowTab(flow);
      await this.note("Sign-in approved.");
    } else {
      const job = this.state.jobs[prompt.jobId];
      if (!job || job.started || job.result || job.deadline <= this.now()) throw new Error("This authentication request has expired.");
      if (job.kind === 'get' && !prompt.choices.some(c => c.id === message.credentialId)) throw new Error("Choose a matching passkey.");
      if (job.kind === 'get') {
        const flow = this.state.flows[job.tabId];
        if (flow?.grant && uv) flow.grant.uv = true;
        if (flow?.grant) {
          const fingerprint = b64(await sha256(utf8(job.rpId + ':' + job.options.challenge)));
          if (flow.grant.requests.includes(fingerprint) || flow.grant.requests.length >= 12) throw new Error("This sign-in cannot process another copy of this request. Start a new school sign-in.");
          flow.grant.requests.push(fingerprint);
        }
      }
      delete this.state.prompts[id];
      await this.executeJob(job, message.credentialId, { up: true, uv }, settings);
    }
    delete this.state.prompts[id];
    if (prompt.kind === 'login' && !inline) {
      await this.persist();
      // Do not await a content script that may immediately message this worker.
      void this.api.tabs.sendMessage(prompt.tabId, { type: 'LOGIN_APPROVED' }, { documentId: prompt.documentId }).catch(() => {});
    }
    return { done: true };
  }
  async cancelJob(id) {
    const job = this.state.jobs[id];
    if (job && !job.result) job.result = failure('NotAllowedError', "This authentication request was canceled or has expired.");
    for (const [key, prompt] of Object.entries(this.state.prompts)) {
      if (prompt.jobId === id) { delete this.state.prompts[key]; await this.closeWindow(prompt.windowId); }
    }
  }
  async invalidateTab(tabId) {
    const flow = this.state.flows[tabId];
    await this.releaseFlowTab(flow);
    delete this.state.flows[tabId];
    if (this.state.setups) delete this.state.setups[tabId];
    for (const [id, job] of Object.entries(this.state.jobs)) if (job.tabId === tabId) { await this.cancelJob(id); delete this.state.jobs[id]; }
    for (const [id, prompt] of Object.entries(this.state.prompts)) if (prompt.tabId === tabId) { delete this.state.prompts[id]; await this.closeWindow(prompt.windowId); }
  }
  async invalidateAll() {
    for (const flow of Object.values(this.state.flows)) await this.releaseFlowTab(flow);
    for (const prompt of Object.values(this.state.prompts)) await this.closeWindow(prompt.windowId);
    this.state = emptyState();
  }
  navigation(details) {
    return this.exclusive(async () => {
      if (details.frameId !== 0) return;
      const frame = await this.api.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 });
      if (!frame || frame.documentId !== details.documentId ||
          (frame.documentLifecycle && frame.documentLifecycle !== 'active')) return;
      if (frame.url !== details.url) {
        // Duo can update its history before a queued navigation event is handled.
        // Preserve that event's redirect evidence only for the same active
        // document and Duo origin; other documents and origins still fail closed.
        try { if (duoOrigin(frame.url) !== duoOrigin(details.url)) return; }
        catch { return; }
      }
      const settings = await this.settings();
      const flow = this.state.flows[details.tabId];
      for (const [id, job] of Object.entries(this.state.jobs)) if (job.tabId === details.tabId && job.documentId !== details.documentId) { await this.cancelJob(id); delete this.state.jobs[id]; }
      if (!flow) return;
      if (!settings.enabled) { await this.invalidateTab(details.tabId); return; }
      let origin;
      try { origin = new URL(details.url).origin; } catch { origin = ''; }
      if (flow.status !== 'active') {
        if (flow.shortcut && flow.portalCancelUntil > this.now() && entryForUrl(details.url) === 'portal') {
          flow.shortcut = false; flow.entryKind = 'portal'; flow.documentId = details.documentId;
          delete flow.portalCancelUntil; return;
        }
        const samePage = flow.shortcut ? this.isShortcutUrl(details.url) : flow.entryKind ? entryForUrl(details.url) === flow.entryKind : isOktaLoginUrl(details.url);
        if (flow.documentId !== details.documentId || !samePage) await this.invalidateTab(details.tabId);
        return;
      }
      if (!liveFlow(flow, this.now())) { await this.invalidateTab(details.tabId); return; }
      if ((details.transitionQualifiers || []).some(value => ['from_address_bar', 'forward_back'].includes(value)) ||
          ['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated'].includes(details.transitionType)) {
        await this.invalidateTab(details.tabId); return;
      }
      if (flow.stage === 'entry') {
        if (flow.documentId === details.documentId && (flow.shortcut ? this.isShortcutUrl(details.url) : entryForUrl(details.url) === flow.entryKind)) return;
        await this.invalidateTab(details.tabId); return;
      }
      const handoff = flow.stage === 'handoff' && flow.entryStarted && flow.handoffUntil > this.now();
      if ((flow.stage === 'handoff' && !handoff) || (flow.stage === 'transit' && flow.transitUntil <= this.now())) { await this.invalidateTab(details.tabId); return; }
      if (origin === OKTA_ORIGIN && isOktaLoginUrl(details.url)) {
        flow.stage = 'auth'; flow.authOrigin = origin; flow.authDocumentId = details.documentId; return;
      }
      if (handoff && isEntryTransit(flow.entryKind, details.url)) return;
      let detected = '';
      try { detected = duoOrigin(details.url); } catch { /* Ignore unrelated or malformed destinations. */ }
      const qualifiers = details.transitionQualifiers || [];
      const sameDuo = detected && flow.authOrigin === detected && flow.stage === 'auth' &&
        !qualifiers.some(value => ['from_address_bar', 'forward_back'].includes(value)) &&
        !['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated'].includes(details.transitionType);
      if (detected && (sameDuo || continuesSignInFlow(flow, details, this.now()))) {
        if (!await this.api.permissions.contains({ origins: [detected + '/*'] })) {
          await this.invalidateTab(details.tabId);
          await this.note("Allow Duo site access in Chrome, then start the school sign-in again.");
          return;
        }
        const changedHost = flow.authOrigin !== detected;
        flow.stage = 'auth'; flow.authOrigin = detected; flow.authDocumentId = details.documentId;
        if (changedHost) await this.note("Continuing Duo verification for this school sign-in.");
        return;
      }
      if (continuesSignInFlow(flow, details, this.now())) {
        try {
          parseHttps(details.url);
          // Observe intermediate and final destinations without granting them any
          // credential access. No hostname can prove that sign-in succeeded.
          if (flow.stage !== 'transit') flow.transitUntil = Math.min(flow.expiresAt, this.now() + HANDOFF_MS);
          flow.stage = 'transit';
          flow.authOrigin = '';
          flow.authDocumentId = '';
          return;
        } catch { /* Unsupported destinations end the automatic flow. */ }
      }
      await this.invalidateTab(details.tabId);
      await this.note("Automatic sign-in steps ended. Check the destination site to confirm sign-in.");
    });
  }
  windowClosed(windowId) {
    return this.exclusive(async () => {
      for (const [id, prompt] of Object.entries(this.state.prompts)) if (prompt.windowId === windowId) {
        if (prompt.kind === 'repair') this.releaseDuo(prompt);
        if (prompt.kind === 'login') {
          const flow = this.state.flows[prompt.tabId];
          if (flow) {
            flow.status = 'cancelled'; flow.grant = null;
            await this.releaseFlowTab(flow);
          }
        } else {
          const job = this.state.jobs[prompt.jobId];
          if (job && !job.result) job.result = failure('NotAllowedError', "The confirmation window was closed.");
        }
        delete this.state.prompts[id];
      }
    });
  }
  cleanup() {
    return this.exclusive(async () => {
      await this.recentHistory();
      for (const [tabId, intent] of Object.entries(this.state.setups || {})) if ((typeof intent === 'number' ? intent : intent.deadline) <= this.now()) delete this.state.setups[tabId];
      for (const [id, job] of Object.entries(this.state.jobs)) if (job.deadline <= this.now()) { await this.cancelJob(id); delete this.state.jobs[id]; }
      for (const [id, prompt] of Object.entries(this.state.prompts)) if (prompt.deadline <= this.now()) {
        if (prompt.kind === 'repair') this.releaseDuo(prompt);
        delete this.state.prompts[id];
        const flow = this.state.flows[prompt.tabId];
        if (flow?.status === 'asking') flow.status = 'expired';
        await this.closeWindow(prompt.windowId);
      }
      for (const [tabId, flow] of Object.entries(this.state.flows)) {
        if (flow.stage === 'transit' && flow.transitUntil <= this.now()) {
          await this.invalidateTab(Number(tabId));
          await this.note("Automatic sign-in steps ended. Check the destination site to confirm sign-in.");
        } else if (flow.expiresAt <= this.now()) {
          flow.status = 'expired'; flow.grant = null;
          await this.releaseFlowTab(flow);
        }
      }
      return this.wakeTargets();
    });
  }
}
