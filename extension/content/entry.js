(() => {
  'use strict';
  if (window.top !== window) return;
  const routes = globalThis.UChiLoginRoutes;
  const kind = routes.entryForUrl(location.href);
  if (!kind) return;
  const dom = globalThis.UChiLoginDOM;
  let busy = false;
  let rerun = false;
  let scheduled = false;
  let approved = false;
  let checkAfter = 0;
  let stopped = false;
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'The extension disconnected. Reload this page and try again.');
    return response.result;
  }
  function schedule() {
    if (scheduled || stopped) return;
    scheduled = true;
    void Promise.resolve().then(() => { scheduled = false; void tick(); });
  }
  async function tick() {
    if (stopped || routes.entryForUrl(location.href) !== kind) return;
    if (busy) { rerun = true; return; }
    busy = true;
    try {
      if (!approved) {
        if (Date.now() < checkAfter) return;
        const state = await send({ type: 'ENTRY_DETECTED' });
        approved = state.status === 'active'; checkAfter = Date.now() + 1_500;
        if (!approved) return;
      }
      // Portal and Courses entry targets are fixed and controller-validated.
      // Navigate after approval without waiting for the source page to render.
      const target = routes.entryTarget(kind);
      const result = await send({ type: 'ENTRY_STEP', target });
      if (result.skipped) { stopped = true; return; }
      if (result.target !== target || routes.entryForUrl(location.href) !== kind) throw new Error('The sign-in link has changed. The assistant has stopped.');
      stopped = true;
      location.assign(target);
    } catch { stopped = true; }
    finally { busy = false; if (rerun) { rerun = false; schedule(); } }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'RECHECK') {
      stopped = false; approved = false; checkAfter = 0; schedule();
    } else if (message?.type === 'FLOW_WAKE') {
      schedule();
    } else if (message?.type === 'LOGIN_APPROVED') { approved = true; checkAfter = 0; schedule(); }
  });
  const observer = new MutationObserver(schedule);
  observer.observe(document, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['hidden', 'class', 'style', 'href', 'aria-hidden', 'aria-controls', 'aria-disabled'] });
  window.addEventListener('DOMContentLoaded', schedule, { once: true });
  window.addEventListener('pageshow', schedule);
  setInterval(tick, 1_500);
  void tick();
})();
