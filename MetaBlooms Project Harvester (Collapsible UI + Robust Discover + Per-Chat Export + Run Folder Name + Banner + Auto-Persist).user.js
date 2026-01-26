// ==UserScript==
// @name         MetaBlooms Project Harvester (Collapsible UI + Robust Discover + Per-Chat Export + Run Folder Name + Banner + Auto-Persist)
// @namespace    metablooms.tampermonkey
// @version      1.3.0
// @description  Discover Project chats from main pane, serially harvest, export one JSON per chat immediately + index + ledger. Collapsible discreet UI with Run Folder Name + “Don’t open Downloads” banner. Auto-persists Run Folder Name (no Save footgun).
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  "use strict";

  /* ===================== CONFIG ===================== */

  const CFG = {
    batchSizeDefault: 20,

    // Serial harvesting robustness
    navSettleMs: 1400,
    waitForMessagesMs: 20000,
    pollEveryMs: 250,
    maxScrollPasses: 40,
    scrollPauseMs: 400,

    // Download safety
    downloadThrottleMs: 1800,

    storage: {
      discovered: "mb_discovered_links_v4",
      queue: "mb_queue_v4",
      run: "mb_runstate_v4",
      index: "mb_chat_index_v1",
      ledger: "mb_run_ledger_v1",
      controllerUrl: "mb_controller_url_v4",
      recorder: "mb_recorder_v1",
      runFolderName: "mb_run_folder_name_v1"
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
    mainConvAnchors: [
      'main a[href^="/c/"]',
      'main a[href*="/c/"]',
      '[role="main"] a[href^="/c/"]',
      '[role="main"] a[href*="/c/"]'
    ].join(", "),
    anyConvAnchorsNoNav:
      'a[href^="/c/"]:not(nav a):not(aside a), a[href*="/c/"]:not(nav a):not(aside a)',
    roleTurns: '[data-message-author-role]'
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

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function getMainRoot() {
    for (const sel of SELECTORS.mainRoots) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
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
      width: 440px;
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
  `);

  const mini = document.createElement("div");
  mini.id = "mbMini";
  mini.title = "MetaBlooms Harvester";
  mini.textContent = "MB";

  const panel = document.createElement("div");
  panel.id = "mbPanel";
  panel.classList.add("hidden");
  panel.innerHTML = `
    <h3>
      <span>MetaBlooms Harvester</span>
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
      <label class="tiny">Run Folder Name (Option A):</label>
      <input id="mbRunFolder" type="text" placeholder="MetaBlooms_Run_YYYY-MM-DD_HHMM">
      <button id="mbSaveRunFolder">Save</button>
    </div>

    <div class="row tiny">
      When the first download prompt appears, create/select:
      <code>Downloads\\${"<"}Run Folder Name${">"}\\</code>
      (browser setting: “Ask where to save each file”).
    </div>

    <div class="row">
      <label class="tiny">Batch size:</label>
      <input id="mbBatch" type="number" min="5" max="50" step="1" value="${CFG.batchSizeDefault}">
      <button id="mbQueue">Queue Next</button>
      <button id="mbRun">Run Serial</button>
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
      Discover collects <code>/c/</code> links visible in the main pane.
      If the Project list uses JS-only navigation (no href), turn <b>Recorder ON</b> and click through chats; each /c/ navigation will be captured deterministically.
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

  function setBannerVisible(visible) {
    const b = $("#mbBanner");
    if (!b) return;
    b.style.display = visible ? "block" : "none";
  }

  async function refreshStatus(extra) {
    const discovered = await kvGet(CFG.storage.discovered, []);
    const queue = await kvGet(CFG.storage.queue, []);
    const run = await kvGet(CFG.storage.run, { running: false, paused: false, processed: 0, exports_attempted: 0, exports_ok: 0, exports_error: 0 });
    const index = await kvGet(CFG.storage.index, { schema: "mb_chat_index_v1", generated_at: null, items: [] });
    const ledger = await kvGet(CFG.storage.ledger, { schema: "mb_harvest_run_ledger_v1", run_id: null, events: [] });
    const recorder = await kvGet(CFG.storage.recorder, { enabled: false, captured: 0 });
    const runFolder = await kvGet(CFG.storage.runFolderName, defaultRunFolderName());

    setBannerVisible(!!(run.running && !run.paused));

    const lines = [
      `Status: ${run.running ? (run.paused ? "PAUSED" : "RUNNING") : "idle"}`,
      `Run Folder Name: ${runFolder}`,
      `Discovered: ${discovered.length} | Queued: ${queue.length}`,
      `Processed: ${run.processed || 0}`,
      `Exports: attempted=${run.exports_attempted || 0} ok=${run.exports_ok || 0} error=${run.exports_error || 0}`,
      `Index items: ${(index.items || []).length} | Ledger events: ${(ledger.events || []).length}`,
      `Recorder: ${recorder.enabled ? "ON" : "OFF"} (captured navigations: ${recorder.captured || 0})`
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

  /* ===================== WATCH MODE ===================== */

  let watchOn = true;
  let observer = null;

  function startWatch() {
    stopWatch();
    const root = getMainRoot();
    if (!root) return;
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

  function stopWatch() {
    if (observer) {
      try { observer.disconnect(); } catch (_) {}
      observer = null;
    }
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
    const index = await kvGet(CFG.storage.index, { schema: "mb_chat_index_v1", generated_at: null, items: [] });

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

  /* ===================== HARVEST (FAIL-CLOSED) ===================== */

  async function waitForMessages() {
    const deadline = Date.now() + CFG.waitForMessagesMs;
    while (Date.now() < deadline) {
      if (document.querySelectorAll(SELECTORS.roleTurns).length >= 2) return true;
      await sleep(CFG.pollEveryMs);
    }
    return false;
  }

  async function scrollUpToLoadHistory() {
    const scroller = document.querySelector("main") || document.querySelector('[role="main"]') || document.scrollingElement;
    let last = -1;
    for (let i = 0; i < CFG.maxScrollPasses; i++) {
      if (scroller === document.scrollingElement) window.scrollTo(0, 0);
      else scroller.scrollTop = 0;
      await sleep(CFG.scrollPauseMs);
      const h = scroller.scrollHeight;
      if (h === last) break;
      last = h;
    }
  }

  function extractTurnsStrict() {
    const nodes = Array.from(document.querySelectorAll(SELECTORS.roleTurns));
    const turns = [];
    let i = 1;
    for (const node of nodes) {
      const role = node.getAttribute("data-message-author-role") || "unknown";
      const text = cleanText(node.innerText || node.textContent || "");
      if (!text) continue;
      if (/^You said:/i.test(text)) continue;
      if (/^ChatGPT said:/i.test(text)) continue;
      turns.push({ i: i++, role, text });
    }

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
    if (lc.includes("ifta") || lc.includes("ifra")) tags.push("ifra");
    if (lc.includes("termux")) tags.push("termux");
    if (lc.includes("wkhtml")) tags.push("wkhtmltopdf");
    return uniq(tags);
  }

  async function appendLedgerEvent(evt) {
    const ledger = await kvGet(CFG.storage.ledger, { schema: "mb_harvest_run_ledger_v1", run_id: null, events: [] });
    if (!ledger.run_id) ledger.run_id = `run_${nowIso().replace(/[:.]/g, "-")}`;
    ledger.events.push(evt);
    await kvSet(CFG.storage.ledger, ledger);
  }

  async function updateIndexEntry(entry) {
    const index = await kvGet(CFG.storage.index, { schema: "mb_chat_index_v1", generated_at: null, items: [] });
    index.generated_at = nowIso();
    index.items.push(entry);
    await kvSet(CFG.storage.index, index);
  }

  async function exportPerChatArtifact(record) {
    const day = record.source.captured_at.slice(0, 10);
    const cid = record.conversation_id || "unknown";
    const tslug = record.source.title_clean || "untitled";
    const runFolderSlug = safeFolderSlug(record.source.run_folder_name || "");
    const fname = `ch_${day}__${runFolderSlug}__${cid}__${tslug}__${record.status}.json`;
    downloadText(fname, JSON.stringify(record, null, 2));
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
      source: {
        url,
        captured_at: nowIso(),
        title_raw: titleRaw,
        title_clean: titleClean,
        run_folder_name: runFolderName
      },
      status: statusVal,
      stats: {
        turns: turns.length,
        chars: turns.reduce((a, t) => a + (t.text ? t.text.length : 0), 0)
      },
      tags: [],
      summary: {
        one_line: turns.length ? cleanText(turns[0].text).slice(0, 220) : null,
        key_terms: []
      },
      turns,
      evidence: {
        rendered_messages_detected: rendered,
        selector_path: "data-message-author-role",
        notes: rendered ? [] : ["Timed out waiting for role-marked message nodes; emitting fail-closed artifact."]
      }
    };

    record.tags = deriveTags(record);
    record.summary.key_terms = uniq(
      record.tags.concat((record.status !== "OK") ? ["needs_review"] : [])
    );

    const fname = await exportPerChatArtifact(record);

    await updateIndexEntry({
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

  /* ===================== SERIAL RUNNER ===================== */

  async function setRunState(patch) {
    const run = await kvGet(CFG.storage.run, {
      running: false,
      paused: false,
      processed: 0,
      exports_attempted: 0,
      exports_ok: 0,
      exports_error: 0,
      batch: [],
      idx: 0
    });
    Object.assign(run, patch);
    await kvSet(CFG.storage.run, run);
    return run;
  }

  async function runSerial() {
    // Ensure Run Folder Name is persisted even if user forgot to click Save
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
      batch,
      idx: 0
    });

    await refreshStatus(`Starting serial run of ${batch.length}. Keep browser foreground; do not open Downloads mid-run.`);
    location.href = batch[0];
  }

  async function pauseRun(reason) {
    await setRunState({ paused: true });
    await refreshStatus(
      `Paused.\n${reason || ""}\n` +
      `If downloads were blocked, allow multiple downloads for this site, then click Resume.`
    );
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

    const cid = extractConversationIdFromUrl();
    if (!cid) return;

    await setRunState({ exports_attempted: (run.exports_attempted || 0) + 1 });

    try {
      const { record } = await harvestCurrentConversation();
      const run2 = await kvGet(CFG.storage.run, run);
      await setRunState({
        processed: (run2.processed || 0) + 1,
        exports_ok: (run2.exports_ok || 0) + (record.status === "OK" ? 1 : 0),
        exports_error: (run2.exports_error || 0) + (record.status !== "OK" ? 1 : 0)
      });
      await sleep(CFG.downloadThrottleMs);
    } catch (e) {
      const run2 = await kvGet(CFG.storage.run, run);
      await setRunState({
        processed: (run2.processed || 0) + 1,
        exports_error: (run2.exports_error || 0) + 1
      });

      await appendLedgerEvent({
        t: nowIso(),
        type: "CHAT_EXPORT_EXCEPTION",
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

    await setRunState({ running: false, paused: false });
    const controllerUrl = await kvGet(CFG.storage.controllerUrl, null);
    await refreshStatus(`Done. Exported ${(updated.processed || 0)} chats.\nNow safe to open Downloads/File Explorer.`);
    if (controllerUrl) {
      await sleep(CFG.navSettleMs);
      location.href = controllerUrl;
    }
  }

  /* ===================== EXPORTS ===================== */

  async function exportIndex() {
    const index = await kvGet(CFG.storage.index, { schema: "mb_chat_index_v1", generated_at: null, items: [] });
    const fname = `mb_chat_index__${nowIso().slice(0, 10)}.json`;
    downloadText(fname, JSON.stringify(index, null, 2));
    await refreshStatus(`Exported index: ${fname}`);
  }

  async function exportLedger() {
    const ledger = await kvGet(CFG.storage.ledger, { schema: "mb_harvest_run_ledger_v1", run_id: null, events: [] });
    const fname = `mb_run_ledger__${nowIso().slice(0, 10)}.json`;
    downloadText(fname, JSON.stringify(ledger, null, 2));
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
    await refreshStatus("Cleared ALL storage.");
  }

  /* ===================== UI WIRING ===================== */

  $("#mbDiscover").addEventListener("click", discoverNow);
  $("#mbQueue").addEventListener("click", queueNext);
  $("#mbRun").addEventListener("click", runSerial);
  $("#mbPause").addEventListener("click", async () => pauseRun("User paused."));
  $("#mbResume").addEventListener("click", resumeRun);
  $("#mbExportIndex").addEventListener("click", exportIndex);
  $("#mbExportLedger").addEventListener("click", exportLedger);
  $("#mbClearRun").addEventListener("click", clearRun);
  $("#mbClearAll").addEventListener("click", clearAll);

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

  $("#mbSaveRunFolder").addEventListener("click", saveRunFolderFromUI);

  // Auto-save Run Folder Name on Enter and on blur (removes Save-button dependency)
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
    await loadRunFolderIntoUI();
    await refreshStatus();
  })();

  (async () => {
    await sleep(250);
    await serialTick();
  })();

})();
