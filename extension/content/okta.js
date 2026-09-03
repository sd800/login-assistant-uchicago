(() => {
  'use strict';
  if (window.top !== window || location.origin !== 'https://uchicago.okta.com') return;
  const dom = globalThis.UChiLoginDOM;
  let busy = false;
  let stopped = false;
  let scheduled = false;
  let rerun = false;
  let approved = false;
  let checkAfter = 0;
  let pending;
  const attempted = new Set();
  const sameStep = (a, b) => a && b && a.kind === b.kind && a.form === b.form &&
    a.username === b.username && a.password === b.password;
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "The extension disconnected. Reload this page and try again.");
    return response.result;
  }
  function schedule() {
    if (scheduled || stopped) return;
    scheduled = true;
    void Promise.resolve().then(() => { scheduled = false; void tick(); });
  }
  async function tick() {
    if (stopped || !document.body) return;
    if (busy) { rerun = true; return; }
    busy = true;
    try {
      let detected = dom.detectOkta(document);
      if (!detected) return;
      if (detected.kind === 'error') { await send({ type: 'FLOW_ERROR' }); stopped = true; return; }
      if (!approved) {
        if (Date.now() < checkAfter) return;
        const state = await send({ type: 'LOGIN_DETECTED' });
        approved = state.status === 'active';
        checkAfter = Date.now() + 1_500;
        if (!approved) return;
        detected = dom.detectOkta(document);
      }
      if (!detected || detected.kind === 'error') return;
      if (!pending) {
        if (attempted.has(detected.kind) || !detected.submitButton) return;
        // The worker records credential access before returning any values.
        // A rerender or disabled submit button must never cause a password retry.
        const values = await send({ type: 'LOGIN_STEP', step: detected.kind });
        attempted.add(detected.kind);
        if (values.skipped) return;
        if (!sameStep(detected, dom.detectOkta(document))) {
          stopped = true; await send({ type: 'FLOW_ERROR' }); return;
        }
        pending = detected;
        dom.fill(detected.username, values.username);
        dom.fill(detected.password, values.password);
      }
      const current = dom.detectOkta(document);
      if (!sameStep(pending, current)) {
        stopped = true; await send({ type: 'FLOW_ERROR' }); return;
      }
      // Input handlers may enable or replace the button after filling the form.
      if (!current.button) return;
      const permission = await send({ type: 'LOGIN_READY', step: pending.kind });
      if (!permission.ready || Date.now() >= permission.expiresAt) { stopped = true; return; }
      const ready = dom.detectOkta(document);
      if (!sameStep(pending, ready)) { stopped = true; await send({ type: 'FLOW_ERROR' }); return; }
      if (!ready.button) return;
      pending = null;
      ready.button.click();
      rerun = true;
    } catch { stopped = true; }
    finally {
      busy = false;
      if (rerun) { rerun = false; schedule(); }
    }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'RECHECK') {
      stopped = false; approved = false; checkAfter = 0; pending = null; attempted.clear(); schedule();
    } else if (message?.type === 'FLOW_WAKE') {
      schedule();
    } else if (message?.type === 'LOGIN_APPROVED') {
      approved = true; checkAfter = 0; schedule();
    }
  });
  const observer = new MutationObserver(schedule);
  observer.observe(document, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['hidden', 'class', 'style', 'disabled', 'readonly', 'aria-hidden', 'aria-disabled', 'type', 'name', 'autocomplete', 'data-type', 'id'] });
  window.addEventListener('input', schedule, true);
  window.addEventListener('change', schedule, true);
  window.addEventListener('DOMContentLoaded', schedule, { once: true });
  window.addEventListener('pageshow', schedule);
  // Events drive normal progress; polling only recovers from missed page changes.
  setInterval(tick, 1_500);
  void tick();
})();
