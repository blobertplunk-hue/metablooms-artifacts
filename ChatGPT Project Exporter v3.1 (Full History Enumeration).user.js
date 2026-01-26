// ==UserScript==
// @name         ChatGPT Project Exporter v3.1 (Full History Enumeration)
// @namespace    metablooms.tools
// @version      3.1.0
// @description  Project exporter with robust project list auto-scroll enumeration (avoids DOM-limited ~10 items), auto-resume, dark UI.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CFG = {
    hotkey: { alt: true, key: "e" },
    panelSide: "left",
    panelTopPx: 120,

    settleMs: 1200,
    perChatDelayMs: 650,

    // Project list enumeration hardening
    maxChats: 50000,
    listScrollPasses: 600,
    listScrollPauseMs: 240,
    stablePassesToStop: 10,     // require N consecutive passes with no growth
    lowCountFailClosed: 12,      // if <= this, treat as suspiciously incomplete
    allowLowCountOverride: false, // flip true if you ever want to export small projects without fail-closed

    // Transcript coaxing
    transcriptScrollPasses: 12,
    minTurnsWarn: 2,
  };

  const LS_UI  = "MBX_V31_UI";
  const LS_RUN = "MBX_V31_RUN";

  const readJson = (k, fb) => { try { return JSON.parse(localStorage.getItem(k) || "") ?? fb; } catch { return fb; } };
  const writeJson = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const delKey = (k) => localStorage.removeItem(k);

  const UI = readJson(LS_UI, { visible: false });
  let RUN = readJson(LS_RUN, null);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => new Date().toISOString();
  const txt = (el) => (el?.innerText || el?.textContent || "").trim();

  function normalizeUrl(u) {
    try { const url = new URL(u, location.origin); url.hash = ""; return url.toString(); }
    catch { return u; }
  }

  function convoIdFromUrl(u) {
    try { const url = new URL(u, location.origin); const m = url.pathname.match(/\/c\/([^\/]+)/); return m ? m[1] : ""; }
    catch { return ""; }
  }

  async function waitStable(ms = CFG.settleMs) {
    let last = Date.now();
    const obs = new MutationObserver(() => (last = Date.now()));
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
    while (Date.now() - last < ms) await sleep(180);
    obs.disconnect();
  }

  function isProjectLike() {
    return location.pathname.includes("/g/") || location.pathname.includes("/project");
  }

  /********************
   * UI (dark panel + pill)
   ********************/
  function ensureUI() {
    if (document.getElementById("mbxv31-panel")) return;

    const panel = document.createElement("div");
    panel.id = "mbxv31-panel";
    panel.style.position = "fixed";
    panel.style.top = `${CFG.panelTopPx}px`;
    panel.style[CFG.panelSide] = "12px";
    panel.style.zIndex = "999999";
    panel.style.width = "410px";
    panel.style.display = "none";

    panel.innerHTML = `
      <div style="
        background:#0b0f14; color:#e6edf3;
        border:1px solid rgba(230,237,243,.18);
        border-radius:14px;
        box-shadow: 0 18px 48px rgba(0,0,0,.55);
        padding:12px;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        font-size:12.5px;
      ">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
          <div style="font-weight:850;">MB Project Exporter</div>
          <div style="display:flex; gap:8px; align-items:center;">
            <span style="opacity:.75;">Alt+E</span>
            <button id="mbxv31-hide" style="cursor:pointer; background:#111827; color:#e6edf3; border:1px solid rgba(230,237,243,.18); border-radius:10px; padding:5px 9px;">Hide</button>
          </div>
        </div>

        <div id="mbxv31-status" style="margin:10px 0 8px; color:#cbd5e1;">Idle.</div>

        <div style="height:10px; background:rgba(230,237,243,.10); border-radius:10px; overflow:hidden;">
          <div id="mbxv31-bar" style="height:10px; width:0%; background:rgba(56,189,248,.92);"></div>
        </div>

        <div style="display:flex; gap:8px; margin:12px 0 10px; flex-wrap:wrap;">
          <button id="mbxv31-start" style="cursor:pointer; background:#1f2937; color:#e6edf3; border:1px solid rgba(230,237,243,.18); border-radius:12px; padding:7px 11px;">Start</button>
          <button id="mbxv31-stop" style="cursor:pointer; background:#3b0a0a; color:#fecaca; border:1px solid rgba(252,165,165,.32); border-radius:12px; padding:7px 11px;">Stop</button>
          <button id="mbxv31-json" style="cursor:pointer; background:#0f172a; color:#e6edf3; border:1px solid rgba(230,237,243,.18); border-radius:12px; padding:7px 11px;" disabled>Download JSON</button>
          <button id="mbxv31-md" style="cursor:pointer; background:#0f172a; color:#e6edf3; border:1px solid rgba(230,237,243,.18); border-radius:12px; padding:7px 11px;" disabled>Download MD</button>
          <button id="mbxv31-reset" style="cursor:pointer; background:#111827; color:#e6edf3; border:1px solid rgba(230,237,243,.18); border-radius:12px; padding:7px 11px;">Reset</button>
        </div>

        <div style="margin:6px 0 10px; font-size:11.5px; color:#9ca3af;">
          <div><b style="color:#e6edf3;">Queued:</b> <span id="mbxv31-q">0</span></div>
          <div><b style="color:#e6edf3;">Progress:</b> <span id="mbxv31-prog">0 / 0</span></div>
          <div><b style="color:#e6edf3;">Last URL:</b> <span id="mbxv31-last">—</span></div>
          <div><b style="color:#e6edf3;">Last turns:</b> <span id="mbxv31-lastturns">—</span></div>
        </div>

        <div>
          <div style="font-weight:750; margin-bottom:6px;">Log</div>
          <textarea id="mbxv31-log" readonly style="
            width:100%; height:140px; resize:vertical;
            background:#05070a; color:#e6edf3;
            border:1px solid rgba(230,237,243,.16); border-radius:12px; padding:9px;
          "></textarea>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const pill = document.createElement("div");
    pill.id = "mbxv31-pill";
    pill.style.position = "fixed";
    pill.style.left = "12px";
    pill.style.bottom = "12px";
    pill.style.zIndex = "999998";
    pill.style.display = "none";
    pill.style.padding = "8px 10px";
    pill.style.borderRadius = "999px";
    pill.style.background = "rgba(11,15,20,.92)";
    pill.style.color = "#e6edf3";
    pill.style.border = "1px solid rgba(230,237,243,.18)";
    pill.style.boxShadow = "0 10px 28px rgba(0,0,0,.45)";
    pill.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    pill.style.fontSize = "12px";
    pill.style.cursor = "pointer";
    pill.title = "Click to open exporter panel (Alt+E)";
    pill.textContent = "Exporter: idle";
    pill.addEventListener("click", () => { UI.visible = true; writeJson(LS_UI, UI); setPanelVisible(true); });
    document.body.appendChild(pill);

    el("mbxv31-hide").addEventListener("click", () => setPanelVisible(false));
    el("mbxv31-start").addEventListener("click", startRun);
    el("mbxv31-stop").addEventListener("click", requestStop);
    el("mbxv31-reset").addEventListener("click", () => { clearRun(); uiStatus("Run reset."); logLine("Run reset."); refreshUI(); });
    el("mbxv31-json").addEventListener("click", downloadJSON);
    el("mbxv31-md").addEventListener("click", downloadMD);

    refreshUI();
  }

  function el(id) { return document.getElementById(id); }
  function setPanelVisible(v) { ensureUI(); el("mbxv31-panel").style.display = v ? "block" : "none"; UI.visible = !!v; writeJson(LS_UI, UI); }
  function setPillVisible(v) { ensureUI(); el("mbxv31-pill").style.display = v ? "block" : "none"; }
  function pillText(s) { ensureUI(); el("mbxv31-pill").textContent = s; }
  function logLine(s) { const ta = el("mbxv31-log"); const line = `[${new Date().toLocaleTimeString()}] ${s}`; ta.value = (ta.value ? ta.value + "\n" : "") + line; ta.scrollTop = ta.scrollHeight; }
  function uiStatus(s) { const st = el("mbxv31-status"); if (st) st.textContent = s; }

  function setProgress(done, total) {
    el("mbxv31-prog").textContent = `${done} / ${total}`;
    const pct = total ? Math.round((done / total) * 100) : 0;
    el("mbxv31-bar").style.width = `${pct}%`;
  }

  function setLast(url, turns) {
    el("mbxv31-last").textContent = url || "—";
    el("mbxv31-lastturns").textContent = (typeof turns === "number") ? String(turns) : "—";
  }

  function setQueued(n) { el("mbxv31-q").textContent = String(n || 0); }
  function setExportEnabled(v) { el("mbxv31-json").disabled = !v; el("mbxv31-md").disabled = !v; }

  function refreshUI() {
    ensureUI();
    const total = RUN?.links?.length || 0;
    const done = RUN?.index || 0;
    setQueued(total);
    setProgress(done, total);
    setLast(RUN?.lastUrl || "", RUN?.lastTurns);
    setExportEnabled(Boolean(RUN && RUN.running === false && RUN.data && RUN.data.length > 0));
    setPillVisible(Boolean(RUN && RUN.running === true));
    pillText(RUN && RUN.running ? `Exporting ${Math.min(done + 1, total)}/${total}…` : "Exporter: idle");
  }

  /********************
   * RUN STATE
   ********************/
  function newRunId() { return "mbxv31_" + Math.random().toString(16).slice(2) + "_" + Date.now(); }
  function saveRun() { writeJson(LS_RUN, RUN); }
  function clearRun() { delKey(LS_RUN); RUN = null; }
  function runActive() { return RUN && RUN.running === true && Array.isArray(RUN.links) && typeof RUN.index === "number"; }

  function sameConversation(a, b) {
    const ida = convoIdFromUrl(a), idb = convoIdFromUrl(b);
    if (ida && idb) return ida === idb;
    return normalizeUrl(a) === normalizeUrl(b);
  }

  /********************
   * ROBUST LINK ENUMERATION (the fix)
   ********************/
  function findLikelyProjectListContainer() {
    const thread = document.querySelector("#thread");
    if (thread) {
      const candidates = [...thread.querySelectorAll("div,aside,section,nav")];
      let best = null, bestScore = 0;
      for (const c of candidates) {
        const count = c.querySelectorAll('a[href*="/c/"]').length;
        if (count < 3) continue;
        const hasMessages = c.querySelector('[data-message-author-role]') ? 1 : 0;
        const score = count - (hasMessages ? 10 : 0);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (best) return best;
    }
    const all = [...document.querySelectorAll("aside,nav,section,div")];
    let best = null, bestScore = 0;
    for (const el of all) {
      const count = el.querySelectorAll('a[href*="/c/"]').length;
      if (count < 3) continue;
      const transcriptish = el.querySelector('[data-message-author-role]') ? 1 : 0;
      const score = count - (transcriptish ? 10 : 0);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function forceScrollable(el) {
    try {
      el.style.overflowY = "auto";
      el.style.maxHeight = "75vh";
      el.style.scrollBehavior = "auto";
      return true;
    } catch { return false; }
  }

  async function enumerateAllLinksFailClosed() {
    const container = findLikelyProjectListContainer();
    if (!container) return { ok: false, reason: "NO_PROJECT_LIST_CONTAINER", links: [] };

    forceScrollable(container);

    const seen = new Set();
    let stable = 0;
    let lastCount = 0;

    for (let pass = 0; pass < CFG.listScrollPasses; pass++) {
      container.querySelectorAll('a[href*="/c/"]').forEach(a => {
        const href = normalizeUrl(a.href);
        if (href.includes("/c/")) seen.add(href);
      });

      const count = seen.size;

      // Stability gate
      if (count === lastCount) stable += 1;
      else stable = 0;

      lastCount = count;

      if (pass % 10 === 0) {
        uiStatus(`Enumerating chats… found ${count} (stable ${stable}/${CFG.stablePassesToStop})`);
        logLine(`Enumerate: found ${count} (stable ${stable}/${CFG.stablePassesToStop})`);
        refreshUI();
      }

      if (stable >= CFG.stablePassesToStop) break;
      if (count >= CFG.maxChats) break;

      // Scroll to load more
      container.scrollTop = container.scrollHeight;
      await sleep(CFG.listScrollPauseMs);
      await waitStable(500);
    }

    const links = [...seen];
    if (!CFG.allowLowCountOverride && links.length <= CFG.lowCountFailClosed) {
      return { ok: false, reason: `SUSPICIOUSLY_LOW_LINK_COUNT_${links.length}`, links };
    }
    return { ok: true, reason: "OK", links };
  }

  /********************
   * TRANSCRIPT
   ********************/
  async function coaxTranscript() {
    const root = document.querySelector("main") || document.querySelector('[role="main"]') || document.body;
    const scroller =
      root.querySelector('[class*="overflow-y-auto"]') ||
      root.querySelector('[style*="overflow"]') ||
      null;

    for (let i = 0; i < CFG.transcriptScrollPasses; i++) {
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
        await sleep(170);
        scroller.scrollTop = 0;
        await sleep(170);
      } else {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(170);
        window.scrollTo(0, 0);
        await sleep(170);
      }
      await waitStable(550);
    }
  }

  function extractTurns() {
    const nodes = [...document.querySelectorAll('[data-message-author-role]')];
    const turns = [];
    for (const n of nodes) {
      const role = n.getAttribute("data-message-author-role") || "unknown";
      const md = n.querySelector(".markdown") || n;
      const content = txt(md);
      if (content) turns.push({ role, content });
    }
    return turns;
  }

  function pageTitle() {
    return (document.title || "").replace(/\s*-\s*ChatGPT\s*$/i, "").trim();
  }

  /********************
   * DOWNLOADS
   ********************/
  function downloadText(filename, content) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
  }

  function downloadJSON() {
    if (!RUN) return;
    const out = { run_id: RUN.run_id, meta: RUN.meta, count: RUN.data.length, chats: RUN.data, warnings: RUN.warnings || [] };
    downloadText(`project_export_${RUN.run_id}.json`, JSON.stringify(out, null, 2));
    logLine("Downloaded JSON export.");
  }

  function downloadMD() {
    if (!RUN) return;
    const lines = [];
    lines.push(`# Project Export`);
    lines.push(`- Run ID: ${RUN.run_id}`);
    lines.push(`- Source: ${RUN.meta.project_url || ""}`);
    lines.push(`- Started: ${RUN.meta.started_at}`);
    lines.push(`- Finished: ${RUN.meta.finished_at || ""}`);
    lines.push(`- Chats: ${RUN.data.length}`);
    lines.push("");

    RUN.data.forEach((c, i) => {
      lines.push(`## Chat ${String(i + 1).padStart(3, "0")} — ${c.title || ""}`.trim());
      lines.push(`URL: ${c.url}`);
      lines.push("");
      c.turns.forEach(t => { lines.push(`**${t.role}**`); lines.push(t.content); lines.push(""); });
      lines.push("---");
      lines.push("");
    });

    downloadText(`project_export_${RUN.run_id}.md`, lines.join("\n"));
    logLine("Downloaded Markdown export.");
  }

  /********************
   * CONTROLS
   ********************/
  function requestStop() {
    if (!RUN) return;
    RUN.stopRequested = true;
    saveRun();
    uiStatus("Stop requested… will stop after current capture.");
    logLine("Stop requested.");
    refreshUI();
  }

  /********************
   * START + RESUME
   ********************/
  async function startRun() {
    ensureUI();

    if (!isProjectLike()) {
      alert("Navigate into the target Project first (project page or a project chat).");
      return;
    }

    UI.visible = true; writeJson(LS_UI, UI); setPanelVisible(true);

    uiStatus("Enumerating FULL project chat history (scrolling list)…");
    logLine("Start: robust link enumeration begins.");
    refreshUI();

    await waitStable();

    const res = await enumerateAllLinksFailClosed();
    if (!res.ok) {
      uiStatus(`Fail-closed: ${res.reason}. (Try opening the project chat list pane and scrolling a bit, then Start again.)`);
      logLine(`Fail-closed enumeration: ${res.reason}`);
      refreshUI();
      return;
    }

    RUN = {
      run_id: newRunId(),
      running: true,
      stopRequested: false,
      meta: { started_at: now(), project_url: normalizeUrl(location.href), user_agent: navigator.userAgent },
      links: res.links.slice(0, CFG.maxChats),
      index: 0,
      data: [],
      warnings: [],
      lastUrl: "",
      lastTurns: null,
    };
    saveRun();
    uiStatus(`Queued ${RUN.links.length} chats. Navigating to 1/${RUN.links.length}…`);
    logLine(`Queued ${RUN.links.length} chats.`);
    refreshUI();
    location.href = RUN.links[0];
  }

  async function resumeIfRunning() {
    if (!runActive()) return;

    ensureUI();
    setPillVisible(true);
    if (UI.visible === true) setPanelVisible(true);

    if (RUN.stopRequested) {
      RUN.running = false;
      RUN.meta.finished_at = now();
      saveRun();
      uiStatus(`Stopped. Captured ${RUN.data.length}/${RUN.links.length}. Ready to export.`);
      logLine("Stopped.");
      refreshUI();
      return;
    }

    const target = RUN.links[RUN.index];
    if (!target) {
      RUN.running = false;
      RUN.meta.finished_at = now();
      saveRun();
      uiStatus(`Done. Captured ${RUN.data.length}/${RUN.links.length}. Ready to export.`);
      logLine("Done.");
      refreshUI();
      return;
    }

    const here = normalizeUrl(location.href);

    if (!here.includes("/c/") || !sameConversation(here, target)) {
      uiStatus(`Resuming… navigating to ${RUN.index + 1}/${RUN.links.length}`);
      logLine(`Navigate (resume) -> ${target}`);
      refreshUI();
      location.href = target;
      return;
    }

    RUN.lastUrl = target;
    RUN.lastTurns = null;
    saveRun();

    uiStatus(`Capturing ${RUN.index + 1}/${RUN.links.length}…`);
    logLine(`Capturing -> ${target}`);
    refreshUI();

    await waitStable();
    await sleep(CFG.perChatDelayMs);
    await coaxTranscript();
    await waitStable(850);

    const turns = extractTurns();
    const title = pageTitle();

    const rec = {
      captured_at: now(),
      url: target,
      conversation_id: convoIdFromUrl(target),
      title,
      turns,
      turn_count: turns.length,
      empty: turns.length === 0,
    };

    RUN.data.push(rec);
    RUN.lastTurns = rec.turn_count;

    if (rec.turn_count < CFG.minTurnsWarn) {
      RUN.warnings.push({ url: target, title, reason: "LOW_TURN_COUNT", turn_count: rec.turn_count });
      logLine(`WARN: low turn count (${rec.turn_count}) — possible virtualization.`);
    } else {
      logLine(`OK: ${rec.turn_count} turns captured.`);
    }

    RUN.index += 1;
    saveRun();
    refreshUI();

    if (RUN.index >= RUN.links.length) {
      RUN.running = false;
      RUN.meta.finished_at = now();
      saveRun();
      uiStatus(`Done. Captured ${RUN.data.length}/${RUN.links.length}. Use Download buttons.`);
      logLine("Run complete.");
      refreshUI();
      return;
    }

    const nextUrl = RUN.links[RUN.index];
    uiStatus(`Opening ${RUN.index + 1}/${RUN.links.length}…`);
    logLine(`Navigate -> ${nextUrl}`);
    refreshUI();
    location.href = nextUrl;
  }

  /********************
   * HOTKEY
   ********************/
  function matchesHotkey(e) {
    const k = String(e.key || "").toLowerCase();
    if (CFG.hotkey.alt && !e.altKey) return false;
    return k === CFG.hotkey.key;
  }

  document.addEventListener("keydown", (e) => {
    if (matchesHotkey(e)) {
      e.preventDefault();
      ensureUI();
      setPanelVisible(!(UI.visible === true));
    }
  }, true);

  /********************
   * INIT
   ********************/
  ensureUI();
  if (UI.visible === true) setPanelVisible(true);
  resumeIfRunning();
})();
