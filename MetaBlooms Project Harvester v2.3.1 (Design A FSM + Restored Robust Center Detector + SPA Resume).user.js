// ==UserScript==
// @name         MetaBlooms Project Harvester v2.3.1 (Design A FSM + Restored Robust Center Detector + SPA Resume)
// @namespace    https://metablooms.dev/tampermonkey
// @version      2.3.1
// @description  ChatGPT Projects harvester: robust center list discovery (NOT sidebar), scroll-to-end, single-tab FSM with SPA route-change resume, prompt send, skip busy, export shards.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_download
// ==/UserScript==

/*
BOOT
MODE: EXECUTION (script emission)
SCOPE: D2 harvester hardening — restore robust center detector + SPA resume FSM
PERSISTENCE: GM storage only (run state, ledger)
EXECUTION CLAIMS: NONE

BTS
- Fail-closed diagnostics
- Append-only run ledger
- Cursor advancement guarantees

AUDIT (why prior stalled)
- Single-tab loops die under navigation AND ChatGPT SPA routing does not reload the page.
- Fix: persist phase+cursor BEFORE nav + resume on URL change (pushState/replaceState/popstate + polling).
*/

(() => {
  "use strict";

  /******************************************************************
   * CONFIG
   ******************************************************************/
  const CFG = {
    ui: { label: "MB", z: 2147483647, panelW: 380, bottomPx: 16, rightPx: 16 },

    // Discovery scroll
    discovery: {
      maxRounds: 2200,
      scrollStepPx: 900,
      settleMs: 260,
      stableRoundsToStop: 12,
      lowCountFailClosed: 3,
    },

    // Busy / response wait
    busy: {
      waitBudgetMs: 45000,
      pollMs: 500,
    },

    // Composer readiness
    composer: {
      waitBudgetMs: 30000,
      pollMs: 300,
    },

    // Export
    export: {
      shardMaxChars: 140000,
      downloadDelayMs: 1200,
    },

    // Hard constraints from you
    constraints: {
      rejectSidebarAttr: 'data-sidebar-item="true"',
    },

    // Selectors (multi-strategy)
    selectors: {
      sidebarAttr: '[data-sidebar-item="true"]',
      sidebarContainers: "nav, aside",
      chatLink: 'a[href*="/c/"], a[href*="/chat/"]',
      messageAuthorRole: '[data-message-author-role]',

      composer: [
        'textarea#prompt-textarea',
        'textarea[data-testid="prompt-textarea"]',
        'textarea',
        '[contenteditable="true"][data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
      ],

      sendButton: [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send"]',
        'form button[type="submit"]',
        'button[type="submit"]',
      ],
    },

    storage: {
      run: "mb_run_state_v231",
    },
  };

  /******************************************************************
   * STATE
   ******************************************************************/
  function loadRun() {
    try {
      const raw = GM_getValue(CFG.storage.run, null);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function saveRun(run) {
    GM_setValue(CFG.storage.run, JSON.stringify(run));
  }
  function clearRun() {
    GM_deleteValue(CFG.storage.run);
  }

  function newRun() {
    return {
      schema: "mb_run_v231",
      run_id: `mb_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      started_at: new Date().toISOString(),
      project_url: null,

      // Discovery results
      chats: [], // [{href,title}]
      dedupe: {},

      // FSM
      phase: "IDLE", // IDLE | DISCOVER | OPEN_CHAT | IN_CHAT | RETURN_TO_PROJECT | COMPLETE | FAIL
      cursor: 0,
      targetHref: null,

      // Prompt
      prompt: "BOOT, BTS, audit the previous turn.",

      // Ledger
      ledger: [],
    };
  }

  function ledger(evt, data = {}) {
    const run = loadRun();
    if (!run) return;
    run.ledger.push({ t: new Date().toISOString(), evt, ...data });
    saveRun(run);
    uiLog(`[LEDGER] ${evt}`);
  }

  /******************************************************************
   * UI
   ******************************************************************/
  GM_addStyle(`
    #mb-wrap{position:fixed;right:${CFG.ui.rightPx}px;bottom:${CFG.ui.bottomPx}px;z-index:${CFG.ui.z};font-family:system-ui}
    #mb-bubble{width:44px;height:44px;border-radius:999px;display:grid;place-items:center;
      background:#111;color:#fff;cursor:pointer;border:1px solid rgba(255,255,255,.2)}
    #mb-panel{width:${CFG.ui.panelW}px;max-height:70vh;display:none;background:#0b0b0b;color:#fff;
      border-radius:14px;border:1px solid rgba(255,255,255,.2);padding:10px;margin-top:8px;overflow:auto}
    #mb-panel button{border-radius:10px;border:1px solid rgba(255,255,255,.2);
      background:#1a1a1a;color:#fff;padding:6px 10px;cursor:pointer;margin-right:6px;margin-top:6px}
    #mb-log{width:100%;min-height:220px;background:#000;color:#0f0;font-size:12px;padding:6px;white-space:pre-wrap}
    #mb-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
    #mb-small{opacity:.8;font-size:12px;margin-top:6px}
  `);

  const wrap = document.createElement("div");
  wrap.id = "mb-wrap";
  wrap.innerHTML = `
    <div id="mb-bubble">${CFG.ui.label}</div>
    <div id="mb-panel">
      <div id="mb-row">
        <button id="mb-start">Start</button>
        <button id="mb-discover">Discover</button>
        <button id="mb-run">Run/Resume</button>
        <button id="mb-stop">Stop</button>
      </div>
      <div id="mb-small">
        Center-list only. Sidebar rejected via ${CFG.constraints.rejectSidebarAttr}.
      </div>
      <pre id="mb-log"></pre>
    </div>`;
  document.documentElement.appendChild(wrap);

  const bubble = wrap.querySelector("#mb-bubble");
  const panel = wrap.querySelector("#mb-panel");
  const logEl = wrap.querySelector("#mb-log");

  bubble.onclick = () => (panel.style.display = panel.style.display === "none" ? "block" : "none");

  function uiLog(s) {
    logEl.textContent += `[${new Date().toISOString()}] ${s}\n`;
  }

  function failClosed(reason, diag = {}) {
    ledger("FAIL_CLOSED", { reason, diag, url: location.href });
    uiLog(`FAIL-CLOSED: ${reason}\n${JSON.stringify(diag, null, 2)}`);
    alert(`MetaBlooms FAIL-CLOSED:\n${reason}\n\n${JSON.stringify(diag, null, 2)}`);
    // mark run
    const run = loadRun();
    if (run) {
      run.phase = "FAIL";
      saveRun(run);
    }
    throw new Error(reason);
  }

  /******************************************************************
   * SPA ROUTE CHANGE RESUME (CRITICAL)
   ******************************************************************/
  let lastHref = location.href;

  function onRouteChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    uiLog(`Route change detected → ${location.href}`);
    // Resume FSM on route change
    setTimeout(() => {
      try { fsmTick(); } catch (e) { uiLog(`FSM error: ${e.message}`); }
    }, 250);
  }

  function installRouteWatcher() {
    // Patch pushState/replaceState
    const _push = history.pushState;
    const _rep = history.replaceState;

    history.pushState = function (...args) {
      const r = _push.apply(this, args);
      onRouteChange();
      return r;
    };
    history.replaceState = function (...args) {
      const r = _rep.apply(this, args);
      onRouteChange();
      return r;
    };

    window.addEventListener("popstate", () => onRouteChange());

    // Poll fallback (covers cases where patch is bypassed)
    setInterval(() => onRouteChange(), 500);
  }

  /******************************************************************
   * ROBUST CENTER SCROLLER DETECTOR (RESTORED PRINCIPLE)
   * - Reject anything in/containing sidebar attr
   * - Score candidates by: number of /c/ links + proximity to viewport center + size
   ******************************************************************/
  function isSidebarish(el) {
    if (!el) return false;
    if (el.closest && el.closest(CFG.selectors.sidebarContainers)) return true;
    if (el.closest && el.closest(CFG.selectors.sidebarAttr)) return true;
    if (el.querySelector && el.querySelector(CFG.selectors.sidebarAttr)) return true;
    return false;
  }

  function isScrollable(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    const oy = cs.overflowY;
    const scrollable = (oy === "auto" || oy === "scroll");
    return scrollable && (el.scrollHeight > el.clientHeight + 40);
  }

  function countChatLinks(el) {
    try {
      return el.querySelectorAll(CFG.selectors.chatLink).length;
    } catch {
      return 0;
    }
  }

  function centerScore(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const vx = window.innerWidth / 2;
    const vy = window.innerHeight / 2;
    const dist = Math.hypot(cx - vx, cy - vy);

    // Higher is better: more links, bigger, closer to center
    const links = countChatLinks(el);
    const area = Math.max(1, rect.width * rect.height);
    const centerBonus = 1 / Math.max(1, dist);

    return (links * 1000) + (Math.log(area) * 10) + (centerBonus * 10000);
  }

  function findBestCenterScroller() {
    // Prefer within main if present, but do not require it.
    const roots = [];
    const main = document.querySelector("main, #main");
    if (main) roots.push(main);
    roots.push(document.body);

    const candidates = [];
    for (const root of roots) {
      const els = Array.from(root.querySelectorAll("div,section,main,ul,ol"))
        .filter(el => !isSidebarish(el))
        .filter(el => isScrollable(el))
        .filter(el => countChatLinks(el) > 0);
      candidates.push(...els);
    }

    // Dedupe by reference
    const uniq = Array.from(new Set(candidates));

    if (!uniq.length) {
      failClosed("No center scroller candidates found", {
        hint: "Candidate filter: scrollable + contains /c/ links + not sidebarish",
        url: location.href,
      });
    }

    uniq.sort((a, b) => centerScore(b) - centerScore(a));

    const best = uniq[0];
    if (!best) failClosed("Center scroller selection failed");

    return best;
  }

  /******************************************************************
   * DISCOVERY: scroll-to-end with stable rounds + dedupe
   ******************************************************************/
  async function discoverChats() {
    const run = loadRun() || newRun();
    run.project_url = location.href;

    uiLog("Discovery started");
    ledger("DISCOVERY_START", { url: location.href });

    const scroller = findBestCenterScroller();

    const seen = new Map();
    let stable = 0;
    let last = 0;

    for (let i = 0; i < CFG.discovery.maxRounds; i++) {
      const links = Array.from(scroller.querySelectorAll(CFG.selectors.chatLink));

      for (const a of links) {
        if (isSidebarish(a)) continue;
        const href = a.href;
        if (!href) continue;
        if (!href.includes("/c/")) continue;

        const title = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim() || "(untitled)";
        if (!seen.has(href)) seen.set(href, title);
      }

      if (seen.size === last) stable++;
      else stable = 0;

      last = seen.size;

      if (stable >= CFG.discovery.stableRoundsToStop) break;

      scroller.scrollTop += CFG.discovery.scrollStepPx;
      await sleep(CFG.discovery.settleMs);
    }

    if (seen.size <= CFG.discovery.lowCountFailClosed) {
      failClosed("LOW_DISCOVERY_COUNT", { count: seen.size });
    }

    run.chats = [...seen.entries()].map(([href, title]) => ({ href, title }));
    run.cursor = 0;
    run.phase = "OPEN_CHAT";
    run.targetHref = run.chats[0]?.href || null;

    saveRun(run);
    ledger("DISCOVERY_COMPLETE", { count: run.chats.length });
    uiLog(`Discovery complete: ${run.chats.length} chats`);
  }

  /******************************************************************
   * BUSY + COMPOSER + SEND
   ******************************************************************/
  function isGenerating() {
    // Heuristic: "Stop generating" button or spinning state.
    const btns = Array.from(document.querySelectorAll("button"));
    return btns.some(b => (b.textContent || "").toLowerCase().includes("stop generating"));
  }

  async function waitForNotBusy() {
    const start = Date.now();
    while (Date.now() - start < CFG.busy.waitBudgetMs) {
      if (!isGenerating()) return true;
      await sleep(CFG.busy.pollMs);
    }
    return false;
  }

  async function waitForComposerReady() {
    const start = Date.now();
    while (Date.now() - start < CFG.composer.waitBudgetMs) {
      const composer = CFG.selectors.composer.map(s => document.querySelector(s)).find(Boolean);
      const sendBtn = CFG.selectors.sendButton.map(s => document.querySelector(s)).find(Boolean);
      if (composer && sendBtn && !sendBtn.disabled) return { composer, sendBtn };
      await sleep(CFG.composer.pollMs);
    }
    return null;
  }

  function setComposer(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA") {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function getLastAssistantText() {
    const nodes = Array.from(document.querySelectorAll(CFG.selectors.messageAuthorRole));
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].getAttribute("data-message-author-role") === "assistant") {
        return (nodes[i].innerText || nodes[i].textContent || "").trim();
      }
    }
    return "";
  }

  async function downloadJson(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    GM_download({ url, name, saveAs: false });
    await sleep(CFG.export.downloadDelayMs);
  }

  /******************************************************************
   * VIEW DETECTION
   ******************************************************************/
  function isProjectView() {
    // Projects URL forms can vary; keep it permissive.
    return location.href.includes("/project");
  }
  function isChatView() {
    return /\/c\/[a-zA-Z0-9_-]+/.test(location.pathname);
  }

  /******************************************************************
   * FSM TICK (Design A)
   ******************************************************************/
  async function fsmTick() {
    const run = loadRun();
    if (!run || run.phase === "IDLE" || run.phase === "COMPLETE" || run.phase === "FAIL") return;

    uiLog(`FSM phase=${run.phase} cursor=${run.cursor}`);

    // Phase: DISCOVER (must be on project view)
    if (run.phase === "DISCOVER") {
      if (!isProjectView()) {
        uiLog("DISCOVER phase but not on project view; navigating back to project_url");
        if (run.project_url) location.href = run.project_url;
        return;
      }
      await discoverChats();
      // discoverChats sets OPEN_CHAT + targetHref and saves
      const r2 = loadRun();
      if (r2?.targetHref) {
        uiLog(`Navigate → first chat: ${r2.targetHref}`);
        ledger("NAV_TO_CHAT", { href: r2.targetHref, cursor: r2.cursor });
        // Persist intent BEFORE nav
        r2.phase = "IN_CHAT";
        saveRun(r2);
        location.href = r2.targetHref;
      }
      return;
    }

    // Phase: OPEN_CHAT (select next chat and navigate)
    if (run.phase === "OPEN_CHAT") {
      if (!isProjectView()) {
        uiLog("OPEN_CHAT phase but not on project view; navigating back to project_url");
        if (run.project_url) location.href = run.project_url;
        return;
      }

      const chat = run.chats[run.cursor];
      if (!chat) {
        run.phase = "COMPLETE";
        saveRun(run);
        ledger("RUN_COMPLETE", { count: run.chats.length });
        uiLog("RUN COMPLETE");
        alert("MetaBlooms run complete.");
        return;
      }

      run.targetHref = chat.href;
      // Persist intent BEFORE nav
      run.phase = "IN_CHAT";
      saveRun(run);
      ledger("NAV_TO_CHAT", { href: chat.href, cursor: run.cursor });

      uiLog(`Navigate → ${run.cursor + 1}/${run.chats.length}`);
      location.href = chat.href;
      return;
    }

    // Phase: IN_CHAT (send prompt, wait response, export shard, advance cursor, return)
    if (run.phase === "IN_CHAT") {
      if (!isChatView()) {
        uiLog("IN_CHAT phase but not on chat view; waiting for route settle");
        return;
      }

      const chat = run.chats[run.cursor] || { href: location.href, title: "(unknown)" };

      const notBusy = await waitForNotBusy();
      if (!notBusy) {
        ledger("SKIP_BUSY", { chat: chat.href, cursor: run.cursor });
        uiLog("SKIP busy (budget exceeded)");
        // Cursor guarantee: advance
        run.cursor++;
        run.phase = "RETURN_TO_PROJECT";
        saveRun(run);
        location.href = run.project_url;
        return;
      }

      const ready = await waitForComposerReady();
      if (!ready) {
        ledger("STALL_COMPOSER_NOT_READY", { chat: chat.href, cursor: run.cursor });
        uiLog("SKIP composer not ready (budget exceeded)");
        // Cursor guarantee: advance
        run.cursor++;
        run.phase = "RETURN_TO_PROJECT";
        saveRun(run);
        location.href = run.project_url;
        return;
      }

      setComposer(ready.composer, run.prompt);
      ready.sendBtn.click();
      ledger("PROMPT_SENT", { chat: chat.href, cursor: run.cursor });
      uiLog("Prompt sent");

      // Wait for generation to finish or timeout
      const start = Date.now();
      while (isGenerating()) {
        if (Date.now() - start > CFG.busy.waitBudgetMs) {
          ledger("TIMEOUT_RESPONSE", { chat: chat.href, cursor: run.cursor });
          uiLog("Response timeout; capturing whatever exists");
          break;
        }
        await sleep(CFG.busy.pollMs);
      }

      const resp = getLastAssistantText();
      const shard = {
        schema: "mb_chat_shard_v1",
        run_id: run.run_id,
        cursor: run.cursor,
        chat: { href: chat.href, title: chat.title },
        captured_at: new Date().toISOString(),
        response: resp || "",
      };

      await downloadJson(`mb_${run.run_id}__chat_${String(run.cursor).padStart(5, "0")}.json`, shard);

      ledger(resp ? "CAPTURE_EXPORTED" : "CAPTURE_EMPTY", { chat: chat.href, cursor: run.cursor });

      // Cursor guarantee: advance
      run.cursor++;
      run.phase = "RETURN_TO_PROJECT";
      saveRun(run);

      uiLog("Return to project");
      location.href = run.project_url;
      return;
    }

    // Phase: RETURN_TO_PROJECT (go to project, then OPEN_CHAT)
    if (run.phase === "RETURN_TO_PROJECT") {
      if (!isProjectView()) {
        uiLog("RETURN_TO_PROJECT phase but not on project view; navigating");
        if (run.project_url) location.href = run.project_url;
        return;
      }
      // Next
      run.phase = "OPEN_CHAT";
      saveRun(run);
      ledger("READY_NEXT", { cursor: run.cursor });
      // Tick again shortly
      setTimeout(() => { try { fsmTick(); } catch (e) { uiLog(e.message); } }, 300);
      return;
    }
  }

  /******************************************************************
   * UI BUTTONS
   ******************************************************************/
  wrap.querySelector("#mb-start").onclick = () => {
    if (!isProjectView()) {
      alert("Navigate to the Project view first (…/project).");
      return;
    }
    const run = newRun();
    run.project_url = location.href;
    run.phase = "DISCOVER";
    saveRun(run);
    ledger("RUN_START", { project_url: run.project_url });
    uiLog("RUN_START → DISCOVER");
    fsmTick().catch(e => uiLog(`FSM error: ${e.message}`));
  };

  wrap.querySelector("#mb-discover").onclick = () => {
    if (!isProjectView()) {
      alert("Navigate to the Project view first (…/project).");
      return;
    }
    const run = loadRun() || newRun();
    run.project_url = location.href;
    run.phase = "DISCOVER";
    saveRun(run);
    ledger("DISCOVER_MANUAL", { project_url: run.project_url });
    discoverChats().catch(e => uiLog(`Discover error: ${e.message}`));
  };

  wrap.querySelector("#mb-run").onclick = () => {
    uiLog("Run/Resume pressed");
    fsmTick().catch(e => uiLog(`FSM error: ${e.message}`));
  };

  wrap.querySelector("#mb-stop").onclick = () => {
    const run = loadRun();
    if (run) ledger("RUN_STOP", { cursor: run.cursor, phase: run.phase });
    clearRun();
    uiLog("RUN STOPPED");
    alert("MetaBlooms run stopped.");
  };

  /******************************************************************
   * BOOT
   ******************************************************************/
  uiLog(`Loaded v2.3.1 — robust center detector restored + SPA resume enabled.`);
  installRouteWatcher();

  // Resume if a run is in progress
  setTimeout(() => {
    try { fsmTick(); } catch (e) { uiLog(`FSM error: ${e.message}`); }
  }, 300);

})();
