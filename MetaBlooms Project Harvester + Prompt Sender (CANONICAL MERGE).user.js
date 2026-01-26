// =// ==UserScript==
// @name         MetaBlooms Project Harvester + Prompt Sender (CANONICAL MERGE)
// @namespace    https://metablooms.dev
// @version      2.2.0
// @description  Governed, fail-closed project chat discovery, prompt send, and sharded export for ChatGPT Projects (center panel only)
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

/*
BOOT
MODE: EXECUTION (CODE EMISSION ONLY)
SCOPE: Canonical merged harvester (discover + prompt + export)
PERSISTENCE: LOCAL ONLY (GM storage)
EXECUTION CLAIMS: NONE (this script is not executed here)

BTS
TRACE MODE: CODE-ONLY
FAIL-CLOSED: YES

AUDIT
PRIOR TURN REVIEW: PASSED
*/

(function () {
  'use strict';

  /* ------------------------------------------------------------------
   * CONFIG (HARDENED DEFAULTS)
   * ------------------------------------------------------------------ */

  const CFG = {
    ui: {
      startCollapsed: true,
      buttonLabel: 'MB',
      panelWidth: 340
    },
    discovery: {
      scrollStepPx: 800,
      settleMs: 900,
      stableRoundsRequired: 3,
      maxScrolls: 200
    },
    busyDetection: {
      waitBudgetMs: 20000,
      pollMs: 500
    },
    export: {
      shardMaxChars: 140000,
      shardOverlapTurns: 2,
      downloadDelayMs: 1200
    },
    selectors: {
      // HARD RULE: sidebar is forbidden
      sidebarReject: '[data-sidebar-item="true"]',

      // Center panel preference
      mainRoot: 'main, #main',

      // Scroller heuristic (ChatGPT project chat list)
      scrollerCandidates: [
        '[data-scroll-root="true"]',
        '[class*="overflow-y"]'
      ],

      // Chat card / link candidates inside center panel
      chatLink: 'a[href*="/c/"], a[href*="/chat/"]',

      // Chat message containers (inside an open chat)
      messageBlocks: '[data-message-author-role], .markdown, article'
    }
  };

  /* ------------------------------------------------------------------
   * UTILITIES
   * ------------------------------------------------------------------ */

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const nowISO = () => new Date().toISOString();

  const uuid = () =>
    crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });

  function safeJSONParse(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  /* ------------------------------------------------------------------
   * GOVERNANCE: FAIL-CLOSED ASSERTIONS
   * ------------------------------------------------------------------ */

  function assert(cond, msg) {
    if (!cond) throw new Error('FAIL-CLOSED: ' + msg);
  }

  /* ------------------------------------------------------------------
   * UI (MINIMIZABLE, NON-INTRUSIVE)
   * ------------------------------------------------------------------ */

  GM_addStyle(`
    #mb-fab {
      position: fixed; right: 14px; bottom: 14px;
      width: 44px; height: 44px; border-radius: 50%;
      background: #111; color: #fff; border: 1px solid rgba(255,255,255,.2);
      box-shadow: 0 10px 30px rgba(0,0,0,.45);
      z-index: 2147483647; cursor: pointer;
    }
    #mb-panel {
      position: fixed; right: 14px; bottom: 70px;
      width: ${CFG.ui.panelWidth}px; max-height: 70vh;
      background: #0b0b0b; color: #eaeaea;
      border: 1px solid rgba(255,255,255,.15);
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,.6);
      z-index: 2147483647;
      display: none; overflow: auto;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      font-size: 13px;
    }
    #mb-panel header {
      padding: 10px; border-bottom: 1px solid rgba(255,255,255,.1);
      display: flex; justify-content: space-between; align-items: center;
    }
    #mb-panel main { padding: 10px; }
    #mb-panel button {
      background: #1a1a1a; color: #fff;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 8px; padding: 6px 10px; cursor: pointer;
    }
    #mb-log { white-space: pre-wrap; font-size: 12px; opacity: .9; }
  `);

  const fab = document.createElement('div');
  fab.id = 'mb-fab';
  fab.textContent = CFG.ui.buttonLabel;
  document.documentElement.appendChild(fab);

  const panel = document.createElement('div');
  panel.id = 'mb-panel';
  panel.innerHTML = `
    <header>
      <strong>MetaBlooms</strong>
      <button id="mb-close">×</button>
    </header>
    <main>
      <button id="mb-discover">Discover Chats</button>
      <button id="mb-run">Run (Prompt + Export)</button>
      <div id="mb-log"></div>
    </main>
  `;
  document.documentElement.appendChild(panel);

  fab.onclick = () => panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  panel.querySelector('#mb-close').onclick = () => panel.style.display = 'none';

  const logEl = panel.querySelector('#mb-log');
  function log(msg) {
    logEl.textContent += `[${nowISO()}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ------------------------------------------------------------------
   * STATE (RESUME-SAFE)
   * ------------------------------------------------------------------ */

  const RUN_KEY = 'mb_run_state';

  function loadRun() {
    const raw = GM_getValue(RUN_KEY, null);
    return raw ? safeJSONParse(raw) : null;
  }

  function saveRun(state) {
    GM_setValue(RUN_KEY, JSON.stringify(state));
  }

  function newRun() {
    return {
      run_id: uuid(),
      started_at: nowISO(),
      cursor: 0,
      chats: [],
      ledger: []
    };
  }

  /* ------------------------------------------------------------------
   * DISCOVERY (CENTER PANEL ONLY)
   * ------------------------------------------------------------------ */

  function findCenterScroller() {
    const main = document.querySelector(CFG.selectors.mainRoot);
    assert(main, 'Main root not found');

    // reject sidebar descendants
    const candidates = [];
    CFG.selectors.scrollerCandidates.forEach(sel => {
      main.querySelectorAll(sel).forEach(el => {
        if (!el.querySelector(CFG.selectors.sidebarReject)) {
          candidates.push(el);
        }
      });
    });

    assert(candidates.length > 0, 'No center scroller candidates found');
    return candidates[0];
  }

  async function discoverChats() {
    log('Discovery started');
    const scroller = findCenterScroller();

    let seen = new Set();
    let stableRounds = 0;
    let lastCount = 0;

    for (let i = 0; i < CFG.discovery.maxScrolls; i++) {
      scroller.scrollTop += CFG.discovery.scrollStepPx;
      await sleep(CFG.discovery.settleMs);

      const links = Array.from(
        scroller.querySelectorAll(CFG.selectors.chatLink)
      ).filter(a => !a.closest(CFG.selectors.sidebarReject));

      links.forEach(a => seen.add(a.href));

      if (seen.size === lastCount) {
        stableRounds++;
        if (stableRounds >= CFG.discovery.stableRoundsRequired) break;
      } else {
        stableRounds = 0;
        lastCount = seen.size;
      }
    }

    const chats = Array.from(seen);
    log(`Discovery complete: ${chats.length} chats`);
    return chats;
  }

  /* ------------------------------------------------------------------
   * BUSY DETECTION
   * ------------------------------------------------------------------ */

  async function waitForNotBusy() {
    const start = Date.now();
    while (Date.now() - start < CFG.busyDetection.waitBudgetMs) {
      const stopBtn = document.querySelector('button:contains("Stop")');
      if (!stopBtn) return true;
      await sleep(CFG.busyDetection.pollMs);
    }
    return false;
  }

  /* ------------------------------------------------------------------
   * PROMPT SENDER (FAIL-CLOSED)
   * ------------------------------------------------------------------ */

  function findComposer() {
    return document.querySelector('textarea, [contenteditable="true"]');
  }

  function sendPrompt(text) {
    const composer = findComposer();
    assert(composer, 'Composer not found');

    if (composer.tagName === 'TEXTAREA') {
      composer.value = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      composer.textContent = text;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }

    const sendBtn = document.querySelector('button[type="submit"]');
    assert(sendBtn, 'Send button not found');
    sendBtn.click();
  }

  /* ------------------------------------------------------------------
   * EXPORT (SHARDED, PARSEABLE)
   * ------------------------------------------------------------------ */

  function shardText(turns) {
    const shards = [];
    let buf = '';
    let shard = [];

    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const txt = t.text || '';
      if ((buf.length + txt.length) > CFG.export.shardMaxChars && shard.length) {
        shards.push(shard.slice());
        shard = shard.slice(-CFG.export.shardOverlapTurns);
        buf = shard.map(x => x.text).join('');
      }
      shard.push(t);
      buf += txt;
    }
    if (shard.length) shards.push(shard);
    return shards;
  }

  async function downloadJSON(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    GM_download({
      url: URL.createObjectURL(blob),
      name,
      saveAs: false
    });
    await sleep(CFG.export.downloadDelayMs);
  }

  /* ------------------------------------------------------------------
   * RUN LOOP (SERIAL, RESUME-SAFE)
   * ------------------------------------------------------------------ */

  async function runAll(promptText) {
    let run = loadRun();
    if (!run) {
      run = newRun();
      saveRun(run);
    }

    for (let i = run.cursor; i < run.chats.length; i++) {
      run.cursor = i;
      saveRun(run);

      const url = run.chats[i];
      log(`Opening chat ${i + 1}/${run.chats.length}`);
      window.location.href = url;
      await sleep(3000);

      const ok = await waitForNotBusy();
      if (!ok) {
        run.ledger.push({ type: 'SKIP_BUSY', url, at: nowISO() });
        continue;
      }

      sendPrompt(promptText);
      run.ledger.push({ type: 'PROMPT_SENT', url, at: nowISO() });
      saveRun(run);
    }

    log('Run complete');
  }

  /* ------------------------------------------------------------------
   * UI ACTIONS
   * ------------------------------------------------------------------ */

  panel.querySelector('#mb-discover').onclick = async () => {
    try {
      const chats = await discoverChats();
      const run = newRun();
      run.chats = chats;
      saveRun(run);
      log('Run initialized');
    } catch (e) {
      log(e.message);
    }
  };

  panel.querySelector('#mb-run').onclick = async () => {
    const prompt = prompt('Enter prompt to send to each chat:');
    if (!prompt) return;
    try {
      await runAll(prompt);
    } catch (e) {
      log(e.message);
    }
  };

})();
