// ==UserScript==
// @name         MetaBlooms Project Harvester (Canonical) v2.4.0
// @namespace    https://metablooms.ai
// @version      2.4.0
// @description  Canonical, fail-closed ChatGPT Project harvester with SPA-safe resume FSM (C-backed hardening)
// @match        https://chatgpt.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  /************************************************************
   * GOVERNANCE PREAMBLE (MetaBlooms)
   ************************************************************/
  const GOV = {
    REQUIRE_CENTER_PANEL: true,
    REJECT_SIDEBAR: true,
    FAIL_CLOSED: true
  };

  /************************************************************
   * UTILITIES (FIXES: sleep is not defined)
   ************************************************************/
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  const log = (...a) => console.log('[MetaBlooms]', ...a);
  const warn = (...a) => console.warn('[MetaBlooms]', ...a);
  const failClosed = (msg) => {
    console.error('[MetaBlooms][FAIL-CLOSED]', msg);
    GM_setValue('MB_LAST_ERROR', msg);
    throw new Error(msg);
  };

  /************************************************************
   * SPA NAVIGATION DETECTION (C-BACKED)
   * History API patch + popstate
   ************************************************************/
  (function patchHistory() {
    const fire = () => window.dispatchEvent(new Event('mb:locationchange'));
    ['pushState', 'replaceState'].forEach(fn => {
      const orig = history[fn];
      history[fn] = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
    });
    window.addEventListener('popstate', fire);
  })();

  /************************************************************
   * RUN STATE (SINGLE-TAB FSM)
   ************************************************************/
  const RUN = GM_getValue('MB_RUN', {
    phase: 'IDLE',        // IDLE | DISCOVER | OPEN_CHAT | PROMPT | RETURN
    cursor: 0,
    chats: [],
    runId: new Date().toISOString()
  });

  const saveRun = () => GM_setValue('MB_RUN', RUN);

  /************************************************************
   * SELECTOR DISCOVERY (REBASING — WORKING LOGIC PRESERVED)
   ************************************************************/
  function findCenterScroller() {
    // Explicitly reject sidebar
    const candidates = [...document.querySelectorAll('[data-scroll-root="true"], main, #main')]
      .filter(el => !el.closest('[data-sidebar-item="true"]'));

    if (!candidates.length) return null;
    return candidates[0];
  }

  /************************************************************
   * DISCOVERY (SCROLL-TO-END + DEDUPE)
   ************************************************************/
  async function discoverChats() {
    log('Discovery started');
    const scroller = findCenterScroller();
    if (!scroller) failClosed('No center scroller found');

    let stableRounds = 0;
    let lastCount = 0;
    const hrefs = new Set();

    while (stableRounds < 5) {
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(600);

      document.querySelectorAll('a[href*="/g/"]').forEach(a => hrefs.add(a.href));

      if (hrefs.size === lastCount) stableRounds++;
      else {
        stableRounds = 0;
        lastCount = hrefs.size;
      }
    }

    RUN.chats = [...hrefs];
    RUN.phase = 'OPEN_CHAT';
    RUN.cursor = 0;
    saveRun();

    log(`Discovered ${RUN.chats.length} chats`);
  }

  /************************************************************
   * PROMPT SENDER (MERGED FROM v1.5.0)
   ************************************************************/
  async function sendPrompt() {
    const textarea = document.querySelector('textarea');
    if (!textarea) {
      warn('Composer not ready, retrying');
      await sleep(1000);
      return false;
    }

    textarea.value = GM_getValue('MB_PROMPT', '<<PROMPT NOT SET>>');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    const btn = textarea.closest('form')?.querySelector('button[type="submit"]');
    if (!btn) failClosed('Submit button not found');

    btn.click();
    return true;
  }

  /************************************************************
   * FSM RESUME LOGIC (SINGLE TAB)
   ************************************************************/
  async function tick() {
    log('FSM phase=', RUN.phase, 'cursor=', RUN.cursor);

    if (RUN.phase === 'DISCOVER') {
      await discoverChats();
    }

    if (RUN.phase === 'OPEN_CHAT') {
      if (RUN.cursor >= RUN.chats.length) {
        RUN.phase = 'IDLE';
        saveRun();
        log('Run complete');
        return;
      }
      const href = RUN.chats[RUN.cursor];
      RUN.phase = 'PROMPT';
      saveRun();
      location.href = href;
      return;
    }

    if (RUN.phase === 'PROMPT') {
      const ok = await sendPrompt();
      if (!ok) return;

      await sleep(2000);
      RUN.phase = 'RETURN';
      saveRun();
      location.href = 'https://chatgpt.com/g/g-p-689c74a1b2c881919eef34000e072573-metabrain/project';
      return;
    }

    if (RUN.phase === 'RETURN') {
      RUN.cursor++;
      RUN.phase = 'OPEN_CHAT';
      saveRun();
      await sleep(500);
      tick();
    }
  }

  /************************************************************
   * UI (MINIMIZABLE, NON-BLOCKING)
   ************************************************************/
  function mountUI() {
    if (document.getElementById('mb-ui')) return;

    GM_addStyle(`
      #mb-ui { position: fixed; bottom: 20px; right: 20px; z-index: 99999;
               background:#111;color:#fff;padding:8px;border-radius:8px;font-size:12px; }
      #mb-ui button { margin:2px; }
    `);

    const div = document.createElement('div');
    div.id = 'mb-ui';
    div.innerHTML = `
      <b>MB</b><br/>
      <button id="mb-discover">Discover</button>
      <button id="mb-run">Run</button>
    `;
    document.body.appendChild(div);

    div.querySelector('#mb-discover').onclick = () => {
      RUN.phase = 'DISCOVER';
      saveRun();
      tick();
    };
    div.querySelector('#mb-run').onclick = () => tick();
  }

  /************************************************************
   * BOOT
   ************************************************************/
  window.addEventListener('mb:locationchange', () => setTimeout(tick, 500));
  window.addEventListener('load', () => {
    mountUI();
    if (RUN.phase !== 'IDLE') tick();
  });

})();
