// ==UserScript==
// @name         MetaBlooms Project Harvester + Prompt Sender (CENTER-PANEL HARDENED) v1.6.0
// @namespace    metablooms.tampermonkey
// @version      1.6.0
// @description  Projects: discover chats from CENTER list (virtualized-safe), open each chat, send prompt, return to list. Draggable minimizable UI. Fail-closed with diag.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  /********************************************************************
   * CONFIG
   ********************************************************************/
  const CFG = {
    // UI
    ui: {
      bubbleLabel: "MB",
      zIndex: 999999,
      startRightPx: 14,
      startBottomPx: 14,
      panelW: 380,
      panelMaxH: 420,
      collapsedOpacity: 0.55,
      expandedOpacity: 0.95,
    },

    // Discovery
    discovery: {
      maxChats: 50000,
      scrollStepPx: 900,
      scrollPauseMs: 260,
      domQuietMs: 450,
      stableRoundsToStop: 12,     // consecutive rounds w/ no growth
      maxRounds: 1800,            // hard cap
      lowCountFailClosed: 8,      // suspiciously low = probably wrong selector
      titleMinLen: 2,
    },

    // Prompting
    prompt: {
      // You can edit this prompt template safely.
      // Use {{RUN_ID}} and {{CHAT_TITLE}} placeholders.
      template:
`BOOT, BTS, AUDIT PREVIOUS TURN (FAIL-CLOSED IF NO ARTIFACTS).
You are in a MetaBlooms extraction job.

TASK:
Return ONLY the following payload as JSON (no markdown), for THIS CHAT ONLY:
{
  "run_id": "{{RUN_ID}}",
  "chat_title": "{{CHAT_TITLE}}",
  "turn_index": [{"n":1,"role":"user|assistant","summary":"..."}],   // index only
  "component_inventory": [{"name":"...","quotes":["..."]}],
  "relationships": ["..."],
  "invariants": ["..."],
  "failure_modes": ["..."],
  "ambiguities": ["..."],
  "last_assistant_reply_full": "FULL TEXT OF LAST ASSISTANT REPLY ONLY"
}

CONSTRAINTS:
- Design-only extraction. No execution claims unless you emit receipts inline.
- No normalization. Preserve contradictions.
- If selectors/limits prevent compliance, FAIL CLOSED with reason.`,
      afterSendWaitMs: 1500,
    },

    // Navigation / detection
    detect: {
      // Project list URLs look like: /g/<gizmo_or_project_id>/project
      // Some variants keep /project in pathname.
      isProjectList: () => location.pathname.includes("/project"),
    },
  };

  /********************************************************************
   * UTIL
   ********************************************************************/
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  function txt(el) {
    return (el?.innerText || el?.textContent || "").trim();
  }

  function normSpace(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function safeJsonParse(s, fb = null) {
    try { return JSON.parse(s); } catch { return fb; }
  }

  function logLine(s) {
    UI.log.push(`[${new Date().toLocaleTimeString()}] ${s}`);
    if (UI.log.length > 400) UI.log.shift();
    renderUI();
  }

  function failClosed(reason, diag = {}) {
    UI.state.lastError = reason;
    UI.state.diag = diag;
    UI.state.running = false;
    renderUI();
    alert(`MetaBlooms FAIL-CLOSED:\n${reason}\n\n${JSON.stringify(diag, null, 2)}`);
    throw new Error(`FAIL_CLOSED: ${reason}`);
  }

  async function waitDomQuiet(msQuiet, timeoutMs = 12000) {
    let last = Date.now();
    const obs = new MutationObserver(() => { last = Date.now(); });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    const start = Date.now();
    while (true) {
      if (Date.now() - last >= msQuiet) break;
      if (Date.now() - start >= timeoutMs) break;
      await sleep(120);
    }
    obs.disconnect();
  }

  /********************************************************************
   * UI (min bubble + expandable draggable panel)
   ********************************************************************/
  const UI = {
    el: null,
    bubble: null,
    panel: null,
    log: [],
    state: {
      expanded: false,
      running: false,
      lastError: null,
      diag: {},
      runId: `mb_${nowIso().replace(/[:.]/g, "_")}`,
      discovered: [],       // { kind:'href', href, title } or { kind:'row', title, fingerprint }
      processed: 0,
    }
  };

  function ensureUI() {
    if (UI.el) return;

    const wrap = document.createElement("div");
    wrap.id = "mb-ui-wrap";
    wrap.style.position = "fixed";
    wrap.style.right = `${CFG.ui.startRightPx}px`;
    wrap.style.bottom = `${CFG.ui.startBottomPx}px`;
    wrap.style.zIndex = String(CFG.ui.zIndex);
    wrap.style.userSelect = "none";
    wrap.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

    // Bubble
    const bubble = document.createElement("div");
    bubble.id = "mb-ui-bubble";
    bubble.textContent = CFG.ui.bubbleLabel;
    bubble.style.width = "42px";
    bubble.style.height = "42px";
    bubble.style.borderRadius = "999px";
    bubble.style.display = "grid";
    bubble.style.placeItems = "center";
    bubble.style.cursor = "pointer";
    bubble.style.background = "rgba(20,20,24,0.92)";
    bubble.style.color = "white";
    bubble.style.border = "1px solid rgba(255,255,255,0.18)";
    bubble.style.boxShadow = "0 10px 30px rgba(0,0,0,0.45)";
    bubble.style.opacity = String(CFG.ui.collapsedOpacity);

    // Panel
    const panel = document.createElement("div");
    panel.id = "mb-ui-panel";
    panel.style.width = `${CFG.ui.panelW}px`;
    panel.style.maxHeight = `${CFG.ui.panelMaxH}px`;
    panel.style.marginTop = "10px";
    panel.style.padding = "10px";
    panel.style.borderRadius = "14px";
    panel.style.display = "none";
    panel.style.background = "rgba(15,15,18,0.96)";
    panel.style.color = "white";
    panel.style.border = "1px solid rgba(255,255,255,0.18)";
    panel.style.boxShadow = "0 16px 40px rgba(0,0,0,0.55)";
    panel.style.opacity = String(CFG.ui.expandedOpacity);

    panel.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
        <div style="font-weight:700;">MetaBlooms</div>
        <div style="display:flex; gap:6px;">
          <button id="mb-ui-min" style="cursor:pointer;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:white;padding:4px 10px;">Min</button>
        </div>
      </div>

      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        <button id="mb-discover" style="cursor:pointer;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.10);color:white;padding:8px 10px;flex:1;">Discover (CENTER PANEL)</button>
        <button id="mb-run" style="cursor:pointer;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:rgba(120,255,180,.10);color:white;padding:8px 10px;flex:1;">Run — Prompt All</button>
      </div>

      <div style="font-size:12px; opacity:.85; margin-bottom:6px;">
        <div><b>Run:</b> <span id="mb-runid"></span></div>
        <div><b>Discovered:</b> <span id="mb-disc"></span> | <b>Processed:</b> <span id="mb-proc"></span></div>
        <div><b>Last:</b> <span id="mb-last"></span></div>
      </div>

      <textarea id="mb-log" style="width:100%;height:190px;resize:vertical;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.25);color:white;padding:8px;box-sizing:border-box;font-size:12px;"></textarea>
    `;

    wrap.appendChild(bubble);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);

    UI.el = wrap;
    UI.bubble = bubble;
    UI.panel = panel;

    // Toggle expand
    bubble.addEventListener("click", () => {
      UI.state.expanded = !UI.state.expanded;
      renderUI();
    });

    panel.querySelector("#mb-ui-min").addEventListener("click", () => {
      UI.state.expanded = false;
      renderUI();
    });

    // Drag support (drag bubble OR panel header area)
    let dragging = false;
    let dragStart = null;

    function onDown(e) {
      dragging = true;
      dragStart = { x: e.clientX, y: e.clientY, right: parseInt(UI.el.style.right, 10), bottom: parseInt(UI.el.style.bottom, 10) };
      e.preventDefault();
    }
    function onMove(e) {
      if (!dragging || !dragStart) return;
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      UI.el.style.right = `${Math.max(0, dragStart.right - dx)}px`;
      UI.el.style.bottom = `${Math.max(0, dragStart.bottom - dy)}px`;
    }
    function onUp() { dragging = false; dragStart = null; }

    bubble.addEventListener("mousedown", onDown);
    panel.querySelector("div").addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    // Actions
    panel.querySelector("#mb-discover").addEventListener("click", async () => {
      try { await actionDiscover(); } catch (e) { console.error(e); }
    });
    panel.querySelector("#mb-run").addEventListener("click", async () => {
      try { await actionRunPromptAll(); } catch (e) { console.error(e); }
    });

    renderUI();
    logLine("UI ready.");
  }

  function renderUI() {
    if (!UI.el) return;

    UI.bubble.style.opacity = UI.state.expanded ? String(CFG.ui.expandedOpacity) : String(CFG.ui.collapsedOpacity);
    UI.panel.style.display = UI.state.expanded ? "block" : "none";

    const runIdEl = UI.panel.querySelector("#mb-runid");
    const discEl = UI.panel.querySelector("#mb-disc");
    const procEl = UI.panel.querySelector("#mb-proc");
    const lastEl = UI.panel.querySelector("#mb-last");
    const logEl = UI.panel.querySelector("#mb-log");

    if (runIdEl) runIdEl.textContent = UI.state.runId;
    if (discEl) discEl.textContent = String(UI.state.discovered.length);
    if (procEl) procEl.textContent = String(UI.state.processed);
    if (lastEl) lastEl.textContent = UI.state.lastError ? `FATAL ${UI.state.lastError}` : "OK";
    if (logEl) logEl.value = UI.log.join("\n");
  }

  /********************************************************************
   * CENTER PANEL DISCOVERY (Projects)
   ********************************************************************/
  function findCenterScroller() {
    // Heuristic: project list is usually inside main area, with overflow-y-auto and data-scroll-root=true.
    // We prefer elements that are NOT nav/aside descendants.
    const candidates = [...document.querySelectorAll('div[data-scroll-root="true"], main [class*="overflow-y-auto"], [role="main"] [class*="overflow-y-auto"]')]
      .filter(el => {
        if (!(el instanceof HTMLElement)) return false;
        const cs = getComputedStyle(el);
        const oy = cs.overflowY;
        if (!(oy === "auto" || oy === "scroll")) return false;
        // Avoid sidebars
        if (el.closest("nav, aside")) return false;
        // Must be sizable
        const r = el.getBoundingClientRect();
        return r.width > 320 && r.height > 300;
      });

    if (candidates.length === 0) return null;

    // Prefer the widest/tallest (center pane)
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });

    return candidates[0];
  }

  function extractProjectEntries(container) {
    // Attempt A: anchors to /c/
    const anchors = [...container.querySelectorAll('a[href*="/c/"]')]
      .map(a => ({ kind: "href", href: a.href, title: normSpace(txt(a)) }))
      .filter(x => x.title.length >= CFG.discovery.titleMinLen);

    // Attempt B: clickable rows (no href). Use role=link/button, or cursor pointer, or click handlers likely.
    // We store a fingerprint to re-find later.
    const clickables = [...container.querySelectorAll('[role="link"], [role="button"], button, div, li')]
      .filter(el => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.closest("nav, aside")) return false;
        // avoid container itself
        if (el === container) return false;

        const t = normSpace(txt(el));
        if (t.length < CFG.discovery.titleMinLen) return false;

        // must be reasonably “row-like” and clickable-ish
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 24 || r.height > 140) return false;

        const cs = getComputedStyle(el);
        const clickable = (el.getAttribute("role") === "link" || el.getAttribute("role") === "button" || el.tagName === "BUTTON" || cs.cursor === "pointer");
        if (!clickable) return false;

        // De-dupe obvious UI controls
        if (/new chat/i.test(t)) return false;
        if (/search chats/i.test(t)) return false;

        return true;
      })
      .map(el => {
        const title = bestRowTitle(el);
        if (!title) return null;
        return {
          kind: "row",
          title,
          fingerprint: fingerprintEl(el),
        };
      })
      .filter(Boolean);

    return { anchors, clickables };
  }

  function bestRowTitle(el) {
    // In project list rows, title often is a bold span then a snippet. Prefer first line.
    const t = normSpace(txt(el));
    if (!t) return "";
    // take first line-ish chunk
    const first = t.split("\n")[0].trim();
    // clamp length
    return first.length > 3 ? first : t.slice(0, 80);
  }

  function fingerprintEl(el) {
    // Build a lightweight fingerprint that survives minor DOM shifts:
    // tag + first 80 chars + bounding box approx
    const r = el.getBoundingClientRect();
    return [
      el.tagName.toLowerCase(),
      normSpace(txt(el)).slice(0, 80),
      Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height),
    ].join("|");
  }

  function tryFindRowByTitle(container, title) {
    const want = normSpace(title);
    // Search visible rows
    const nodes = [...container.querySelectorAll('[role="link"], [role="button"], button, div, li')]
      .filter(el => el instanceof HTMLElement && !el.closest("nav, aside"));
    for (const el of nodes) {
      const t = normSpace(txt(el));
      if (!t) continue;
      if (t.includes(want)) return el;
      // Some rows have exact title in a child
      const first = t.split("\n")[0].trim();
      if (first === want) return el;
    }
    return null;
  }

  /********************************************************************
   * ACTIONS
   ********************************************************************/
  async function actionDiscover() {
    ensureUI();

    if (!CFG.detect.isProjectList()) {
      failClosed("NOT_ON_PROJECT_LIST_URL", { path: location.pathname, hint: "Open the Project list view (/project) first." });
    }

    await waitDomQuiet(CFG.discovery.domQuietMs);

    const scroller = findCenterScroller();
    if (!scroller) {
      failClosed("CENTER_SCROLLER_NOT_FOUND", {
        hint: "Could not locate the center-pane overflow scroller. UI layout likely changed.",
        path: location.pathname,
      });
    }

    logLine("Center scroller found. Enumerating…");

    const seenKey = new Set(); // for dedupe
    const out = [];
    let stable = 0;
    let lastCount = 0;

    for (let round = 0; round < CFG.discovery.maxRounds; round++) {
      const { anchors, clickables } = extractProjectEntries(scroller);

      // Prefer anchors when present (stronger)
      for (const a of anchors) {
        const key = `href:${a.href}`;
        if (!seenKey.has(key)) {
          seenKey.add(key);
          out.push(a);
        }
      }

      // Also accept clickable rows (fallback)
      for (const c of clickables) {
        const key = `row:${c.title}`;
        if (!seenKey.has(key)) {
          seenKey.add(key);
          out.push(c);
        }
      }

      const count = out.length;
      if (count === lastCount) stable++;
      else stable = 0;
      lastCount = count;

      if (round % 10 === 0) {
        logLine(`Discover round ${round}: found=${count} stable=${stable}/${CFG.discovery.stableRoundsToStop}`);
        renderUI();
      }

      if (count >= CFG.discovery.maxChats) break;
      if (stable >= CFG.discovery.stableRoundsToStop) break;

      // Scroll down to load more
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + CFG.discovery.scrollStepPx);
      await sleep(CFG.discovery.scrollPauseMs);
      await waitDomQuiet(240);
    }

    if (out.length <= CFG.discovery.lowCountFailClosed) {
      failClosed("SUSPICIOUSLY_LOW_DISCOVERY_COUNT", {
        found: out.length,
        hint: "Likely bound to wrong container or list is not rendered yet. Try clicking into the project list and scrolling once manually, then retry.",
      });
    }

    UI.state.discovered = out;
    UI.state.processed = 0;
    UI.state.lastError = null;
    logLine(`Discovery complete. Total entries=${out.length}`);
    renderUI();
  }

  async function actionRunPromptAll() {
    ensureUI();

    if (!UI.state.discovered.length) {
      failClosed("NO_DISCOVERY_YET", { hint: "Run Discover first." });
    }
    if (!CFG.detect.isProjectList()) {
      failClosed("NOT_ON_PROJECT_LIST_URL", { path: location.pathname, hint: "Open the Project list view (/project) first." });
    }

    UI.state.running = true;
    UI.state.lastError = null;
    renderUI();

    const projectUrl = location.href;

    for (let i = UI.state.processed; i < UI.state.discovered.length; i++) {
      UI.state.processed = i;
      renderUI();

      const entry = UI.state.discovered[i];
      logLine(`Processing ${i + 1}/${UI.state.discovered.length}: ${entry.title || entry.href}`);

      // Ensure we're back on project list
      if (!CFG.detect.isProjectList()) {
        location.href = projectUrl;
        await waitDomQuiet(CFG.discovery.domQuietMs);
      }

      // Open chat
      await openEntry(projectUrl, entry);

      // Send prompt
      await sendPromptForEntry(entry);

      // Return to list (hard jump; more reliable than history with SPA)
      location.href = projectUrl;
      await waitDomQuiet(CFG.discovery.domQuietMs);
      await sleep(250);
    }

    UI.state.running = false;
    logLine("DONE: Prompted all discovered chats.");
    renderUI();
    alert("MetaBlooms: DONE — Prompted all discovered chats.");
  }

  async function openEntry(projectUrl, entry) {
    await waitDomQuiet(240);

    if (entry.kind === "href" && entry.href) {
      location.href = entry.href;
      await waitDomQuiet(CFG.discovery.domQuietMs);
      return;
    }

    // Row-click mode: re-find row by title, scrolling center container if needed
    const scroller = findCenterScroller();
    if (!scroller) {
      failClosed("CENTER_SCROLLER_NOT_FOUND_ON_OPEN", { hint: "UI changed; cannot locate scroller to open row." });
    }

    const targetTitle = entry.title;
    let found = null;

    for (let tries = 0; tries < 220; tries++) {
      found = tryFindRowByTitle(scroller, targetTitle);
      if (found) break;

      // Scroll a bit and let list re-render
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + CFG.discovery.scrollStepPx);
      await sleep(CFG.discovery.scrollPauseMs);
      await waitDomQuiet(180);
    }

    if (!found) {
      failClosed("ROW_NOT_FOUND_TO_OPEN", {
        title: targetTitle,
        hint: "Row could not be re-found in virtualized list. You may need anchor discovery mode or a refined row selector.",
      });
    }

    found.click();
    await waitDomQuiet(CFG.discovery.domQuietMs);
  }

  async function sendPromptForEntry(entry) {
    await waitDomQuiet(240);

    const composer = findComposer();
    if (!composer) {
      failClosed("COMPOSER_NOT_FOUND", {
        hint: "Chat did not open or composer selector changed. Try manually opening one chat, then rerun.",
        path: location.pathname,
      });
    }

    const runId = UI.state.runId;
    const chatTitle = entry.title || entry.href || "(unknown)";
    const prompt = CFG.prompt.template
      .replaceAll("{{RUN_ID}}", runId)
      .replaceAll("{{CHAT_TITLE}}", chatTitle);

    setComposerValue(composer, prompt);

    const sendBtn = findSendButton();
    if (!sendBtn) {
      failClosed("SEND_BUTTON_NOT_FOUND", { hint: "Send button selector changed or composer not active." });
    }

    sendBtn.click();
    await sleep(CFG.prompt.afterSendWaitMs);
    await waitDomQuiet(400);
    logLine("Prompt sent.");
  }

  function findComposer() {
    return document.querySelector('textarea#prompt-textarea')
      || document.querySelector('textarea[data-testid="prompt-textarea"]')
      || document.querySelector('textarea[placeholder*="Message"]')
      || document.querySelector('[contenteditable="true"][data-testid="prompt-textarea"]')
      || document.querySelector('[contenteditable="true"][role="textbox"]');
  }

  function setComposerValue(el, value) {
    // Works for textarea and contenteditable
    el.focus();
    if (el.tagName === "TEXTAREA") {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // contenteditable
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function findSendButton() {
    return document.querySelector('button[data-testid="send-button"]')
      || document.querySelector('button[aria-label*="Send"]')
      || document.querySelector('button[title*="Send"]')
      || document.querySelector('form button[type="submit"]');
  }

  /********************************************************************
   * INIT
   ********************************************************************/
  ensureUI();

})();
