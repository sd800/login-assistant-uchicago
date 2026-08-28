(() => {
  'use strict';
  if (window.top !== window || !location.hostname.endsWith('.duosecurity.com')) return;
  const dom = globalThis.UChiLoginDOM;
  const jobs = new Map();
  const delays = new Set();
  let busy = false;
  let autoStopped = false;
  let clicks = 0;
  const clicked = new WeakSet();
  async function send(message) {
    const envelope = await chrome.runtime.sendMessage(message);
    if (!envelope?.ok) throw new Error(envelope?.error || "The extension disconnected. Reload this page and try again.");
    return envelope.result;
  }
  async function waitForFlow(pageId, timeout) {
    const handshakeUntil = Date.now() + 1_500;
    const deadline = Date.now() + Math.min(120_000, Math.max(1_000, Number(timeout) || 120_000));
    while (jobs.has(pageId)) {
      const flow = await send({ type: 'STATUS' });
      if (flow.trusted) return true;
      if (!flow.pending || Date.now() >= deadline || Date.now() >= handshakeUntil) return false;
      await new Promise(resolve => {
        const timer = setTimeout(() => { delays.delete(timer); resolve(); }, 75);
        delays.add(timer);
      });
    }
    return false;
  }
  function respond(id, result) {
    window.postMessage({ channel: 'uchicago-passkeys-v1', direction: 'response', id, result }, location.origin);
  }
  async function poll(pageId) {
    const job = jobs.get(pageId);
    if (!job) return;
    try {
      const result = await send({ type: 'PK_POLL', id: job });
      if (!jobs.has(pageId)) return;
      if (result.pending) {
        const timer = setTimeout(() => { delays.delete(timer); void poll(pageId); }, 350);
        delays.add(timer);
      } else { jobs.delete(pageId); respond(pageId, result); }
    } catch { jobs.delete(pageId); respond(pageId, { error: { name: 'NotAllowedError', message: "Authentication was interrupted. Try again or use another passkey provider." } }); }
  }
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'uchicago-passkeys-v1') return;
    const data = event.data;
    if (typeof data.id !== 'string' || !/^[a-f0-9-]{36}$/.test(data.id)) return;
    if (data.direction === 'cancel') {
      const job = jobs.get(data.id);
      jobs.delete(data.id);
      if (job) void send({ type: 'PK_CANCEL', id: job }).catch(() => {});
      return;
    }
    if (data.direction !== 'request' || !['get', 'create'].includes(data.kind)) return;
    if (jobs.size || jobs.has(data.id)) { respond(data.id, { error: { name: 'NotAllowedError', message: "Another authentication request is already in progress." } }); return; }
    jobs.set(data.id, null);
    autoStopped = true;
    try {
      const trusted = await waitForFlow(data.id, data.options?.timeout);
      if (!jobs.has(data.id)) return;
      if (!trusted) { jobs.delete(data.id); respond(data.id, { fallback: true }); return; }
      const result = await send({ type: 'PK_BEGIN', kind: data.kind, options: data.options });
      if (!jobs.has(data.id)) { if (result.id) void send({ type: 'PK_CANCEL', id: result.id }); return; }
      if (result.pending && result.id) { jobs.set(data.id, result.id); void poll(data.id); }
      else { jobs.delete(data.id); respond(data.id, result); }
    } catch { jobs.delete(data.id); respond(data.id, { fallback: true }); }
  });
  async function tick() {
    if (busy || autoStopped || !document.body) return;
    busy = true;
    try {
      const status = await send({ type: 'STATUS' });
      if (!status.active || !status.trusted) return;
      if (dom.error(document)) { autoStopped = true; await send({ type: 'FLOW_ERROR' }); return; }
      const button = dom.duoChoice(document);
      if (button && !clicked.has(button) && clicks < 3) {
        clicked.add(button); clicks++; button.click();
      }
    } catch { autoStopped = true; }
    finally { busy = false; }
  }
  setInterval(tick, 700);
  window.addEventListener('pagehide', () => {
    for (const timer of delays) clearTimeout(timer);
    for (const id of jobs.values()) if (id) void send({ type: 'PK_CANCEL', id }).catch(() => {});
    jobs.clear();
  });
})();
