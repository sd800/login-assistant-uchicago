(() => {
  'use strict';
  const routes = globalThis.UChiLoginRoutes;
  const kind = routes.entryForUrl(location.href);
  if (window.top !== window || !kind) return;
  const dom = globalThis.UChiLoginDOM;
  let busy = false;
  let stopped = false;
  let readyAt = 0;
  let selectedStudents = false;
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'The extension disconnected. Reload this page and try again.');
    return response.result;
  }
  async function tick() {
    if (busy || stopped || !document.body || routes.entryForUrl(location.href) !== kind) return;
    busy = true;
    try {
      const state = await send({ type: 'ENTRY_DETECTED' });
      if (state.status !== 'active') return;
      readyAt ||= Date.now();
      let button;
      if (kind === 'portal') {
        const student = dom.studentEntry(document);
        if (student && !dom.visible(student.button) && !selectedStudents) {
          selectedStudents = true;
          student.tab.click();
        }
        if (!student || !dom.visible(student.button)) {
          if (Date.now() - readyAt > 15_000) { await send({ type: 'FLOW_ERROR' }); stopped = true; }
          return;
        }
        button = student.button;
      }
      const target = routes.entryTarget(kind);
      const result = await send({ type: 'ENTRY_STEP', target });
      if (result.skipped) { stopped = true; return; }
      if (result.target !== target || routes.entryForUrl(location.href) !== kind) throw new Error('The sign-in link has changed. The assistant has stopped.');
      stopped = true;
      if (button) {
        // Recheck after the asynchronous authorization; never click a changed link.
        const current = dom.studentEntry(document);
        if (current?.button !== button || !dom.visible(button)) { await send({ type: 'FLOW_ERROR' }); return; }
        button.target = '_self';
        button.click();
      } else location.assign(target);
    } catch { stopped = true; }
    finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'RECHECK') { stopped = false; readyAt = 0; selectedStudents = false; void tick(); }
  });
  setInterval(tick, 600);
  void tick();
})();
