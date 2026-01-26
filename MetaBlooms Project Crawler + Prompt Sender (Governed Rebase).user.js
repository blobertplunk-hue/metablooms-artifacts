// ==UserScript==
// @name         MetaBlooms Project Crawler + Prompt Sender (Governed Rebase)
// @namespace    metablooms.project.harvester
// @version      2.1.1
// @description  Rebased from v2.1.0 with strict governance invariants enforced. No destructive refactors.
// @match        https://chatgpt.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  /******************************************************************
   * GOVERNANCE CONSTANTS (AUTHORITATIVE)
   ******************************************************************/
  const PROJECT_URL =
    'https://chatgpt.com/g/g-p-689c74a1b2c881919eef34000e072573-metabrain/project';

  const RUN_KEY = 'MB_RUN_STATE_v2_1_1';
  const DISCOVERY_KEY = 'MB_DISCOVERY_SET_v2_1_1';
  const PROMPT_KEY = 'MB_PROMPT_TEXT_v2_1_1';

  const BUSY_WAIT_MS = 8000;

  /******************************************************************
   * BOOT / AUDIT HELPERS
   ******************************************************************/
  function log(msg) {
    console.log(`[MetaBlooms v2.1.1] ${msg}`);
    uiLog(msg);
  }

  function failClosed(reason) {
    log(`FAIL-CLOSED: ${reason}`);
    alert(`MetaBlooms FAIL-CLOSED:\n${reason}`);
    throw new Error(reason);
  }

  /******************************************************************
   * URL & CONTEXT GUARDS (P1-1, P1-2)
   ******************************************************************/
  function assertProjectContext() {
    if (location.href !== PROJECT_URL) {
      failClosed('Not on canonical project URL');
    }
  }

  function isSidebarNode(node) {
    if (!node) return false;
    return (
      node.closest('[data-sidebar]') ||
      node.closest('[data-sidebar-item]') ||
      node.closest('nav')
    );
  }

  /******************************************************************
   * UI (PRESERVED FROM v2.1.0, MINIMAL ADDITIONS)
   ******************************************************************/
  let ui;
  function buildUI() {
    ui = document.createElement('div');
    ui.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999999;
      background: #111;
      color: #fff;
      font-family: monospace;
      padding: 10px;
      border-radius: 8px;
      width: 280px;
    `;

    ui.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px;">MetaBlooms v2.1.1</div>
      <textarea id="mb_prompt" placeholder="Paste prompt here"
        style="width:100%;height:60px;"></textarea>
      <button id="mb_discover">Discover</button>
      <button id="mb_run">Run</button>
      <div id="mb_log"
        style="margin-top:6px;font-size:11px;max-height:120px;overflow:auto;"></div>
    `;

    document.body.appendChild(ui);

    document.getElementById('mb_discover').onclick = discover;
    document.getElementById('mb_run').onclick = run;
  }

  function uiLog(msg) {
    const box = document.getElementById('mb_log');
    if (!box) return;
    const div = document.createElement('div');
    div.textContent = msg;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  /******************************************************************
   * DISCOVERY (UNCHANGED CORE, ADDED FREEZE)
   ******************************************************************/
  function discover() {
    assertProjectContext();
    log('Discovery started');

    const anchors = Array.from(document.querySelectorAll('a'))
      .filter(a => a.href && a.href.includes('/c/'))
      .filter(a => !isSidebarNode(a));

    const urls = [...new Set(anchors.map(a => a.href))];

    if (!urls.length) {
      failClosed('No project chats discovered');
    }

    GM_setValue(DISCOVERY_KEY, urls);
    GM_setValue(RUN_KEY, { phase: 'IDLE', cursor: 0 });

    log(`Discovered ${urls.length} project chats`);
  }

  /******************************************************************
   * FSM / RUN (P1-4, P2-1, P2-2, P3-2)
   ******************************************************************/
  function run() {
    const prompt = document.getElementById('mb_prompt').value.trim();
    if (!prompt) failClosed('Prompt not set');

    GM_setValue(PROMPT_KEY, prompt);

    const urls = GM_getValue(DISCOVERY_KEY, []);
    if (!urls.length) failClosed('No discovery set present');

    GM_setValue(RUN_KEY, {
      phase: 'OPEN_CHAT',
      cursor: 0,
      target: urls[0],
    });

    log('RUN initialized; navigating to first chat');
    location.href = urls[0];
  }

  function resumeIfNeeded() {
    const run = GM_getValue(RUN_KEY, null);
    if (!run) return;

    const urls = GM_getValue(DISCOVERY_KEY, []);
    if (!urls.length) failClosed('Discovery set missing during resume');

    if (run.phase === 'OPEN_CHAT') {
      handleChat(run, urls);
    }
  }

  function handleChat(run, urls) {
    if (!location.href.includes('/c/')) return;

    log(`Handling chat ${run.cursor + 1}/${urls.length}`);

    waitForComposer()
      .then(() => {
        const prompt = GM_getValue(PROMPT_KEY);
        if (!prompt) failClosed('Prompt missing at send time');

        const textarea = document.querySelector('textarea');
        textarea.value = prompt;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        const sendBtn = document.querySelector('button');
        sendBtn.click();

        setTimeout(() => advance(run, urls), BUSY_WAIT_MS);
      })
      .catch(() => {
        log('Chat busy; skipping');
        advance(run, urls);
      });
  }

  function advance(run, urls) {
    run.cursor++;
    if (run.cursor >= urls.length) {
      log('RUN complete');
      GM_deleteValue(RUN_KEY);
      return;
    }

    run.target = urls[run.cursor];
    GM_setValue(RUN_KEY, run);
    location.href = PROJECT_URL;
  }

  function waitForComposer() {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const ta = document.querySelector('textarea');
        if (ta && !ta.disabled) {
          clearInterval(iv);
          resolve();
        }
        if (Date.now() - start > BUSY_WAIT_MS) {
          clearInterval(iv);
          reject();
        }
      }, 250);
    });
  }

  /******************************************************************
   * BOOT
   ******************************************************************/
  try {
    buildUI();
    resumeIfNeeded();
    log('Boot complete');
  } catch (e) {
    console.error(e);
  }
})();
