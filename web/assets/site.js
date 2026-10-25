(() => {
  'use strict';

  if (window.location.protocol === 'https:' || window.location.protocol === 'http:') {
    for (const link of document.querySelectorAll('a[href="index.html"]')) {
      link.setAttribute('href', './');
    }
  }

  const demo = document.querySelector('[data-demo]');
  if (demo) {
    const initial = demo.querySelector('[data-demo-initial]');
    const progress = demo.querySelector('[data-demo-progress]');
    const title = demo.querySelector('[data-demo-title]');
    const replay = demo.querySelector('[data-demo-replay]');
    const confirm = demo.querySelector('[data-demo-confirm]');
    const cancel = demo.querySelector('[data-demo-cancel]');
    const note = document.querySelector('[data-demo-note]');
    const index = document.querySelector('.preview-index');
    const steps = [...demo.querySelectorAll('[data-demo-step]')];
    const timers = new Set();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const initialNote = note.textContent;
    let running = false;

    const clearTimers = () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
    const schedule = (callback, delay) => {
      const timer = window.setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
    };
    const finish = () => {
      steps.forEach(step => { step.classList.remove('is-current'); step.classList.add('is-complete'); });
      title.textContent = demo.dataset.labelComplete;
      note.textContent = demo.dataset.noteComplete;
      replay.disabled = false;
      running = false;
      index.textContent = '03 / 03';
    };
    const reset = () => {
      clearTimers();
      running = false;
      initial.hidden = false;
      progress.hidden = true;
      steps.forEach(step => step.classList.remove('is-complete', 'is-current'));
      note.textContent = initialNote;
      index.textContent = '01 / 03';
      confirm.focus({ preventScroll: true });
    };

    confirm.addEventListener('click', () => {
      if (running) return;
      running = true;
      clearTimers();
      initial.hidden = true;
      progress.hidden = false;
      progress.focus({ preventScroll: true });
      title.textContent = demo.dataset.labelRunning;
      note.textContent = demo.dataset.noteRunning;
      replay.disabled = true;
      steps.forEach(step => step.classList.remove('is-current', 'is-complete'));
      steps[0].classList.add('is-complete');
      steps[1].classList.add('is-current');
      index.textContent = '02 / 03';
      if (reducedMotion.matches) { finish(); replay.focus({ preventScroll: true }); return; }
      schedule(() => {
        steps[1].classList.remove('is-current');
        steps[1].classList.add('is-complete');
        steps[2].classList.add('is-current');
      }, 950);
      schedule(finish, 2000);
    });
    cancel.addEventListener('click', () => {
      note.textContent = demo.dataset.noteCanceled;
    });
    replay.addEventListener('click', reset);
    window.addEventListener('pagehide', clearTimers);
  }

  for (const button of document.querySelectorAll('[data-copy]')) {
    let resetTimer;
    button.addEventListener('click', async () => {
      const label = button.querySelector('span');
      const status = button.closest('li').querySelector('[data-copy-status]');
      const value = button.dataset.copy;
      let copied = false;
      if (navigator.clipboard && window.isSecureContext) {
        try { await navigator.clipboard.writeText(value); copied = true; } catch { /* Use the local-file fallback below. */ }
      }
      if (!copied) {
        const field = document.createElement('textarea');
        field.value = value;
        field.setAttribute('readonly', '');
        field.setAttribute('aria-hidden', 'true');
        field.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.append(field);
        field.select();
        try { copied = document.execCommand('copy'); } catch { copied = false; }
        field.remove();
        button.focus({ preventScroll: true });
      }
      window.clearTimeout(resetTimer);
      label.textContent = copied ? button.dataset.copySuccess : button.dataset.copyLabel;
      status.textContent = copied ? button.dataset.copySuccess : status.dataset.copyFailed;
      status.classList.toggle('sr-only', copied);
      if (copied) resetTimer = window.setTimeout(() => { label.textContent = button.dataset.copyLabel; status.textContent = ''; }, 2400);
    });
  }
})();
