// ==UserScript==
// @name         MetaBlooms Project Crawler + Sharded Export (UI + Governed, Fail-Closed)
// @namespace    metablooms.tampermonkey
// @version      2.1.0
// @description  Crawl all chats (virtualized sidebar-safe), harvest full transcripts, export size-bounded shards for ChatGPT/MetaBlooms. UI-controlled start. Ledgered. Fail-closed. SEE/MMD/ECL inside.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_download
// ==/UserScript==

(() => {
  "use strict";

  /* ============================================================
     0) GOVERNED CONFIG
     - User-gesture start required to reduce download blocking risk.
     - Sharding sized to be ingest-friendly.
  ============================================================ */

  const CFG = {
    // Sharding
    shardMaxChars: 140_000,
    shardOverlapTurns: 2,

    // Discovery (virtualized list safe)
    sidebarPreferSelectors: [
      "aside [role='navigation']",
      "nav",
      "aside",
      "[data-testid='conversation-list']",
    ],
    scrollStepPx: 720,
    scrollSettleMs: 250,
    stableRounds: 10,
    maxScrollRounds: 1600,

    // Hydration / stability
    navSettleMs: 1400,
    domQuietMs: 450,
    domTimeoutMs: 12_000,

    // History loading (chat transcript)
    maxScrollPasses: 60,
    scrollPauseMs: 320,

    // Export throttling:
    // - Some TM versions historically dropped rapid GM_download calls; throttle is prudent. (Also helps Chrome UX.)
    downloadThrottleMs: 1200,

    // Storage keys (append-only-ish)
    storage: {
      run: "mb_run_state_v2",
      queue: "mb_queue_v2",
      discovered: "mb_discovered_v2",
      index: "mb_index_v2",
      ledger: "mb_ledger_v2",
      settings: "mb_settings_v2",
    },
  };

  /* ============================================================
     1) UTILITIES
  ============================================================ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  const cleanText = (s) =>
    (s || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const slugify = (s) => {
    const t = cleanText(String(s || "")).toLowerCase();
    const slug = t.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return (slug || "untitled").slice(0, 72);
  };

  const uniq = (arr) => Array.from(new Set(arr));

  const normalizeUrl = (href) => {
    if (!href) return null;
    if (href.startsWith("http")) return href;
    return `${location.origin}${href}`;
  };

  const isConversationUrl = (u) => !!(u && /\/c\/[a-zA-Z0-9_-]+/.test(u));

  const extractConversationId = (u = location.pathname) => {
    const m = String(u).match(/\/c\/([^\/\?]+)/);
    return m ? m[1] : null;
  };

  async function kvGet(key, fallback) {
    const raw = await GM_getValue(key);
    if (raw === undefined || raw === null || raw === "") return fallback;
    try {
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return fallback;
    }
  }

  async function kvSet(key, val) {
    await GM_setValue(key, JSON.stringify(val));
  }

  async function kvDel(key) {
    await GM_deleteValue(key);
  }

  /* ============================================================
     2) LEDGER (append-only in storage)
  ============================================================ */

  async function appendLedger(evt) {
    const ledger = await kvGet(CFG.storage.ledger, {
      schema: "mb_ledger_v2",
      run_id: null,
      events: [],
    });
    if (!ledger.run_id) ledger.run_id = `run_${nowIso().replace(/[:.]/g, "-")}`;
    ledger.events.push({ t: nowIso(), ...evt });
    await kvSet(CFG.storage.ledger, ledger);
    return ledger.run_id;
  }

  /* ============================================================
     3) UI (ECL: operator-visible, no silent autorun)
  ============================================================ */

  GM_addStyle(`
    #mbPanel {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 1000000;
      width: 460px;
      max-width: calc(100vw - 24px);
      background: rgba(20,20,20,0.92);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 12px;
      padding: 10px;
      font: 12px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    }
    #mbPanel .row { display:flex; gap:8px; margin:6px 0; flex-wrap:wrap; align-items:center; }
    #mbPanel button {
      background: rgba(255,255,255,0.10);
      color:#fff;
      border:1px solid rgba(255,255,255,0.18);
      border-radius: 8px;
      padding: 6px 8px;
      cursor:pointer;
    }
    #mbPanel button:hover { background: rgba(255,255,255,0.16); }
    #mbPanel button:disabled { opacity: 0.55; cursor: not-allowed; }
    #mbStatus {
      white-space: pre-wrap;
      background: rgba(0,0,0,0.25);
      padding: 6px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.12);
      max-height: 220px;
      overflow: auto;
    }
    #mbPanel input[type="number"] { width: 92px; }
    #mbPanel .muted { opacity: 0.75; }
  `);

  const panel = document.createElement("div");
  panel.id = "mbPanel";
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div><strong>MetaBlooms Crawler</strong> <span class="muted">(v2.1.0)</span></div>
      <div class="row" style="margin:0">
        <button id="mbMin">Min</button>
        <button id="mbHide">Hide</button>
      </div>
    </div>

    <div class="row">
      <label class="muted">Batch:</label>
      <input id="mbBatch" type="number" min="1" max="9999" value="9999" />
      <label class="muted">Shard max chars:</label>
      <input id="mbShard" type="number" min="5000" max="500000" value="${CFG.shardMaxChars}" />
    </div>

    <div class="row">
      <button id="mbTest">Download Test</button>
      <button id="mbDiscover">Discover (Sidebar Exhaust)</button>
      <button id="mbStart">Start Crawl + Export</button>
      <button id="mbPause">Pause</button>
    </div>

    <div class="row">
      <button id="mbExportIndex">Export Index</button>
      <button id="mbExportLedger">Export Ledger</button>
      <button id="mbReset">Reset Run State</button>
    </div>

    <div id="mbStatus">Status: ready. Use “Download Test” first.</div>
  `;
  document.body.appendChild(panel);

  let minimized = false;
  let paused = false;
  let running = false;

  const setStatus = (txt) => {
    const el = document.querySelector("#mbStatus");
    if (!el) return;
    const prefix = `[${new Date().toLocaleTimeString()}] `;
    el.textContent = `${prefix}${txt}\n\n${el.textContent}`.slice(0, 8000);
  };

  document.querySelector("#mbHide").addEventListener("click", () => (panel.style.display = "none"));
  document.querySelector("#mbMin").addEventListener("click", () => {
    minimized = !minimized;
    panel.querySelectorAll(".row, #mbStatus").forEach((n) => (n.style.display = minimized ? "none" : ""));
  });

  document.querySelector("#mbPause").addEventListener("click", async () => {
    paused = true;
    await appendLedger({ type: "USER_PAUSE" });
    setStatus("Paused. (You can resume by pressing Start again.)");
  });

  /* ============================================================
     4) DOWNLOAD (ECL: user-gesture + reliable APIs)
     - Prefer GM_download when available (Tampermonkey API). :contentReference[oaicite:8]{index=8}
     - Still subject to Chrome automatic downloads permissions. :contentReference[oaicite:9]{index=9}
  ============================================================ */

  async function saveJsonFile(name, obj) {
    const text = JSON.stringify(obj, null, 2);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    try {
      if (typeof GM_download === "function") {
        // GM_download supports url + name; blob: URLs typically work in modern browsers.
        await new Promise((resolve, reject) => {
          GM_download({
            url,
            name,
            saveAs: false,
            onload: resolve,
            onerror: (e) => reject(e),
            ontimeout: () => reject(new Error("GM_download timeout")),
          });
        });
      } else {
        // Fallback: anchor click
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ============================================================
     5) SEE: DISCOVERY (virtualization-safe)
     - Virtualizers render only visible items; must scroll to force items into DOM. :contentReference[oaicite:10]{index=10}
  ============================================================ */

  function findScrollableContainer() {
    for (const sel of CFG.sidebarPreferSelectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight) return el;
    }
    // fallback: biggest scrollable element inside nav/aside
    const candidates = Array.from(
      document.querySelectorAll("nav, aside, [role='navigation'], [role='complementary'], div")
    ).filter((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== "hidden");
    candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return candidates[0] || null;
  }

  function collectConversationLinks() {
    return uniq(
      Array.from(document.querySelectorAll('a[href^="/c/"], a[href*="/c/"]'))
        .map((a) => normalizeUrl(a.getAttribute("href")))
        .filter(isConversationUrl)
    );
  }

  async function exhaustSidebarDiscover() {
    const container = findScrollableContainer();
    if (!container) {
      await appendLedger({ type: "DISCOVER_FAIL", reason: "NO_SCROLL_CONTAINER" });
      setStatus("Discover failed: no scroll container found (nav/aside likely changed).");
      return collectConversationLinks();
    }

    let lastCount = -1;
    let stable = 0;

    for (let i = 0; i < CFG.maxScrollRounds; i++) {
      if (paused) return collectConversationLinks();

      const links = collectConversationLinks();
      if (links.length === lastCount) stable++;
      else stable = 0;

      if (stable >= CFG.stableRounds) break;
      lastCount = links.length;

      container.scrollTop = Math.min(container.scrollTop + CFG.scrollStepPx, container.scrollHeight);
      await sleep(CFG.scrollSettleMs);
    }

    const out = collectConversationLinks();
    await kvSet(CFG.storage.discovered, out);
    await appendLedger({ type: "DISCOVER_OK", count: out.length });
    setStatus(`Discover OK: ${out.length} chat links captured (exhaustive scroll).`);
    return out;
  }

  /* ============================================================
     6) MMD: DOM QUIESCENCE (MutationObserver)
     - MDN requires at least one of childList/attributes/characterData true; subtree expands scope. :contentReference[oaicite:11]{index=11}
  ============================================================ */

  async function waitForDomQuiescence(root, quietMs, timeoutMs) {
    return new Promise((resolve) => {
      let timer = null;

      const done = (ok) => {
        try { obs.disconnect(); } catch {}
        resolve(ok);
      };

      const obs = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => done(true), quietMs);
      });

      // Correct observer options per MDN
      obs.observe(root, { childList: true, subtree: true });

      // Global timeout
      setTimeout(() => done(false), timeoutMs);

      // If nothing happens, still resolve after quiet window
      timer = setTimeout(() => done(true), quietMs);
    });
  }

  /* ============================================================
     7) SEE: TRANSCRIPT HARVEST
  ============================================================ */

  async function scrollUpToLoadHistory() {
    const main = document.querySelector("main") || document.querySelector('[role="main"]');
    const scroller = main || document.scrollingElement;

    let lastH = -1;
    for (let i = 0; i < CFG.maxScrollPasses; i++) {
      if (paused) return;

      if (scroller === document.scrollingElement) window.scrollTo(0, 0);
      else scroller.scrollTop = 0;

      await sleep(CFG.scrollPauseMs);

      const h = scroller.scrollHeight;
      if (h === lastH) break;
      lastH = h;
    }
  }

  function extractTurnsFailClosed() {
    // Primary strategy: ChatGPT often provides author-role attributes
    const nodes = Array.from(document.querySelectorAll('[data-message-author-role]'));
    if (!nodes.length) return { ok: false, reason: "NO_ROLE_NODES", turns: [] };

    const turns = [];
    let i = 1;
    for (const n of nodes) {
      const role = n.getAttribute("data-message-author-role") || "unknown";
      const text = cleanText(n.innerText || n.textContent || "");
      if (!text) continue;
      turns.push({ i: i++, role, text });
    }

    if (!turns.length) return { ok: false, reason: "EMPTY_TURNS", turns: [] };

    // de-dup exact repeats
    const seen = new Set();
    const uniqTurns = [];
    for (const t of turns) {
      const k = `${t.role}::${t.text}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniqTurns.push(t);
    }

    return { ok: true, turns: uniqTurns };
  }

  /* ============================================================
     8) ECL: SHARDING
  ============================================================ */

  function shardTurns(turns, maxChars, overlapTurns) {
    const shards = [];
    let cur = [];
    let curChars = 0;

    const flush = () => {
      if (!cur.length) return;
      shards.push(cur);

      // overlap last N turns for continuity
      const overlap = cur.slice(-overlapTurns);
      cur = overlap.slice();
      curChars = overlap.reduce((a, t) => a + t.text.length, 0);
    };

    for (const t of turns) {
      const len = t.text.length;
      if (curChars + len > maxChars) flush();
      cur.push(t);
      curChars += len;
    }
    flush();
    return shards;
  }

  /* ============================================================
     9) (Optional) Prompt Injection Utilities (React-safe)
     - Native setter + input event is a standard approach for React controlled inputs. :contentReference[oaicite:12]{index=12}
     - InputEvent exists for editable content changes. :contentReference[oaicite:13]{index=13}
     - execCommand is deprecated; keep only as fallback if you add sending later. :contentReference[oaicite:14]{index=14}
  ============================================================ */

  function setReactControlledValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      el instanceof HTMLInputElement ? HTMLInputElement.prototype :
      null;

    const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;

    // React typically listens for input events
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ============================================================
     10) RUN STATE
  ============================================================ */

  async function resetRunState() {
    await kvDel(CFG.storage.run);
    await kvDel(CFG.storage.queue);
    await kvDel(CFG.storage.discovered);
    // keep index/ledger unless you want them wiped too
    setStatus("Run state cleared (queue/discovered/run).");
    await appendLedger({ type: "RESET_RUN_STATE" });
  }

  async function getRunState() {
    return await kvGet(CFG.storage.run, {
      schema: "mb_run_state_v2",
      cursor: 0,
      active: false,
      started_at: null,
      last_url: null,
      failures: 0,
    });
  }

  async function setRunState(rs) {
    await kvSet(CFG.storage.run, rs);
  }

  /* ============================================================
     11) EXPORT INDEX / LEDGER (operator buttons)
  ============================================================ */

  async function exportIndex() {
    const idx = await kvGet(CFG.storage.index, { schema: "mb_index_v2", items: [] });
    const name = `mb_index__${nowIso().replace(/[:.]/g, "-")}.json`;
    await saveJsonFile(name, idx);
    await appendLedger({ type: "EXPORT_INDEX", file: name, count: idx.items.length });
    setStatus(`Index exported: ${name}`);
  }

  async function exportLedger() {
    const led = await kvGet(CFG.storage.ledger, { schema: "mb_ledger_v2", run_id: null, events: [] });
    const name = `mb_ledger__${(led.run_id || "run")}_${nowIso().replace(/[:.]/g, "-")}.json`;
    await saveJsonFile(name, led);
    setStatus(`Ledger exported: ${name}`);
  }

  document.querySelector("#mbExportIndex").addEventListener("click", exportIndex);
  document.querySelector("#mbExportLedger").addEventListener("click", exportLedger);
  document.querySelector("#mbReset").addEventListener("click", resetRunState);

  /* ============================================================
     12) DOWNLOAD TEST (preflight)
     - Validates whether the browser is allowing script-initiated downloads.
     - If this fails/no file appears, you likely need to allow Automatic downloads for chatgpt.com. :contentReference[oaicite:15]{index=15}
  ============================================================ */

  document.querySelector("#mbTest").addEventListener("click", async () => {
    try {
      const payload = {
        schema: "mb_download_test_v1",
        t: nowIso(),
        note:
          "If this file did not download, allow site permission: Settings > Site settings > Automatic downloads.",
      };
      const name = `mb_download_test__${Date.now()}.json`;
      await saveJsonFile(name, payload);
      await appendLedger({ type: "DOWNLOAD_TEST_TRIGGERED", file: name });
      setStatus(`Download test triggered: ${name}`);
    } catch (e) {
      await appendLedger({ type: "DOWNLOAD_TEST_FAILED", error: String(e?.message || e) });
      setStatus(`Download test FAILED (see console). Error: ${String(e?.message || e)}`);
    }
  });

  /* ============================================================
     13) DISCOVER BUTTON
  ============================================================ */

  document.querySelector("#mbDiscover").addEventListener("click", async () => {
    paused = false;
    await exhaustSidebarDiscover();
  });

  /* ============================================================
     14) HARVEST ONE CHAT → EXPORT SHARDS
  ============================================================ */

  async function harvestAndExportCurrentChat() {
    const conversation_id = extractConversationId() || `unknown_${Date.now()}`;
    const title_raw = document.title || "";
    const title_clean = slugify(title_raw);

    const root = document.querySelector("main") || document.body;

    // MMD: wait for initial hydration
    const quiet1 = await waitForDomQuiescence(root, CFG.domQuietMs, CFG.domTimeoutMs);

    // SEE: load full history
    await scrollUpToLoadHistory();

    // MMD: wait for post-scroll hydration
    const quiet2 = await waitForDomQuiescence(root, CFG.domQuietMs, CFG.domTimeoutMs);

    const extraction = extractTurnsFailClosed();
    if (!extraction.ok) {
      await appendLedger({
        type: "HARVEST_FAIL",
        conversation_id,
        reason: extraction.reason,
        url: location.href,
        quiet1,
        quiet2,
      });
      return { ok: false, reason: extraction.reason };
    }

    const maxChars = Number(document.querySelector("#mbShard").value) || CFG.shardMaxChars;
    const shards = shardTurns(extraction.turns, maxChars, CFG.shardOverlapTurns);

    const meta = {
      schema: "mb_chat_meta_v2",
      conversation_id,
      url: location.href,
      captured_at: nowIso(),
      title_raw,
      title_clean,
      quiet1,
      quiet2,
      turns: extraction.turns.length,
      shard_count: shards.length,
    };

    for (let si = 0; si < shards.length; si++) {
      if (paused) return { ok: false, reason: "PAUSED" };

      const payload = {
        schema: "mb_chat_shard_v2",
        meta,
        shard_index: si,
        shard_count: shards.length,
        stats: {
          turns: shards[si].length,
          chars: shards[si].reduce((a, t) => a + t.text.length, 0),
        },
        turns: shards[si],
      };

      const fname =
        `shard__${meta.captured_at.slice(0,10)}__${title_clean}__${conversation_id}__${String(si+1).padStart(3,"0")}-of-${String(shards.length).padStart(3,"0")}.json`;

      await saveJsonFile(fname, payload);
      await appendLedger({ type: "SHARD_EXPORTED", conversation_id, file: fname, shard_index: si });
      await sleep(CFG.downloadThrottleMs);
    }

    // Update index
    const index = await kvGet(CFG.storage.index, { schema: "mb_index_v2", items: [] });
    index.items.push({
      conversation_id,
      title_clean,
      captured_at: meta.captured_at,
      shard_count: shards.length,
      url: meta.url,
    });
    await kvSet(CFG.storage.index, index);

    await appendLedger({ type: "CHAT_COMPLETE", conversation_id, shards: shards.length });
    return { ok: true, shards: shards.length };
  }

  /* ============================================================
     15) SERIAL RUNNER (NO AUTORUN)
  ============================================================ */

  async function buildQueueFromDiscover(batchLimit) {
    const links = await exhaustSidebarDiscover();
    const q = links.slice(0, batchLimit);
    await kvSet(CFG.storage.queue, q);
    await appendLedger({ type: "QUEUE_BUILT", total: links.length, queued: q.length });
    return q;
  }

  async function runSerialCrawl() {
    if (running) {
      setStatus("Already running.");
      return;
    }
    running = true;
    paused = false;

    const batchLimit = Math.max(1, Number(document.querySelector("#mbBatch").value) || 9999);
    const queue = await buildQueueFromDiscover(batchLimit);

    const rs = await getRunState();
    rs.active = true;
    rs.started_at = rs.started_at || nowIso();
    await setRunState(rs);

    const runId = await appendLedger({ type: "RUN_START", queued: queue.length, batchLimit });

    setStatus(
      `RUN_START (${runId}). If you see no downloads, allow site permission: Automatic downloads.`
    );

    for (let i = rs.cursor; i < queue.length; i++) {
      if (paused) {
        await appendLedger({ type: "RUN_PAUSED", cursor: i });
        rs.cursor = i;
        rs.active = false;
        await setRunState(rs);
        setStatus(`Paused at cursor ${i}/${queue.length}. Press Start to resume.`);
        running = false;
        return;
      }

      const url = queue[i];
      rs.last_url = url;
      rs.cursor = i;
      await setRunState(rs);

      await appendLedger({ type: "NAVIGATE", i, url });

      // Navigate
      location.href = url;

      // Wait for SPA / load
      await sleep(CFG.navSettleMs);

      // Harvest & export
      const res = await harvestAndExportCurrentChat();
      if (!res.ok) {
        rs.failures = (rs.failures || 0) + 1;
        await setRunState(rs);
        setStatus(`Harvest failed at ${i}: ${res.reason}. Continuing.`);
      } else {
        setStatus(`Chat ${i + 1}/${queue.length} exported (${res.shards} shards).`);
      }
    }

    rs.active = false;
    rs.cursor = queue.length;
    await setRunState(rs);

    await appendLedger({ type: "RUN_DONE", total: queue.length, failures: rs.failures || 0 });
    setStatus(`RUN_DONE. Export Index / Export Ledger now if desired.`);
    running = false;
  }

  /* ============================================================
     16) START BUTTON (User gesture)
  ============================================================ */

  document.querySelector("#mbStart").addEventListener("click", async () => {
    // User gesture start is important: browsers may block scripted multiple downloads without permission. :contentReference[oaicite:16]{index=16}
    paused = false;
    await appendLedger({ type: "USER_START" });
    setStatus("Starting crawl… (this click authorizes downloads as much as the browser allows).");
    runSerialCrawl();
  });

  /* ============================================================
     17) BOOT MESSAGE (no autorun)
  ============================================================ */

  (async () => {
    await appendLedger({ type: "BOOT_READY", href: location.href });
    setStatus("Ready. Run Download Test first. Then Discover or Start.");
  })();

})();
