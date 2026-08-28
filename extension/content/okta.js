(() => {
  'use strict';
  if (window.top !== window || location.origin !== 'https://uchicago.okta.com') return;
  const dom = globalThis.UChiLoginDOM;
  let busy = false;
  let stopped = false;
  let lastButton;
  let lastAt = 0;
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "The extension disconnected. Reload this page and try again.");
    return response.result;
  }
  async function tick() {
    if (busy || stopped || !document.body) return;
    busy = true;
    try {
      const detected = dom.detectOkta(document);
      if (!detected) return;
      if (detected.kind === 'error') { await send({ type: 'FLOW_ERROR' }); stopped = true; return; }
      const state = await send({ type: 'LOGIN_DETECTED' });
      if (state.status !== 'active' || !detected.button) return;
      if (lastButton === detected.button && Date.now() - lastAt < 10_000) return;
      // Record the attempt before submission. Never retry passwords automatically.
      const values = await send({ type: 'LOGIN_STEP', step: detected.kind });
      if (values.skipped) return;
      dom.fill(detected.username, values.username);
      dom.fill(detected.password, values.password);
      lastButton = detected.button;
      lastAt = Date.now();
      detected.button.click();
    } catch { stopped = true; }
    finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'RECHECK') { stopped = false; lastButton = null; void tick(); }
  });
  setInterval(tick, 600);
  void tick();
})();
