import { OKTA_ORIGIN, CONFIRM_TEXT, FLOW_MS, PROMPT_MS, canUseGrant, duoOrigin, liveFlow, validSender, validateAccount, publicCredential, isOktaLoginUrl, entryForUrl, entryTarget, isEntryTransit, HANDOFF_MS, DUO_MATCH, HISTORY_MS, continuesSignInFlow, parseHttps } from './policy.js';
import { randomId } from './encoding.js';
import { emptyVault, newPin, verifyPin } from './vault.js';
import { checkRequest, createCredential, getAssertion, matchingCredentials } from './passkeys.js';
import { LANGUAGE_KEY } from './locale.js';

const defaults = () => ({ enabled: true, selectedCredentialId: '' });
const emptyState = () => ({ flows: {}, prompts: {}, jobs: {} });
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
    return { enabled: settings.enabled !== false, selectedCredentialId: settings.selectedCredentialId || '' };
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
  async note(text) {
    const history = await this.recentHistory();
    await this.api.storage.local.set({ history: [{ at: this.now(), text }, ...history].slice(0, 20) });
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
  async showPrompt(prompt) {
    prompt.id = randomId();
    prompt.deadline = this.now() + PROMPT_MS;
    this.state.prompts[prompt.id] = prompt;
    const window = await this.api.windows.create({
      url: this.api.runtime.getURL(`confirm.html?id=${prompt.id}`),
      type: 'popup', width: 420, height: prompt.kind === 'login' && !prompt.hasPin ? 390 : 540, focused: true
    });
    prompt.windowId = window.id;
    return prompt;
  }
  async syncScripts() {
    const settings = await this.settings();
    const ids = ['duo-main', 'duo-isolated'];
    const registered = await this.api.scripting.getRegisteredContentScripts({ ids });
    let matches = [];
    if (settings.enabled) {
      if (await this.api.permissions.contains({ origins: [DUO_MATCH] })) matches = [DUO_MATCH];
      else {
        const { origins = [] } = await this.api.permissions.getAll();
        matches = origins.filter(pattern => {
          try { return pattern === duoOrigin(pattern.slice(0, -2)) + '/*'; } catch { return false; }
        }).sort();
      }
    }
    if (matches.length && registered.length === 2 && registered.every(script =>
        JSON.stringify(script.matches) === JSON.stringify(matches))) return;
    if (registered.length) await this.api.scripting.unregisterContentScripts({ ids: registered.map(script => script.id) });
    if (matches.length) await this.api.scripting.registerContentScripts([
      { id: ids[1], matches, js: ['content/dom.js', 'content/duo.js'], world: 'ISOLATED', runAt: 'document_start', allFrames: false, persistAcrossSessions: true },
      { id: ids[0], matches, js: ['content/passkey-bridge.js'], world: 'MAIN', runAt: 'document_start', allFrames: false, persistAcrossSessions: true }
    ]);
  }
  dispatch(message, sender) { return this.exclusive(() => this.handle(message, sender)); }
  async requestLogin(sender, settings, entryKind = null) {
    const flow = this.state.flows[sender.tab.id];
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
    if (flow?.status === 'active') { flow.status = 'expired'; flow.grant = null; }
    if (flow?.documentId === sender.documentId && ['asking', 'cancelled', 'error', 'expired'].includes(flow.status)) return { status: flow.status };
    const data = await this.vault.read();
    if (!data.username || !data.password) return { status: 'needs-setup' };
    const next = {
      id: randomId(), tabId: sender.tab.id, documentId: sender.documentId,
      entryKind, stage: entryKind ? 'entry' : 'auth', authOrigin: entryKind ? '' : OKTA_ORIGIN,
      authDocumentId: sender.documentId, status: 'asking',
      attempts: {}, expiresAt: this.now() + FLOW_MS
    };
    this.state.flows[sender.tab.id] = next;
    const selected = data.credentials.find(c => c.id === settings.selectedCredentialId);
    await this.showPrompt({
      kind: 'login', tabId: sender.tab.id, documentId: sender.documentId, flowId: next.id,
      origin: new URL(sender.url).origin, entryKind, title: CONFIRM_TEXT,
      username: data.username, credentialId: selected?.id, rpId: selected?.rpId,
      credentialName: selected?.userName, requireUV: false, hasPin: !!data.pin
    });
    return { status: 'asking' };
  }
  async handle(message, sender) {
    if (!message || typeof message.type !== 'string' || sender.id !== this.api.runtime.id) throw new Error("Invalid extension message.");
    const settings = await this.settings();
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
    if (isDuoPage && !isDuo) {
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
    if (!settings.enabled) return message.type.startsWith('PK_') ? { fallback: true } : { status: 'disabled' };
    const flow = this.state.flows[sender.tab.id];
    if (message.type === 'STATUS') return { status: flow?.status || 'idle', active: liveFlow(flow, this.now()), trusted: isDuo };
    if (message.type === 'ENTRY_DETECTED' && entryKind) return this.requestLogin(sender, settings, entryKind);
    if (message.type === 'ENTRY_STEP' && entryKind) {
      if (!liveFlow(flow, this.now()) || flow.entryKind !== entryKind || flow.documentId !== sender.documentId) throw new Error("Confirm this sign-in before continuing.");
      if (flow.entryStarted) return { skipped: true };
      if (flow.stage !== 'entry' || message.target !== entryTarget(entryKind)) throw new Error("The sign-in link has changed. The assistant has stopped.");
      flow.entryStarted = true;
      flow.stage = 'handoff';
      flow.handoffUntil = this.now() + HANDOFF_MS;
      await this.note(entryKind === 'portal' ? "Opening the student sign-in." : "Opening the Canvas sign-in.");
      // Entry pages receive a fixed destination, never account or passkey data.
      return { target: entryTarget(entryKind) };
    }
    if (message.type === 'LOGIN_DETECTED' && isOkta) return this.requestLogin(sender, settings);
    if (message.type === 'LOGIN_STEP' && isOkta) {
      if (!liveFlow(flow, this.now()) || flow.stage !== 'auth') throw new Error("Confirm this sign-in before continuing.");
      if (!['username', 'password', 'combined', 'duo'].includes(message.step)) throw new Error("Unrecognized sign-in step.");
      const key = `${sender.documentId}:${message.step}`;
      const passwordKey = sender.documentId + ':password';
      const usesPassword = ['password', 'combined'].includes(message.step);
      if (flow.attempts[key] || (usesPassword && flow.attempts[passwordKey])) return { skipped: true };
      if (Object.keys(flow.attempts).length >= 8) { flow.status = 'error'; flow.grant = null; throw new Error("The sign-in took too many steps. The assistant has stopped."); }
      const data = await this.vault.read();
      if (message.step === 'duo') flow.duoHandoffUntil = this.now() + HANDOFF_MS;
      flow.attempts[key] = true;
      if (usesPassword) flow.attempts[passwordKey] = true;
      await this.note(`Continuing sign-in: ${{ username: 'username', password: 'password', combined: 'username and password', duo: 'Duo redirect' }[message.step]}.`);
      return { username: ['username', 'combined'].includes(message.step) ? data.username : undefined, password: ['password', 'combined'].includes(message.step) ? data.password : undefined };
    }
    if (message.type === 'FLOW_ERROR') {
      if (flow) { flow.status = 'error'; flow.grant = null; }
      await this.note("The assistant stopped because of a page error or an unsupported step. Check the sign-in page.");
      return { status: 'error' };
    }
    if (message.type === 'PK_BEGIN' && isDuo) return this.beginPasskey(message, sender, settings);
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
      return { ...settings, username: data.username, hasPassword: !!data.password, hasPin: !!data.pin, credentials: data.credentials.map(publicCredential), history: await this.recentHistory() };
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
        next = { enabled: message.type === 'UI_SAVE' ? message.enabled === true : settings.enabled, selectedCredentialId: message.selectedCredentialId || '' };
      }
      if (changedAccount) next.selectedCredentialId = '';
      if (saveAccount) await this.vault.write({ ...data, ...account });
      if (saveSettings || changedAccount) await this.api.storage.local.set({ settings: next });
      await this.invalidateAll();
      if (saveSettings) await this.syncScripts();
      return { saved: true };
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
      if (settings.selectedCredentialId === message.id) await this.api.storage.local.set({ settings: { ...settings, selectedCredentialId: '' } });
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
      if (!isOktaLoginUrl(tab.url) && !entryForUrl(tab.url)) throw new Error("Open the assistant from your UChicago sign-in tab.");
      await this.invalidateTab(tab.id);
      await this.api.tabs.sendMessage(tab.id, { type: 'RECHECK' });
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
  async beginPasskey(message, sender, settings) {
    if (!['create', 'get'].includes(message.kind) || JSON.stringify(message.options || {}).length > 65_536) return { fallback: true };
    const origin = duoOrigin(sender.url);
    const flow = this.state.flows[sender.tab.id];
    let request;
    try { request = checkRequest(message.kind, message.options, origin, origin); }
    catch (error) { return error.name === 'NotSupportedError' ? { fallback: true } : failure(error.name, error.message); }
    if (Object.values(this.state.jobs).some(j => j.tabId === sender.tab.id && !j.result && j.deadline > this.now())) return failure('NotAllowedError', "Another authentication request is already waiting for approval.");
    const data = await this.vault.read();
    const choices = message.kind === 'get' ? matchingCredentials(message.options, request.rpId, data.credentials) : [];
    if (message.kind === 'get' && !choices.length) return { fallback: true };
    if (message.kind === 'create' && data.credentials.length >= 20) return failure('NotAllowedError', "You have reached the limit of 20 saved passkeys. Delete an unused passkey before adding another.");
    const job = { id: randomId(), kind: message.kind, options: message.options, origin, flowId: flow.id, tabId: sender.tab.id, documentId: sender.documentId, deadline: Math.min(flow.expiresAt, this.now() + Math.min(PROMPT_MS, Math.max(1_000, Number(message.options.timeout) || PROMPT_MS))), ...request };
    this.state.jobs[job.id] = job;
    const selected = choices.find(c => c.id === settings.selectedCredentialId);
    if (job.kind === 'get' && selected && liveFlow(flow, this.now()) && canUseGrant(flow.grant, { tabId: job.tabId, flowId: flow.id, rpId: job.rpId, credentialId: selected.id, requireUV: job.requireUV, now: this.now() })) {
      const proof = { up: true, uv: flow.grant.uv === true };
      flow.grant = null; // Consume before any signing or asynchronous work, never after.
      await this.executeJob(job, selected.id, proof, settings);
      return { id: job.id, ...job.result };
    }
    if (flow) flow.grant = null;
    const prompt = await this.showPrompt({ kind: job.kind, jobId: job.id, tabId: job.tabId, documentId: job.documentId, rpId: job.rpId, username: job.kind === 'create' ? job.options.user.name : undefined, choices: choices.map(publicCredential), requireUV: job.requireUV });
    prompt.deadline = Math.min(prompt.deadline, job.deadline);
    return { id: job.id, pending: true };
  }
  async executeJob(job, credentialId, proof, settings) {
    if (job.started) throw new Error("This request has already started and cannot be signed again.");
    job.started = true;
    // Commit consumed consent before cryptography. A terminated worker may lose
    // the response, but must never resurrect consent or repeat this operation.
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
        data.credentials.push(result.credential);
        await this.vault.write(data); // Persist key before returning a registration response.
        job.result = { response: result.response };
        await this.note("Local passkey created. Confirm registration in Duo before selecting it in settings.");
      } else {
        const credential = data.credentials.find(c => c.id === credentialId);
        if (!credential) throw new Error("The selected passkey could not be found.");
        const result = await getAssertion({ options: job.options, origin: job.origin, configuredOrigin: job.origin, credential, proof });
        data.credentials = data.credentials.map(c => c.id === credential.id ? result.credential : c);
        await this.vault.write(data); // Persist counter before delivering the assertion.
        job.result = { response: result.response };
        await this.note("Passkey response generated. Waiting for Duo to accept it.");
      }
    } catch (error) { job.result = failure(error.name || 'NotAllowedError', error.message); }
  }
  async promptMessage(message, sender, settings) {
    this.requireUI(sender, ['confirm.html']);
    const id = new URL(sender.url).searchParams.get('id');
    if (message.id !== id) throw new Error("This confirmation window does not match the request.");
    const prompt = this.state.prompts[id];
    if (!prompt || prompt.deadline <= this.now()) throw new Error("This confirmation has expired. Return to the sign-in page and try again.");
    const data = await this.vault.read();
    if (message.type === 'PROMPT_GET') return { ...prompt, hasPin: !!data.pin };
    if (message.type !== 'PROMPT_DECIDE' || !['approve', 'cancel', 'fallback'].includes(message.action)) throw new Error("Unrecognized confirmation action.");
    if (message.action !== 'approve') {
      if (prompt.kind === 'login') {
        const flow = this.state.flows[prompt.tabId];
        if (flow) { flow.status = 'cancelled'; flow.grant = null; }
      } else {
        const job = this.state.jobs[prompt.jobId];
        if (job) job.result = message.action === 'fallback' ? { fallback: true } : failure('NotAllowedError', "Canceled by the user.");
      }
      delete this.state.prompts[id];
      return { done: true };
    }
    const frame = await this.api.webNavigation.getFrame({ tabId: prompt.tabId, frameId: 0 });
    const expectedOrigin = prompt.kind === 'login' ? prompt.origin || OKTA_ORIGIN : this.state.jobs[prompt.jobId]?.origin;
    if (!frame || frame.documentId !== prompt.documentId || new URL(frame.url).origin !== expectedOrigin) throw new Error("The sign-in page has changed. Close this window and try again.");
    if (prompt.kind === 'login' && (prompt.entryKind ? entryForUrl(frame.url) !== prompt.entryKind : !isOktaLoginUrl(frame.url))) throw new Error("The sign-in page has changed. Close this window and try again.");
    if (!await this.api.permissions.contains({ origins: [expectedOrigin + '/*'] })) throw new Error("The sign-in page has changed. Close this window and try again.");
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
      flow.grant = prompt.credentialId ? { tabId: prompt.tabId, flowId: flow.id, credentialId: prompt.credentialId, rpId: prompt.rpId, issuedAt: this.now(), uv } : null;
      await this.note("Sign-in approved.");
    } else {
      const job = this.state.jobs[prompt.jobId];
      if (!job || job.started || job.result || job.deadline <= this.now()) throw new Error("This authentication request has expired.");
      if (job.kind === 'get' && !prompt.choices.some(c => c.id === message.credentialId)) throw new Error("Choose a matching passkey.");
      delete this.state.prompts[id];
      await this.executeJob(job, message.credentialId, { up: true, uv }, settings);
    }
    delete this.state.prompts[id];
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
    delete this.state.flows[tabId];
    for (const [id, job] of Object.entries(this.state.jobs)) if (job.tabId === tabId) { await this.cancelJob(id); delete this.state.jobs[id]; }
    for (const [id, prompt] of Object.entries(this.state.prompts)) if (prompt.tabId === tabId) { delete this.state.prompts[id]; await this.closeWindow(prompt.windowId); }
  }
  async invalidateAll() {
    for (const prompt of Object.values(this.state.prompts)) await this.closeWindow(prompt.windowId);
    this.state = emptyState();
  }
  navigation(details) {
    return this.exclusive(async () => {
      if (details.frameId !== 0) return;
      const frame = await this.api.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 });
      if (!frame || frame.documentId !== details.documentId || frame.url !== details.url ||
          (frame.documentLifecycle && frame.documentLifecycle !== 'active')) return;
      const settings = await this.settings();
      const flow = this.state.flows[details.tabId];
      for (const [id, job] of Object.entries(this.state.jobs)) if (job.tabId === details.tabId && job.documentId !== details.documentId) { await this.cancelJob(id); delete this.state.jobs[id]; }
      if (!flow) return;
      if (!settings.enabled) { await this.invalidateTab(details.tabId); return; }
      let origin;
      try { origin = new URL(details.url).origin; } catch { origin = ''; }
      if (flow.status !== 'active') {
        const samePage = flow.entryKind ? entryForUrl(details.url) === flow.entryKind : isOktaLoginUrl(details.url);
        if (flow.documentId !== details.documentId || !samePage) await this.invalidateTab(details.tabId);
        return;
      }
      if (!liveFlow(flow, this.now())) { await this.invalidateTab(details.tabId); return; }
      if ((details.transitionQualifiers || []).some(value => ['from_address_bar', 'forward_back'].includes(value)) ||
          ['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated'].includes(details.transitionType)) {
        await this.invalidateTab(details.tabId); return;
      }
      if (flow.stage === 'entry') {
        if (flow.documentId === details.documentId && entryForUrl(details.url) === flow.entryKind) return;
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
        if (prompt.kind === 'login') { const flow = this.state.flows[prompt.tabId]; if (flow) { flow.status = 'cancelled'; flow.grant = null; } }
        else { const job = this.state.jobs[prompt.jobId]; if (job && !job.result) job.result = failure('NotAllowedError', "The confirmation window was closed."); }
        delete this.state.prompts[id];
      }
    });
  }
  cleanup() {
    return this.exclusive(async () => {
      await this.recentHistory();
      for (const [id, job] of Object.entries(this.state.jobs)) if (job.deadline <= this.now()) { await this.cancelJob(id); delete this.state.jobs[id]; }
      for (const [id, prompt] of Object.entries(this.state.prompts)) if (prompt.deadline <= this.now()) {
        delete this.state.prompts[id];
        const flow = this.state.flows[prompt.tabId];
        if (flow?.status === 'asking') flow.status = 'expired';
        await this.closeWindow(prompt.windowId);
      }
      for (const [tabId, flow] of Object.entries(this.state.flows)) {
        if (flow.stage === 'transit' && flow.transitUntil <= this.now()) {
          await this.invalidateTab(Number(tabId));
          await this.note("Automatic sign-in steps ended. Check the destination site to confirm sign-in.");
        } else if (flow.expiresAt <= this.now()) { flow.status = 'expired'; flow.grant = null; }
      }
    });
  }
}
