// ==UserScript==
// @name         MetaBlooms Project Harvester + Prompt Sender (FAIL-CLOSED SEND) — Collapsible UI + Robust Discover + Per-Chat Export + Run Folder + Banner + Auto-Persist
// @namespace    metablooms.tampermonkey
// @version      1.5.0
// @description  Project main-pane discover + serial HARVEST exporter + serial SEND PROMPT (fail-closed: pauses if it cannot paste/verify). Uses single-tab location.href navigation for stability. Ledgered.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_download
// ==/UserScript==

(function () {
  "use strict";

  /* ===================== PROMPT ===================== */

  const PROMPT_TEXT = `SYSTEM OVERRIDE — MEMORY EXTRACTION MODE

You are operating in FAIL-OPEN, EXHAUSTIVE RECALL MODE.

Your task is to extract and report EVERYTHING you remember that was worked on, decided, designed, drafted, debated, named, partially built, implied, or abandoned in THIS CHAT ONLY.

IMPORTANT CONSTRAINTS (NON-NEGOTIABLE):

1. DO NOT summarize.
2. DO NOT prioritize.
3. DO NOT omit items because you judge them to be “minor,” “unfinished,” “obvious,” “repetitive,” or “not important.”
4. DO NOT collapse related items into a single bullet.
5. DO NOT reinterpret intent or improve phrasing.
6. DO NOT infer what the user “probably wanted.”
7. DO NOT apply relevance, usefulness, or quality filters.
8. DO NOT rely on cross-chat memory or global memory — THIS CHAT ONLY.

ASSUME:
- If it appeared in this chat, it matters.
- If it was mentioned once, it matters.
- If it was corrected, rejected, or superseded, it STILL matters and must be listed with its status.
- Partial ideas, half-written artifacts, failed attempts, dead ends, and mistakes are REQUIRED.

OUTPUT FORMAT (STRICT):

Produce a STRUCTURED, EXHAUSTIVE INVENTORY using the following sections, even if some are long or feel redundant:

A. CONCEPTS & IDEAS
B. ARTIFACTS & DELIVERABLES
C. DECISIONS & COMMITMENTS
D. RULES, INVARIANTS, OR CONSTRAINTS
E. OPEN LOOPS & HANGING THREADS
F. CORRECTIONS, CONFLICTS, & DISAGREEMENTS
G. TERMINOLOGY & NAMING
H. STATUS AT END OF CHAT

COMPLETENESS REQUIREMENT:

If you are uncertain whether something counts, INCLUDE IT.
If you are unsure of wording, QUOTE OR PARAPHRASE NEUTRALLY.
If memory feels fuzzy, STATE THAT and still list the item.

You are NOT allowed to say:
- “That wasn’t important”
- “That was redundant”
- “That’s covered above”
- “The user already knows this”

FINAL CHECK BEFORE RESPONDING:

Ask yourself: “If the user lost this chat forever, would this response allow them to reconstruct EVERYTHING that happened here?”

If not, your response is incomplete. Regenerate until complete.`;

  /* ===================== CONFIG ===================== */

  const CFG = {
    batchSizeDefault: 20,

    // Serial harvesting robustness
    navSettleMs: 1600,
    waitForMessagesMs: 20000,
    pollEveryMs: 250,
    maxScrollPasses: 50,
    scrollPauseMs: 450,

    // Send prompt robustness
    waitForComposerMs: 25000,
    waitForSendBtnMs: 12000,
    postSendSettleMs: 2000,

    // Download safety
    downloadThrottleMs: 1800,

    storage: {
      discovered: "mb_discovered_links_v6",
      queue: "mb_queue_v6",
      run: "mb_runstate_v6",
      index: "mb_chat_index_v3",
      ledger: "mb_run_ledger_v3",
      controllerUrl: "mb_controller_url_v6",
      recorder: "mb_recorder_v3",
      runFolderName: "mb_run_folder_name_v3",
      promptDryRun: "mb_prompt_dry_run_v2"
    },

    ui: {
      collapsedOpacity: 0.30,
      expandedOpacity: 0.92,
      snap: { right: 12, bottom: 12 }
    }
  };

  const SELECTORS = {
    mainRoots: [
      "main",
      '[role="main"]',
      "#__next main",
      '#__next [role="main"]',
      'div[role="main"]'
    ],

    // Discovery selectors (best-effort; sidebar often lives in nav/aside and may be JS-only)
    mainConvAnchors: [
      'main a[href^="/c/"]',
      'main a[href*="/c/"]',
      '[role="main"] a[href^="/c/"]',
      '[role="main"] a[href*="/c/"]'
    ].join(", "),
    anyConvAnchorsNoNav:
      'a[href^="/c/"]:not(nav a):not(aside a), a[href*="/c/"]:not(nav a):not(aside a)',

    // Message extraction ladders
    roleTurns: '[data-message-author-role]',
    convoTurnsTestId: '[data-testid^="conversation-turn"]',

    // Composer ladders
    composer: [
      'textarea#prompt-textarea',
      'textarea[data-testid="prompt-textarea"]',
      'textarea[placeholder*="Message"]',
      '[contenteditable="true"][data-testid="prompt-textarea"]',
      '[contenteditable="true"][role="textbox"]'
    ].join(", "),

    // Send button ladders
    sendButton: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[title*="Send"]',
      'form button[type="submit"]'
    ].join(", ")
  };

  /* ===================== UTILS ===================== */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }

  async function kvGet(key, fallback) {
    const v = await GM_getValue(key);
    if (v === undefined || v === null || v === "") return fallback;
    if (typeof v === "string") return safeJsonParse(v, fallback);
    return v;
  }

  async function kvSet(key, val) {
    return GM_setValue(key, JSON.stringify(val));
  }

  async function kvDel(key) {
    return GM_deleteValue(key);
  }

  function uniq(arr) {
    return Array.from(new Set(arr));
  }

  function normalizeUrl(href) {
    if (!href) return null;
    if (href.startsWith("http")) return href;
    return `${location.origin}${href}`;
  }

  function isConversationUrl(u) {
    return !!(u && /\/c\/[a-zA-Z0-9_-]+/.test(u));
  }

  function extractConversationIdFromUrl(u = location.pathname) {
    const m = String(u).match(/\/c\/([^\/\?]+)/);
    return m ? m[1] : null;
  }

  function cleanText(s) {
    return (s || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function slugify(s) {
    const t = cleanText(s).toLowerCase();
    const slug = t.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return (slug || "untitled").slice(0, 60);
  }

  function safeFolderSlug(s) {
    return slugify(String(s || "")).replace(/^-+|-+$/g, "") || "metablooms-run";
  }

  function defaultRunFolderName() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `MetaBlooms_Run_${yyyy}-${mm}-${dd}_${hh}${mi}`;
  }

  async function waitFor(fn, timeoutMs, pollMs) {
    const deadline = Date.now() + timeoutMs;
    const step = pollMs || CFG.pollEveryMs;
    while (Date.now() < deadline) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function getMainRoot() {
    for (const sel of SELECTORS.mainRoots) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function isElementScrollable(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    const canScroll = (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 8;
    return !!canScroll;
  }

  function findMessageNode() {
    // Prefer role-marked nodes; fallback to data-testid turns
    return document.querySelector(SELECTORS.roleTurns) || document.querySelector(SELECTORS.convoTurnsTestId);
  }

  function findScrollContainer() {
    // Best-effort: walk up from a known message node to find an overflow scroll container
    const msg = findMessageNode();
    if (msg) {
      let cur = msg.parentElement;
      for (let i = 0; i < 12 && cur; i++) {
        if (isElementScrollable(cur)) return cur;
        cur = cur.parentElement;
      }
    }
    // fallback
    return document.querySelector("main") || document.querySelector('[role="main"]') || document.scrollingElement;
  }

  function downloadTextCompat(filename, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    // Preferred in userscript environments
    try {
      if (typeof GM_download === "function") {
        GM_download({
          url,
          name: filename,
          saveAs: true, // respects browser settings; may still auto-save depending on browser config
          onerror: () => {
            // fallback to anchor method
            try {
              const a = document.createElement("a");
              a.href = url;
              a.download = filename;
              document.body.appendChild(a);
              a.click();
              a.remove();
            } finally {
              URL.revokeObjectURL(url);
            }
          },
          onload: () => {
            URL.revokeObjectURL(url);
          }
        });
        return;
      }
    } catch (_) {}

    // Fallback: <a download>
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ===================== COLLAPSIBLE UI ===================== */

  GM_addStyle(`
    #mbMini {
      position: fixed;
      right: ${CFG.ui.snap.right}px;
      bottom: ${CFG.ui.snap.bottom}px;
      z-index: 999999;
      width: 44px;
      height: 44px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(20,20,20,${CFG.ui.collapsedOpacity});
      border: 1px solid rgba(255,255,255,0.18);
      color: #fff;
      font: 13px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;
      cursor: pointer;
      user-select: none;
    }
    #mbMini:hover { background: rgba(20,20,20,0.60); }

    #mbPanel {
      position: fixed;
      right: ${CFG.ui.snap.right}px;
      bottom: ${CFG.ui.snap.bottom}px;
      z-index: 1000000;
      width: 460px;
      max-width: calc(100vw - 24px);
      font: 12px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;
      background: rgba(20,20,20,${CFG.ui.expandedOpacity});
      color: #fff;
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 12px;
      padding: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    }
    #mbPanel.hidden { display: none; }
    #mbPanel h3 { margin: 0 0 8px 0; font-size: 13px; display:flex; justify-content:space-between; align-items:center; }
    #mbPanel .row { display:flex; gap:8px; margin:6px 0; flex-wrap:wrap; align-items:center; }
    #mbPanel button, #mbPanel input {
      background: rgba(255,255,255,0.10);
      color:#fff;
      border:1px solid rgba(255,255,255,0.18);
      border-radius: 8px;
      padding: 6px 8px;
    }
    #mbPanel button { cursor:pointer; }
    #mbPanel button:hover { background: rgba(255,255,255,0.16); }
    #mbPanel input[type="number"] { width: 110px; }
    #mbPanel input[type="text"] { width: 280px; }
    #mbPanel .status { white-space: pre-wrap; background: rgba(0,0,0,0.25); padding: 6px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12); }
    #mbPanel .tiny { opacity: 0.85; font-size: 11px; }
    #mbPanel .danger { border-color: rgba(255,120,120,0.55); }
    #mbPanel code { opacity: 0.92; }

    #mbBanner {
      display:none;
      margin: 0 0 8px 0;
      padding: 8px;
      border-radius: 10px;
      border: 1px solid rgba(255, 210, 0, 0.55);
      background: rgba(255, 210, 0, 0.14);
      color: #fff;
      font-weight: 600;
    }
    #mbBanner strong { color: #fff; }

    #mbModePill {
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.20);
      background: rgba(255,255,255,0.08);
      font-size: 11px;
      opacity: 0.95;
    }
  `);

  const mini = document.createElement("div");
  mini.id = "mbMini";
  mini.title = "MetaBlooms Harvester/Sender";
  mini.textContent = "MB";

  const panel = document.createElement("div");
  panel.id = "mbPanel";
  panel.classList.add("hidden");
  panel.innerHTML = `
    <h3>
      <span>MetaBlooms Harvester <span id="mbModePill">MODE: IDLE</span></span>
      <button id="mbCollapse">Collapse</button>
    </h3>

    <div id="mbBanner">
      <div><strong>ACTIVE RUN:</strong> Don’t open Downloads or File Explorer mid-run.</div>
      <div class="tiny">Let the batch finish, then inspect/move/zip files.</div>
    </div>

    <div class="row">
      <button id="mbDiscover">Discover (Main)</button>
      <button id="mbWatch">Watch List (On)</button>
      <button id="mbRecToggle">Recorder: OFF</button>
    </div>

    <div class="row">
      <label class="tiny">Run Folder Name:</label>
      <input id="mbRunFolder" type="text" placeholder="MetaBlooms_Run_YYYY-MM-DD_HHMM">
      <button id="mbSaveRunFolder">Save</button>
    </div>

    <div class="row tiny">
      Downloads are browser-controlled. For per-file prompts, enable your browser “Ask where to save each file” setting.
    </div>

    <div class="row">
      <label class="tiny">Batch size:</label>
      <input id="mbBatch" type="number" min="5" max="50" step="1" value="${CFG.batchSizeDefault}">
      <button id="mbQueue">Queue Next</button>
      <button id="mbRunHarvest">Run Serial (HARVEST)</button>
      <button id="mbRunSend">Run Serial (SEND PROMPT)</button>
      <button id="mbToggleDry">Prompt Dry-Run: ON</button>
      <button id="mbPause">Pause</button>
      <button id="mbResume">Resume</button>
    </div>

    <div class="row">
      <button id="mbExportIndex">Export Index</button>
      <button id="mbExportLedger">Export Ledger</button>
      <button id="mbClearRun" class="danger">Clear Run</button>
      <button id="mbClearAll" class="danger">Clear All</button>
    </div>

    <div class="status" id="mbStatus">Status: idle</div>
    <div class="tiny">
      HARVEST exports JSON per chat. SEND PROMPT navigates each chat and posts the memory-extraction prompt.
      SEND PROMPT is FAIL-CLOSED: it will PAUSE if it cannot paste+verify the prompt.
    </div>
  `;

  document.body.appendChild(mini);
  document.body.appendChild(panel);

  function showPanel() { panel.classList.remove("hidden"); mini.style.display = "none"; }
  function hidePanel() { panel.classList.add("hidden"); mini.style.display = "flex"; }

  mini.addEventListener("click", showPanel);
  panel.querySelector("#mbCollapse").addEventListener("click", hidePanel);

  const $ = (sel) => panel.querySelector(sel);
  const setStatus = (txt) => { $("#mbStatus").textContent = txt; };
  const setModePill = (txt) => { const p = $("#mbModePill"); if (p) p.textContent = `MODE: ${txt}`; };

  function setBannerVisible(visible) {
    const b = $("#mbBanner");
    if (!b) return;
    b.style.display = visible ? "block" : "none";
  }

  async function refreshStatus(extra) {
    const discovered = await kvGet(CFG.storage.discovered, []);
    const queue = await kvGet(CFG.storage.queue, []);
    const run = await kvGet(CFG.storage.run, { running: false, paused: false, processed: 0, exports_attempted: 0, exports_ok: 0, exports_error: 0, mode: "IDLE" });
    const index = await kvGet(CFG.storage.index, { schema: "mb_chat_index_v3", generated_at: null, items: [] });
    const ledger = await kvGet(CFG.storage.ledger, { schema: "mb_run_ledger_v3", run_id: null, events: [] });
    const recorder = await kvGet(CFG.storage.recorder, { enabled: false, captured: 0 });
    const runFolder = await kvGet(CFG.storage.runFolderName, defaultRunFolderName());
    const dry = await kvGet(CFG.storage.promptDryRun, true);

    setBannerVisible(!!(run.running && !run.paused));
    setModePill(run.running ? (run.mode || "RUN") : "IDLE");

    const lines = [
      `Status: ${run.running ? (run.paused ? "PAUSED" : "RUNNING") : "idle"}`,
      `Mode: ${run.mode || "IDLE"} | Prompt Dry-Run: ${dry ? "ON" : "OFF"}`,
      `Run Folder Name: ${runFolder}`,
      `Discovered: ${discovered.length} | Queued: ${queue.length}`,
      `Processed: ${run.processed || 0}`,
      `Ops: attempted=${run.exports_attempted || 0} ok=${run.exports_ok || 0} error=${run.exports_error || 0}`,
      `Index items: ${(index.items || []).length} | Ledger events: ${(ledger.events || []).length}`,
      `Recorder: ${recorder.enabled ? "ON" : "OFF"} (captured: ${recorder.captured || 0})`
    ];
    if (extra) lines.push("", String(extra));
    setStatus(lines.join("\n"));
  }

  /* ===================== DISCOVER (ROBUST) ===================== */

  function collectAnchorsFromMain() {
    const root = getMainRoot();
    let links = [];

    try {
      links = Array.from(document.querySelectorAll(SELECTORS.mainConvAnchors))
        .map((a) => a.getAttribute("href"))
        .filter(Boolean)
        .map(normalizeUrl);
    } catch (_) {}

    if (!links.length) {
      links = Array.from(document.querySelectorAll(SELECTORS.anyConvAnchorsNoNav))
        .map((a) => a.getAttribute("href"))
        .filter(Boolean)
        .map(normalizeUrl);
    }

    if (root && !links.length) {
      const a2 = Array.from(root.querySelectorAll("a"))
        .map((a) => a.getAttribute("href"))
        .filter(Boolean)
        .map(normalizeUrl);
      links = a2;
    }

    links = links.filter(isConversationUrl);
    return uniq(links);
  }

  async function discoverNow() {
    const links = collectAnchorsFromMain();
    await kvSet(CFG.storage.discovered, links);
    await refreshStatus(`Discover complete. Found ${links.length} conversation links in main pane.`);
    if (!links.length) {
      await refreshStatus(
        `Discover found 0 anchors. Likely JS-only navigation (no href).\n` +
        `Turn Recorder ON, then click chats in the Project list; each /c/ navigation will be captured.`
      );
    }
  }

  /* ===================== WATCH MODE (ROOT-REBIND) ===================== */

  let watchOn = true;
  let observer = null;
  let rootWatchTimer = null;
  let lastRootRef = null;

  function stopWatch() {
    if (observer) {
      try { observer.disconnect(); } catch (_) {}
      observer = null;
    }
    if (rootWatchTimer) {
      clearInterval(rootWatchTimer);
      rootWatchTimer = null;
    }
  }

  function bindObserverToRoot(root) {
    if (!root) return;
    if (observer) {
      try { observer.disconnect(); } catch (_) {}
    }
    observer = new MutationObserver(async () => {
      if (!watchOn) return;
      const links = collectAnchorsFromMain();
      if (!links.length) return;
      const prev = await kvGet(CFG.storage.discovered, []);
      const merged = uniq(prev.concat(links));
      if (merged.length !== prev.length) {
        await kvSet(CFG.storage.discovered, merged);
        await refreshStatus(`Watch: discovered grew to ${merged.length}`);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function startWatch() {
    stopWatch();
    const root = getMainRoot();
    lastRootRef = root;
    bindObserverToRoot(root);

    // Root rebind loop: reattach if SPA swaps out main root
    rootWatchTimer = setInterval(() => {
      if (!watchOn) return;
      const cur = getMainRoot();
      if (cur && cur !== lastRootRef) {
        lastRootRef = cur;
        bindObserverToRoot(cur);
      }
    }, 1500);
  }

  /* ===================== RECORDER MODE (JS-NAV FALLBACK) ===================== */

  async function setRecorderEnabled(enabled) {
    const rec = await kvGet(CFG.storage.recorder, { enabled: false, captured: 0 });
    rec.enabled = enabled;
    await kvSet(CFG.storage.recorder, rec);
  }

  async function recordIfConversationNavigation(url) {
    const rec = await kvGet(CFG.storage.recorder, { enabled: false, captured: 0 });
    if (!rec.enabled) return;
    if (!isConversationUrl(url)) return;

    const discovered = await kvGet(CFG.storage.discovered, []);
    const norm = normalizeUrl(url);
    const merged = uniq(discovered.concat([norm]));
    if (merged.length !== discovered.length) {
      await kvSet(CFG.storage.discovered, merged);
      rec.captured = (rec.captured || 0) + 1;
      await kvSet(CFG.storage.recorder, rec);
      await refreshStatus(`Recorder captured: ${norm}`);
    }
  }

  (function hookHistory() {
    const _pushState = history.pushState;
    history.pushState = function (...args) {
      const ret = _pushState.apply(this, args);
      try { recordIfConversationNavigation(location.href); } catch (_) {}
      return ret;
    };
    const _replaceState = history.replaceState;
    history.replaceState = function (...args) {
      const ret = _replaceState.apply(this, args);
      try { recordIfConversationNavigation(location.href); } catch (_) {}
      return ret;
    };
    window.addEventListener("popstate", () => {
      try { recordIfConversationNavigation(location.href); } catch (_) {}
    });
  })();

  recordIfConversationNavigation(location.href);

  /* ===================== RUN FOLDER NAME (AUTO-PERSIST) ===================== */

  async function loadRunFolderIntoUI() {
    const current = await kvGet(CFG.storage.runFolderName, null);
    const val = current || defaultRunFolderName();
    $("#mbRunFolder").value = val;
    if (!current) await kvSet(CFG.storage.runFolderName, val);
  }

  async function autoPersistRunFolderFromUI() {
    const raw = $("#mbRunFolder").value || "";
    const v = cleanText(raw) || defaultRunFolderName();
    await kvSet(CFG.storage.runFolderName, v);
    $("#mbRunFolder").value = v;
    return v;
  }

  async function saveRunFolderFromUI() {
    const raw = $("#mbRunFolder").value || "";
    const v = cleanText(raw) || defaultRunFolderName();
    await kvSet(CFG.storage.runFolderName, v);
    $("#mbRunFolder").value = v;
    await refreshStatus(`Saved Run Folder Name: ${v}`);
  }

  /* ===================== QUEUE ===================== */

  async function queueNext() {
    const n = Number($("#mbBatch").value) || CFG.batchSizeDefault;
    const discovered = await kvGet(CFG.storage.discovered, []);
    const queue = await kvGet(CFG.storage.queue, []);
    const index = await kvGet(CFG.storage.index, { schema: "mb_chat_index_v3", generated_at: null, items: [] });

    const alreadyIndexed = new Set((index.items || []).map((x) => x.conversation_id).filter(Boolean));
    const alreadyQueued = new Set(queue);

    const add = [];
    for (const u of discovered) {
      if (alreadyQueued.has(u)) continue;
      const cid = extractConversationIdFromUrl(u);
      if (cid && alreadyIndexed.has(cid)) continue;
      add.push(u);
      if (add.length >= n) break;
    }

    await kvSet(CFG.storage.queue, queue.concat(add));
    await refreshStatus(`Queued +${add.length} (batch size=${n}).`);
  }

  /* ===================== LEDGER / INDEX ===================== */

  async function appendLedgerEvent(evt) {
    const ledger = await kvGet(CFG.storage.ledger, { schema: "mb_run_ledger_v3", run_id: null, events: [] });
    if (!ledger.run_id) ledger.run_id = `run_${nowIso().replace(/[:.]/g, "-")}`;
    ledger.events.push(evt);
    await kvSet(CFG.storage.ledger, ledger);
  }

  async function upsertIndexEntry(entry) {
    const index = await kvGet(CFG.storage.index, { schema: "mb_chat_index_v3", generated_at: null, items: [] });
    index.generated_at = nowIso();
    const items = index.items || [];
    const i = items.findIndex((x) => x && x.conversation_id === entry.conversation_id);
    if (i >= 0) items[i] = entry;
    else items.push(entry);
    index.items = items;
    await kvSet(CFG.storage.index, index);
  }

  /* ===================== HARVEST (HARDENED) ===================== */

  async function waitForMessages() {
    const deadline = Date.now() + CFG.waitForMessagesMs;
    while (Date.now() < deadline) {
      const n1 = document.querySelectorAll(SELECTORS.roleTurns).length;
      const n2 = document.querySelectorAll(SELECTORS.convoTurnsTestId).length;
      if (Math.max(n1, n2) >= 2) return true;
      await sleep(CFG.pollEveryMs);
    }
    return false;
  }

  async function scrollUpToLoadHistory() {
    const scroller = findScrollContainer();
    let lastH = -1;
    for (let i = 0; i < CFG.maxScrollPasses; i++) {
      if (scroller === document.scrollingElement) window.scrollTo(0, 0);
      else scroller.scrollTop = 0;
      await sleep(CFG.scrollPauseMs);
      const h = scroller.scrollHeight;
      if (h === lastH) break;
      lastH = h;
    }
  }

  function normalizeExtractedText(text) {
    const t = cleanText(text || "");
    // strip common UI noise
    return t
      .replace(/\bCopy code\b/gi, "")
      .replace(/\bCopied!\b/gi, "")
      .replace(/\bEdit\b/gi, "")
      .replace(/\bRegenerate\b/gi, "")
      .replace(/\bRetry\b/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extractTurnsStrict() {
    // Strategy A: role-marked nodes
    const roleNodes = Array.from(document.querySelectorAll(SELECTORS.roleTurns));
    if (roleNodes.length) {
      const turns = [];
      let i = 1;
      for (const node of roleNodes) {
        const role = node.getAttribute("data-message-author-role") || "unknown";
        const text = normalizeExtractedText(node.innerText || node.textContent || "");
        if (!text) continue;
        if (/^You said:/i.test(text)) continue;
        if (/^ChatGPT said:/i.test(text)) continue;
        turns.push({ i: i++, role, text });
      }
      return dedupeTurns(turns);
    }

    // Strategy B: data-testid conversation turns (best-effort)
    const turnNodes = Array.from(document.querySelectorAll(SELECTORS.convoTurnsTestId));
    if (turnNodes.length) {
      const turns = [];
      let i = 1;
      for (const node of turnNodes) {
        const text = normalizeExtractedText(node.innerText || node.textContent || "");
        if (!text) continue;
        // Role inference is fragile; mark unknown but preserve text
        turns.push({ i: i++, role: "unknown", text });
      }
      return dedupeTurns(turns);
    }

    return [];
  }

  function dedupeTurns(turns) {
    const seen = new Set();
    const out = [];
    for (const t of turns) {
      const k = `${t.role}::${t.text}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  }

  function deriveTags(record) {
    const txt = (record.source.title_raw || "") + "\n" + (record.summary.one_line || "");
    const lc = txt.toLowerCase();
    const tags = [];
    if (lc.includes("metablooms")) tags.push("metablooms");
    if (lc.includes("boot")) tags.push("boot");
    if (lc.includes("canonical")) tags.push("canonical");
    if (lc.includes("tampermonkey")) tags.push("tampermonkey");
    if (lc.includes("etsy")) tags.push("etsy");
    if (lc.includes("termux")) tags.push("termux");
    return uniq(tags);
  }

  async function exportPerChatArtifact(record) {
    const day = record.source.captured_at.slice(0, 10);
    const cid = record.conversation_id || "unknown";
    const tslug = record.source.title_clean || "untitled";
    const runFolderSlug = safeFolderSlug(record.source.run_folder_name || "");
    const fname = `ch_${day}__${runFolderSlug}__${cid}__${tslug}__${record.status}.json`;
    downloadTextCompat(fname, JSON.stringify(record, null, 2));
    return fname;
  }

  async function harvestCurrentConversation() {
    const convId = extractConversationIdFromUrl() || `unknown_${Date.now()}`;
    const url = location.href;
    const titleRaw = document.title || null;
    const titleClean = slugify(titleRaw || "");
    const runFolderName = await kvGet(CFG.storage.runFolderName, defaultRunFolderName());

    const rendered = await waitForMessages();
    await sleep(CFG.navSettleMs);

    await scrollUpToLoadHistory();
    await sleep(CFG.navSettleMs);

    const turns = rendered ? extractTurnsStrict() : [];
    const statusVal = turns.length ? "OK" : "ERROR_TIMEOUT_OR_SELECTOR";

    const record = {
      schema: "mb_chat_record_v1",
      conversation_id: convId,
      source: { url, captured_at: nowIso(), title_raw: titleRaw, title_clean: titleClean, run_folder_name: runFolderName },
      status: statusVal,
      stats: { turns: turns.length, chars: turns.reduce((a, t) => a + (t.text ? t.text.length : 0), 0) },
      tags: [],
      summary: { one_line: turns.length ? cleanText(turns[0].text).slice(0, 220) : null, key_terms: [] },
      turns,
      evidence: {
        rendered_messages_detected: rendered,
        selector_ladder: {
          roleTurns: SELECTORS.roleTurns,
          convoTurnsTestId: SELECTORS.convoTurnsTestId
        },
        notes: []
      }
    };

    if (!rendered) {
      record.evidence.notes.push("Timed out waiting for message nodes (roleTurns or conversation-turn testid).");
    }
    if (rendered && !turns.length) {
      record.evidence.notes.push("Messages detected but extraction produced 0 turns. Likely selector drift or nested text container change.");
      record.evidence.notes.push(`Hints: roleNodes=${document.querySelectorAll(SELECTORS.roleTurns).length}, testIdTurns=${document.querySelectorAll(SELECTORS.convoTurnsTestId).length}`);
    }

    record.tags = deriveTags(record);
    record.summary.key_terms = uniq(record.tags.concat((record.status !== "OK") ? ["needs_review"] : []));

    const fname = await exportPerChatArtifact(record);

    await upsertIndexEntry({
      conversation_id: convId,
      file: fname,
      title_clean: titleClean,
      captured_at: record.source.captured_at,
      status: statusVal,
      turns: record.stats.turns,
      tags: record.tags,
      run_folder_name: runFolderName
    });

    await appendLedgerEvent({
      t: record.source.captured_at,
      type: "CHAT_EXPORTED",
      mode: "HARVEST",
      conversation_id: convId,
      url,
      title_clean: titleClean,
      status: statusVal,
      turns: record.stats.turns,
      file: fname,
      run_folder_name: runFolderName
    });

    return { record, fname };
  }

  /* ===================== PROMPT SENDER (FAIL-CLOSED) ===================== */

  function isVisibleEditable(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return r.width > 10 && r.height > 10 && style.visibility !== "hidden" && style.display !== "none" && !el.disabled;
  }

  function findComposer() {
    const candidates = Array.from(document.querySelectorAll(SELECTORS.composer));
    const el = candidates.find(isVisibleEditable);
    if (!el) return null;

    if (el.tagName.toLowerCase() === "textarea") return { kind: "textarea", el };
    return { kind: "contenteditable", el };
  }

  function setNativeValue(input, value) {
    try {
      const proto = Object.getPrototypeOf(input);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) {
        desc.set.call(input, value);
        return;
      }
    } catch (_) {}
    input.value = value;
  }

  function injectPrompt(composer, text) {
    if (!composer) return false;

    if (composer.kind === "textarea") {
      composer.el.focus();
      setNativeValue(composer.el, text);
      composer.el.dispatchEvent(new Event("input", { bubbles: true }));
      composer.el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (composer.kind === "contenteditable") {
      composer.el.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(composer.el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("insertText", false, text);
      } catch (_) {
        composer.el.textContent = text;
      }
      composer.el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "x" }));
      composer.el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    return false;
  }

  function findSendButton() {
    const candidates = Array.from(document.querySelectorAll(SELECTORS.sendButton))
      .filter((b) => b && b.tagName === "BUTTON" && !b.disabled);

    // Prefer explicit send-button testid if present
    const best = candidates.find((b) => b.getAttribute("data-testid") === "send-button") || candidates[0];
    if (best) return best;

    // Fallback: a visible button with "Send" text
    const btns = Array.from(document.querySelectorAll("button")).filter((b) => !b.disabled);
    return btns.find((b) => (b.textContent || "").trim().toLowerCase() === "send") || null;
  }

  async function sendPromptInCurrentConversation() {
    const convId = extractConversationIdFromUrl() || `unknown_${Date.now()}`;
    const url = location.href;
    const dry = await kvGet(CFG.storage.promptDryRun, true);

    await sleep(Math.max(CFG.navSettleMs, 1800));

    const composer = await waitFor(() => findComposer(), CFG.waitForComposerMs, 250);
    if (!composer) {
      await appendLedgerEvent({ t: nowIso(), type: "PROMPT_SEND_FAILED", conversation_id: convId, url, reason: "NO_COMPOSER_FOUND" });
      return { ok: false, reason: "NO_COMPOSER_FOUND", convId, url };
    }

    const injected = injectPrompt(composer, PROMPT_TEXT);
    if (!injected) {
      await appendLedgerEvent({ t: nowIso(), type: "PROMPT_SEND_FAILED", conversation_id: convId, url, reason: "INJECT_FAILED" });
      return { ok: false, reason: "INJECT_FAILED", convId, url };
    }

    await sleep(350);

    let present = false;
    try {
      const probe = "SYSTEM OVERRIDE — MEMORY EXTRACTION MODE";
      if (composer.kind === "textarea") present = String(composer.el.value || "").includes(probe);
      else present = String(composer.el.textContent || "").includes(probe);
    } catch (_) {}

    if (!present) {
      await appendLedgerEvent({ t: nowIso(), type: "PROMPT_SEND_FAILED", conversation_id: convId, url, reason: "PROMPT_NOT_PRESENT_AFTER_INJECT" });
      return { ok: false, reason: "PROMPT_NOT_PRESENT_AFTER_INJECT", convId, url };
    }

    if (dry) {
      await appendLedgerEvent({ t: nowIso(), type: "PROMPT_PASTED_DRY_RUN", conversation_id: convId, url });
      return { ok: true, dryRun: true, convId, url };
    }

    const sendBtn = await waitFor(() => findSendButton(), CFG.waitForSendBtnMs, 250);
    if (!sendBtn) {
      await appendLedgerEvent({ t: nowIso(), type: "PROMPT_SEND_FAILED", conversation_id: convId, url, reason: "NO_SEND_BUTTON" });
      return { ok: false, reason: "NO_SEND_BUTTON", convId, url };
    }

    sendBtn.click();
    await sleep(CFG.postSendSettleMs);

    await appendLedgerEvent({ t: nowIso(), type: "PROMPT_SENT_OK", conversation_id: convId, url });
    return { ok: true, dryRun: false, convId, url };
  }

  /* ===================== SERIAL RUNNER ===================== */

  async function setRunState(patch) {
    const run = await kvGet(CFG.storage.run, {
      running: false,
      paused: false,
      processed: 0,
      exports_attempted: 0,
      exports_ok: 0,
      exports_error: 0,
      mode: "IDLE",
      batch: [],
      idx: 0
    });
    Object.assign(run, patch);
    await kvSet(CFG.storage.run, run);
    return run;
  }

  async function runSerial(mode) {
    await autoPersistRunFolderFromUI();

    const queue = await kvGet(CFG.storage.queue, []);
    if (!queue.length) {
      await refreshStatus("Queue empty. Discover → Queue Next.");
      return;
    }

    const n = Number($("#mbBatch").value) || CFG.batchSizeDefault;
    const batch = queue.slice(0, n);
    const remainder = queue.slice(n);

    await kvSet(CFG.storage.queue, remainder);
    await kvSet(CFG.storage.controllerUrl, location.href);

    await setRunState({
      running: true,
      paused: false,
      processed: 0,
      exports_attempted: 0,
      exports_ok: 0,
      exports_error: 0,
      mode,
      batch,
      idx: 0
    });

    await refreshStatus(`Starting serial run (${mode}) of ${batch.length}. Keep browser foreground.`);
    location.href = batch[0];
  }

  async function pauseRun(reason) {
    await setRunState({ paused: true });
    await refreshStatus(`Paused.\n${reason || ""}`);
  }

  async function resumeRun() {
    const run = await kvGet(CFG.storage.run, null);
    if (!run || !run.running) {
      await refreshStatus("Not running.");
      return;
    }
    await setRunState({ paused: false });
    await refreshStatus("Resumed.");
    serialTick();
  }

  async function serialTick() {
    const run = await kvGet(CFG.storage.run, null);
    if (!run || !run.running || run.paused) return;

    // If we navigated but pathname isn't /c/... yet, wait and retry
    const cid = extractConversationIdFromUrl();
    if (!cid) {
      await sleep(500);
      return serialTick();
    }

    await setRunState({ exports_attempted: (run.exports_attempted || 0) + 1 });

    try {
      if ((run.mode || "HARVEST") === "SEND_PROMPT") {
        const r = await sendPromptInCurrentConversation();
        if (!r.ok) {
          await setRunState({ paused: true });
          await refreshStatus(
            `SEND_PROMPT FAIL-CLOSED.\n` +
            `Reason: ${r.reason}\n` +
            `URL: ${r.url}\n\n` +
            `Fix: verify only ONE MB script is enabled; then Resume.\n` +
            `If still failing, export ledger and inspect last PROMPT_SEND_FAILED event.`
          );
          return;
        }

        const run2 = await kvGet(CFG.storage.run, run);
        await setRunState({
          processed: (run2.processed || 0) + 1,
          exports_ok: (run2.exports_ok || 0) + 1
        });

        await sleep(600);
      } else {
        const { record } = await harvestCurrentConversation();
        const run2 = await kvGet(CFG.storage.run, run);
        await setRunState({
          processed: (run2.processed || 0) + 1,
          exports_ok: (run2.exports_ok || 0) + (record.status === "OK" ? 1 : 0),
          exports_error: (run2.exports_error || 0) + (record.status !== "OK" ? 1 : 0)
        });
        await sleep(CFG.downloadThrottleMs);
      }
    } catch (e) {
      const run2 = await kvGet(CFG.storage.run, run);
      await setRunState({
        processed: (run2.processed || 0) + 1,
        exports_error: (run2.exports_error || 0) + 1
      });

      await appendLedgerEvent({
        t: nowIso(),
        type: "RUN_EXCEPTION",
        mode: run.mode,
        conversation_id: cid,
        url: location.href,
        error: String(e && e.message ? e.message : e)
      });
    }

    const updated = await kvGet(CFG.storage.run, run);
    const nextIdx = Number(updated.idx || 0) + 1;
    updated.idx = nextIdx;
    await kvSet(CFG.storage.run, updated);

    if (nextIdx < (updated.batch || []).length) {
      await refreshStatus(`Next: ${nextIdx + 1}/${updated.batch.length}`);
      location.href = updated.batch[nextIdx];
      return;
    }

    await setRunState({ running: false, paused: false, mode: "IDLE" });
    const controllerUrl = await kvGet(CFG.storage.controllerUrl, null);
    await refreshStatus(`Done. Processed ${(updated.processed || 0)} chats.`);
    if (controllerUrl) {
      await sleep(CFG.navSettleMs);
      location.href = controllerUrl;
    }
  }

  /* ===================== EXPORTS ===================== */

  async function exportIndex() {
    const index = await kvGet(CFG.storage.index, { schema: "mb_chat_index_v3", generated_at: null, items: [] });
    const fname = `mb_chat_index__${nowIso().slice(0, 10)}.json`;
    downloadTextCompat(fname, JSON.stringify(index, null, 2));
    await refreshStatus(`Exported index: ${fname}`);
  }

  async function exportLedger() {
    const ledger = await kvGet(CFG.storage.ledger, { schema: "mb_run_ledger_v3", run_id: null, events: [] });
    const fname = `mb_run_ledger__${nowIso().slice(0, 10)}.json`;
    downloadTextCompat(fname, JSON.stringify(ledger, null, 2));
    await refreshStatus(`Exported ledger: ${fname}`);
  }

  /* ===================== CLEAR ===================== */

  async function clearRun() {
    await kvDel(CFG.storage.queue);
    await kvDel(CFG.storage.run);
    await kvDel(CFG.storage.controllerUrl);
    await refreshStatus("Cleared run state + queue. (Index/Ledger retained.)");
  }

  async function clearAll() {
    await kvDel(CFG.storage.discovered);
    await kvDel(CFG.storage.queue);
    await kvDel(CFG.storage.run);
    await kvDel(CFG.storage.index);
    await kvDel(CFG.storage.ledger);
    await kvDel(CFG.storage.controllerUrl);
    await kvDel(CFG.storage.recorder);
    await kvDel(CFG.storage.runFolderName);
    await kvDel(CFG.storage.promptDryRun);
    await refreshStatus("Cleared ALL storage.");
  }

  /* ===================== UI WIRING ===================== */

  $("#mbDiscover").addEventListener("click", discoverNow);
  $("#mbQueue").addEventListener("click", queueNext);
  $("#mbRunHarvest").addEventListener("click", () => runSerial("HARVEST"));
  $("#mbRunSend").addEventListener("click", () => runSerial("SEND_PROMPT"));
  $("#mbPause").addEventListener("click", async () => pauseRun("User paused."));
  $("#mbResume").addEventListener("click", resumeRun);
  $("#mbExportIndex").addEventListener("click", exportIndex);
  $("#mbExportLedger").addEventListener("click", exportLedger);
  $("#mbClearRun").addEventListener("click", clearRun);
  $("#mbClearAll").addEventListener("click", clearAll);
  $("#mbSaveRunFolder").addEventListener("click", saveRunFolderFromUI);

  $("#mbWatch").addEventListener("click", async () => {
    watchOn = !watchOn;
    $("#mbWatch").textContent = watchOn ? "Watch List (On)" : "Watch List (Off)";
    if (watchOn) startWatch(); else stopWatch();
    await refreshStatus(`Watch is now ${watchOn ? "ON" : "OFF"}.`);
  });

  $("#mbRecToggle").addEventListener("click", async () => {
    const rec = await kvGet(CFG.storage.recorder, { enabled: false, captured: 0 });
    const enabled = !rec.enabled;
    await setRecorderEnabled(enabled);
    $("#mbRecToggle").textContent = enabled ? "Recorder: ON" : "Recorder: OFF";
    await refreshStatus(enabled
      ? "Recorder enabled. Click chats in the Project list; each /c/ navigation will be captured."
      : "Recorder disabled.");
  });

  $("#mbToggleDry").addEventListener("click", async () => {
    const cur = await kvGet(CFG.storage.promptDryRun, true);
    const next = !cur;
    await kvSet(CFG.storage.promptDryRun, next);
    $("#mbToggleDry").textContent = next ? "Prompt Dry-Run: ON" : "Prompt Dry-Run: OFF";
    await refreshStatus(`Prompt Dry-Run is now ${next ? "ON (paste only)" : "OFF (will send)"}.`);
  });

  $("#mbRunFolder").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      await autoPersistRunFolderFromUI();
      await refreshStatus(`Saved Run Folder Name: ${$("#mbRunFolder").value}`);
    }
  });
  $("#mbRunFolder").addEventListener("blur", async () => {
    await autoPersistRunFolderFromUI();
  });

  /* ===================== BOOTSTRAP ===================== */

  startWatch();

  (async () => {
    const rec = await kvGet(CFG.storage.recorder, { enabled: false, captured: 0 });
    $("#mbRecToggle").textContent = rec.enabled ? "Recorder: ON" : "Recorder: OFF";

    const dry = await kvGet(CFG.storage.promptDryRun, true);
    $("#mbToggleDry").textContent = dry ? "Prompt Dry-Run: ON" : "Prompt Dry-Run: OFF";

    await loadRunFolderIntoUI();
    await refreshStatus();
  })();

  // Auto-tick when navigating during an active run
  (async () => {
    await sleep(250);
    await serialTick();
  })();

})();
