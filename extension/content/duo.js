(() => {
  'use strict';
  if (window.top !== window || !location.hostname.endsWith('.duosecurity.com')) return;
  if (globalThis.__uchiDuoAdapterInstalled) return;
  globalThis.__uchiDuoAdapterInstalled = true;
  const dom = globalThis.UChiLoginDOM;
  const jobs = new Map();
  const deferred = new Set();
  const deliveries = new Map();
  let lastDelivery;
  let requestSerial = 0;
  const activeJobs = () => jobs.size > deferred.size;
  const delays = new Set();
  let busy = false;
  let rerun = false;
  let failed = false;
  let manualSeen = false;
  let inventorySignature = '';
  let inventoryKeys;
  let inventorySince = 0;
  let menuSeen = false;
  let menuHandled = false;
  let menuRequested = false;
  let deviceRemembered = false;
  let navigationId;
  let menuObserver;
  let identityNotice;
  function showIdentityNotice(copy) {
    if (!copy) {
      identityNotice?.host.remove(); identityNotice = null; return;
    }
    if (!identityNotice) {
      const host = document.createElement('div');
      host.setAttribute('id', 'uchicago-login-assistant-identity');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; display: block; margin: 0 0 18px; }
        .notice { box-sizing: border-box; border-inline-start: 3px solid #800000;
          border-radius: 6px; padding: 12px 16px; background: #f7f4f4; color: #282424;
          font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px;
          font-weight: 400; line-height: 1.5; letter-spacing: normal; text-align: start; }
        .notice[lang="zh-CN"] { letter-spacing: 0.04em; }
        strong { display: block; font-size: 15px; font-weight: 600; }
        p { margin: 4px 0 0; }
        @media (prefers-color-scheme: dark) { .notice { background: #292527; color: #f4f0f1; } }
      `;
      const box = document.createElement('div'); box.className = 'notice';
      box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); box.setAttribute('aria-atomic', 'true');
      const title = document.createElement('strong'), message = document.createElement('p');
      box.append(title, message); shadow.append(style, box);
      identityNotice = { host, box, title, message };
    }
    const { host, box, title, message } = identityNotice;
    if (box.getAttribute('lang') !== copy.locale) box.setAttribute('lang', copy.locale);
    if (title.textContent !== copy.title) title.textContent = copy.title;
    if (message.textContent !== copy.message) message.textContent = copy.message;
    const heading = [...document.querySelectorAll('h1, h2, [role="heading"]')].find(dom.visible);
    const parent = heading?.parentElement || document.body;
    if (!document.contains(host) || host.parentElement !== parent) {
      if (heading) parent.insertBefore(host, heading); else parent.prepend(host);
    }
  }
  function stopMenuNavigation() {
    menuHandled = true;
  }
  function rememberMenu() {
    if (!document.body) return;
    manualSeen ||= dom.duoIdentity(document);
    menuSeen ||= dom.duoMenuVisible(document);
    void tick();
  }
  async function send(message) {
    const envelope = await chrome.runtime.sendMessage(message);
    if (!envelope?.ok) throw new Error(envelope?.error || "The extension disconnected. Reload this page and try again.");
    return envelope.result;
  }
  function reportFallback(kind, reason) {
    if (['create', 'get'].includes(kind)) void send({ type: 'PK_FALLBACK', kind, reason }).catch(() => {});
  }
  async function waitForFlow(pageId, timeout) {
    const handshakeUntil = Date.now() + 10_000;
    let approvedFlowSeen = false;
    const deadline = Date.now() + Math.min(120_000, Math.max(1_000, Number(timeout) || 120_000));
    while (jobs.has(pageId)) {
      const flow = await send({ type: 'STATUS' });
      if (flow.trusted) return flow;
      approvedFlowSeen ||= flow.pending === true;
      if (!flow.pending || Date.now() >= deadline || Date.now() >= handshakeUntil) return approvedFlowSeen ? { unavailable: true } : false;
      await new Promise(resolve => {
        const timer = setTimeout(() => { delays.delete(timer); resolve(); }, 75);
        delays.add(timer);
      });
    }
    return false;
  }
  function respond(id, result) {
    if (result.response?.response?.signature && result.id) deliveries.set(id, { id: result.id, serial: requestSerial, oldRejection: dom.duoKeyRejected(document) });
    window.postMessage({ channel: 'uchicago-passkeys-v1', direction: 'response', id, result }, location.origin);
  }
  async function poll(pageId) {
    const job = jobs.get(pageId);
    if (!job?.id) return;
    try {
      const result = await send({ type: 'PK_POLL', id: job.id });
      if (!jobs.has(pageId)) return;
      if (result.pending) {
        const timer = setTimeout(() => { delays.delete(timer); void poll(pageId); }, 350);
        delays.add(timer);
      } else {
        jobs.delete(pageId);
        respond(pageId, job.automatic && result.fallback && !result.explicit && !result.manual
          ? { error: { name: 'NotAllowedError', message: "The approved sign-in ended. Start a new school sign-in." } } : { ...result, id: job.id });
      }
    } catch { jobs.delete(pageId); respond(pageId, { error: { name: 'NotAllowedError', message: "Authentication was interrupted. Try again or use another passkey provider." } }); }
  }
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'uchicago-passkeys-v1') return;
    const data = event.data;
    if (typeof data.id !== 'string' || !/^[a-f0-9-]{36}$/.test(data.id)) return;
    if (data.direction === 'delivered') {
      const delivery = deliveries.get(data.id);
      deliveries.delete(data.id);
      if (delivery && delivery.serial === requestSerial) {
        const result = await send({ type: 'PK_DELIVERED', id: delivery.id }).catch(() => ({}));
        if (result.recorded && delivery.serial === requestSerial) { lastDelivery = delivery; void tick(); }
      }
      return;
    }
    if (data.direction === 'diagnostic' && data.kind === 'create' && data.reason === 'mediation') {
      reportFallback(data.kind, data.reason);
      return;
    }
    if (data.direction === 'cancel') {
      const job = jobs.get(data.id);
      deliveries.delete(data.id);
      jobs.delete(data.id); deferred.delete(data.id);
      if (job?.id) void send({ type: 'PK_CANCEL', id: job.id }).catch(() => {});
      return;
    }
    if (data.direction !== 'request' || !['get', 'create'].includes(data.kind)) return;
    if (activeJobs() || jobs.has(data.id) || jobs.size >= 4) { respond(data.id, { error: { name: 'NotAllowedError', message: "Another authentication request is already in progress." } }); return; }
    if (data.kind === 'get') { requestSerial++; lastDelivery = null; }
    const job = { id: null, automatic: false };
    jobs.set(data.id, job);
    try {
      const flow = await waitForFlow(data.id, data.options?.timeout);
      if (!jobs.has(data.id)) return;
      if (!flow) { jobs.delete(data.id); reportFallback(data.kind, 'flow'); respond(data.id, { fallback: true }); return; }
      if (flow.unavailable) { jobs.delete(data.id); respond(data.id, { error: { name: 'NotAllowedError', message: "The approved sign-in ended. Start a new school sign-in." } }); return; }
      const identity = dom.duoIdentity(document) || flow.duo?.phase === 'identity';
      if (identity) await send({ type: 'DUO_STEP', step: 'identity' });
      job.automatic = data.kind === 'get' && flow.duo?.automatic === true;
      const result = await send({ type: 'PK_BEGIN', kind: data.kind, options: data.options, browserManaged: data.browserManaged === true });
      if (!jobs.has(data.id)) { if (result.id) void send({ type: 'PK_CANCEL', id: result.id }); return; }
      if (result.defer) { deferred.add(data.id); void tick(); return; }
      if (result.pending && result.id) { cancelDeferred(); job.id = result.id; void poll(data.id); }
      else {
        cancelDeferred();
        jobs.delete(data.id);
        respond(data.id, job.automatic && result.fallback && !result.explicit && !result.manual
          ? { error: { name: 'NotAllowedError', message: "The approved sign-in ended. Start a new school sign-in." } } : result);
      }
    } catch {
      jobs.delete(data.id); deferred.delete(data.id);
      respond(data.id, { error: { name: 'NotAllowedError', message: "The extension could not handle this request. Reload the extension and start a new school sign-in." } });
    }
  });
  function cancelDeferred() {
    for (const id of deferred) {
      jobs.delete(id);
      respond(id, { error: { name: 'AbortError', message: "The assistant is switching Duo verification methods." } });
    }
    deferred.clear();
  }

  function releaseDeferred() {
    for (const id of deferred) {
      jobs.delete(id);
      respond(id, { fallback: true, manual: true });
    }
    deferred.clear();
  }

  async function openOptions() {
    if (menuRequested || menuHandled || menuSeen || manualSeen || dom.duoIdentity(document) ||
        activeJobs()) return false;
    const button = dom.duoChoice(document);
    if (!button) return false;
    // Ask for this action directly; no status poll or key matching is needed
    // before switching away from the site's remembered default method.
    const result = await send({ type: 'DUO_MENU', open: true });
    if (!result.click || menuRequested || menuHandled || menuSeen || manualSeen || dom.duoIdentity(document) || activeJobs()) return false;
    if (dom.duoChoice(document) !== button) { rerun = true; return false; }
    menuRequested = true;
    cancelDeferred();
    button.click();
    menuSeen ||= dom.duoMenuVisible(document);
    manualSeen ||= dom.duoIdentity(document);
    rerun = true;
    return true;
  }

  async function inventory() {
    const labels = dom.duoInventory(document);
    if (!labels) { inventorySignature = ''; inventoryKeys = null; return null; }
    const signature = JSON.stringify(labels);
    if (signature !== inventorySignature) {
      inventorySignature = signature; inventorySince = Date.now(); inventoryKeys = null; return null;
    }
    if (Date.now() - inventorySince < 600) return null;
    if (!inventoryKeys) inventoryKeys = await Promise.all(labels.map(async label => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(label));
      return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }));
    return inventoryKeys;
  }
  async function clickStep(step, button, extra = {}) {
    if (!button || (step === 'remember-device' && deviceRemembered)) return;
    const result = await send({ type: 'DUO_STEP', step, ...extra });
    const current = step === 'login-menu' ? dom.duoChoice(document) : dom.duoAction(document, step);
    if (result.click && current === button && !dom.duoIdentity(document) && !activeJobs()) {
      // Queue acknowledgement before the page can synchronously request its key.
      // If the menu changed while awaiting permission, leave it retryable.
      if (step === 'login-key') void send({ type: 'DUO_STEP', step: 'key-selected' }).catch(() => {});
      if (step === 'remember-device') deviceRemembered = true;
      cancelDeferred(); button.click(); rerun = true;
    }
  }
  async function tick() {
    if (failed || !document.body) return;
    if (busy) { rerun = true; return; }
    menuSeen ||= dom.duoMenuVisible(document);
    manualSeen ||= dom.duoIdentity(document);
    busy = true;
    try {
      if (await openOptions()) return;
      const status = await send({ type: 'STATUS' });
      if (!status.active || !status.trusted) { showIdentityNotice(null); return; }
      if (status.duo?.navigationId && navigationId !== status.duo.navigationId) {
        navigationId = status.duo.navigationId;
        menuHandled = false; menuRequested = false;
        menuSeen = dom.duoMenuVisible(document); manualSeen = dom.duoIdentity(document);
        inventorySignature = ''; inventoryKeys = null;
        rerun = true;
      }
      if (status.duo?.phase === 'manual') releaseDeferred();
      showIdentityNotice(activeJobs() ? null : status.duo?.identityNotice);
      if (lastDelivery) {
        const rejected = dom.duoKeyRejected(document);
        if (!rejected) lastDelivery.oldRejection = false;
        if (rejected && !lastDelivery.oldRejection) {
          const delivery = lastDelivery; lastDelivery = null;
          await send({ type: 'PK_REJECTED', id: delivery.id, reason: 'not-registered' });
          return;
        }
      }
      if (status.duo?.phase === 'repair') return;
      // This optional post-verification step also follows manual Duo verification.
      const remember = dom.duoAction(document, 'remember-device');
      if (remember) {
        showIdentityNotice(null);
        if (!activeJobs()) await clickStep('remember-device', remember);
        return;
      }
      const phase = status.duo?.phase || 'start';
      if (phase === 'manual') return;
      if (!['start', 'menu', 'identity'].includes(phase)) manualSeen = false;
      const manager = /(?:^|\.)devicemanagement\.duosecurity\.com$/.test(location.hostname) &&
        /^\/frame\/device-management\/portal\/?$/.test(location.pathname);
      if (manualSeen && ['start', 'menu'].includes(phase)) {
        await send({ type: 'DUO_STEP', step: 'identity' }); rerun = true; return;
      }
      if (dom.duoIdentity(document)) return;
      if (['start', 'returning'].includes(phase) && menuSeen) {
        const result = await send({ type: 'DUO_MENU', open: false });
        if (result.phase === 'menu') {
          stopMenuNavigation(); cancelDeferred(); rerun = true;
        }
        return;
      }
      if (activeJobs()) return;
      if (manager && ['start', 'menu', 'identity', 'registering'].includes(phase)) {
        const keys = await inventory();
        if (keys) {
          const result = await send({ type: 'DUO_STEP', step: phase === 'registering' ? 'registered' : 'inventory', keys });
          // Continue immediately only after an accepted phase change. An unchanged
          // device list must not create a busy loop while registration is pending.
          rerun ||= !!result.phase && result.phase !== phase;
          manualSeen = false;
        }
        return;
      }
      if (phase === 'identity' || phase === 'authenticating') return;
      if (phase === 'devices') { await clickStep('add-device', dom.duoAction(document, 'add-device')); return; }
      if (phase === 'choose-device') { await clickStep('security-key', dom.duoAction(document, 'security-key')); return; }
      if (phase === 'setup-key') { await clickStep('register', dom.duoAction(document, 'register')); return; }
      if (phase === 'registered') { await clickStep('back', dom.duoAction(document, 'back')); return; }
      if (phase === 'returning') return;
      if (phase === 'menu') {
        const step = status.duo?.mode === 'login' ? 'login-key' : 'manage';
        await clickStep(step, dom.duoAction(document, step));
        return;
      }
      if (status.duoMenuHandled) stopMenuNavigation();
      // A generic Duo error may describe a canceled default method. Keep the
      // approved flow available for another method until it expires.
    } catch (error) {
      showIdentityNotice(null);
      failed = /extension context invalidated/i.test(error?.message || '');
    }
    finally {
      busy = false;
      if (rerun) { rerun = false; void Promise.resolve().then(tick); }
    }
  }
  chrome.runtime.onMessage?.addListener(message => {
    if (message?.type === 'FLOW_WAKE' && !failed) rememberMenu();
  });
  // Observe manual verification before any later automatic action can run.
  menuObserver = new MutationObserver(rememberMenu);
  menuObserver.observe(document, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['hidden', 'class', 'style', 'disabled', 'aria-hidden', 'aria-disabled', 'aria-label', 'aria-labelledby', 'title'] });
  window.addEventListener('click', event => {
    const key = dom.duoAction(document, 'login-key');
    if (event.isTrusted && key && (event.target === key || key.contains(event.target))) {
      // Queue the observed choice before the page's click handler requests a key.
      cancelDeferred();
      void send({ type: 'DUO_STEP', step: 'key-selected' }).catch(() => {});
    }
    rememberMenu();
  }, true);
  window.addEventListener('DOMContentLoaded', rememberMenu, { once: true });
  window.addEventListener('pageshow', rememberMenu);
  window.addEventListener('online', rememberMenu);
  window.addEventListener('visibilitychange', rememberMenu);
  setInterval(tick, 700);
  rememberMenu();
  window.addEventListener('pagehide', () => {
    showIdentityNotice(null);
    menuObserver.disconnect();
    for (const timer of delays) clearTimeout(timer);
    for (const job of jobs.values()) if (job.id) void send({ type: 'PK_CANCEL', id: job.id }).catch(() => {});
    jobs.clear(); deferred.clear(); deliveries.clear(); lastDelivery = null;
  });
})();
