// ==UserScript==
// @name         MetaBlooms Browser Agent (MBA) v0.1 — Canonical MVP (Full Re-Emit, Hardened Capture)
// @namespace    metablooms.browser.agent
// @version      0.1.8+fullreemit5
// @description  Governance-grade Browser Agent. Reveal → Plan → Execute → Verify → Export. Auto-resume across SPA navigation. Ledgered. Lazy-loaded message hydration + stable text gating enforced. Console-controlled. Includes getTurns() + repairTurns() (explicit).
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_download
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";

  /* ===================== CONSTANTS ===================== */

  const MBA_VERSION = "0.1.8+fullreemit5";

  const PHASES = {
    REVEAL: "REVEAL",
    PLAN: "PLAN",
    EXECUTE: "EXECUTE",
    VERIFY: "VERIFY",
    EXPORT: "EXPORT"
  };

  const STORAGE = {
    LEDGER: "mba_ledger_v1",
    DISCOVERY: "mba_discovery_v1",
    PLAN: "mba_plan_v1",
    RUNSTATE: "mba_runstate_v1",
    TURNS: "mba_turns_v1",
    REVEAL_LOCK: "mba_reveal_lock_v1"
  };

  const CFG = {
    hydrate: {
      waitRoleNodesMs: 8000,
      scrollPasses: 40,
      scrollPauseMs: 500
    },
    capture: {
      // Stable-text ladder to avoid empty assistant captures
      stableTextMaxAttempts: 16,
      stableTextPollMs: 350,
      stableTextRequireSameTwice: true
    }
  };

  /* ===================== UTILITIES ===================== */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  async function kvGet(key, fallback) {
    const v = await GM_getValue(key);
    if (v === undefined || v === null) return fallback;
    try { return JSON.parse(v); } catch { return fallback; }
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

  function isConversationUrl(u) {
    return /\/c\/[a-zA-Z0-9_-]+/.test(u || "");
  }

  function normalizeUrl(href) {
    if (!href) return null;
    if (href.startsWith("http")) return href;
    return location.origin + href;
  }

  function extractConversationId(url = location.pathname) {
    const m = String(url).match(/\/c\/([^\/\?]+)/);
    return m ? m[1] : null;
  }

  function safeFilename(s) {
    return String(s || "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
  }

  function cleanText(s) {
    return String(s || "").replace(/\r/g, "").trim();
  }

  /* ===================== LEDGER ===================== */

  async function ledgerInit() {
    const existing = await kvGet(STORAGE.LEDGER, null);
    if (existing) return existing;

    const ledger = {
      schema: "mba.ledger.v1",
      run_id: `mba-run-${nowIso().replace(/[:.]/g, "-")}`,
      events: []
    };
    await kvSet(STORAGE.LEDGER, ledger);
    return ledger;
  }

  async function ledgerAppend(evt) {
    const ledger = await kvGet(STORAGE.LEDGER, null);
    if (!ledger) throw new Error("LEDGER_MISSING");
    ledger.events.push(evt);
    await kvSet(STORAGE.LEDGER, ledger);
  }

  /* ===================== PHASE ===================== */

  async function setPhase(phase) {
    const rs = await kvGet(STORAGE.RUNSTATE, {});
    rs.phase = phase;
    await kvSet(STORAGE.RUNSTATE, rs);
    await ledgerAppend({ t: nowIso(), phase, type: "PHASE_ENTER" });
  }

  async function getPhase() {
    const rs = await kvGet(STORAGE.RUNSTATE, null);
    return rs ? rs.phase : null;
  }

  /* ===================== STATUS ===================== */

  async function status() {
    const rs = await kvGet(STORAGE.RUNSTATE, {});
    const plan = await kvGet(STORAGE.PLAN, null);
    const turns = await kvGet(STORAGE.TURNS, []);
    const ledger = await kvGet(STORAGE.LEDGER, null);

    const batchLen = plan && Array.isArray(plan.batch) ? plan.batch.length : 0;
    const idx = rs && rs.exec ? Number(rs.exec.idx || 0) : 0;
    const running = rs && rs.exec ? !!rs.exec.running : false;
    const phase = rs && rs.phase ? rs.phase : null;

    const lastEvent = ledger && ledger.events && ledger.events.length
      ? ledger.events[ledger.events.length - 1]
      : null;

    return {
      ok: true,
      mba_version: MBA_VERSION,
      phase,
      exec: { running, idx, batchLen },
      turns: { count: Array.isArray(turns) ? turns.length : 0 },
      lastEvent
    };
  }

  /* ===================== REVEAL ===================== */

  async function reveal() {
    await setPhase(PHASES.REVEAL);

    const lock = await kvGet(STORAGE.REVEAL_LOCK, { running: false });
    if (lock.running) return { ok: false, reason: "REVEAL_ALREADY_RUNNING" };
    await kvSet(STORAGE.REVEAL_LOCK, { running: true });

    try {
      const discovered = await kvGet(STORAGE.DISCOVERY, {
        schema: "mba.discovery.v1",
        conversation_urls: []
      });

      function collect() {
        return uniq(
          Array.from(document.querySelectorAll('a[href^="/c/"], a[href*="/c/"]'))
            .map(a => normalizeUrl(a.getAttribute("href")))
            .filter(Boolean)
            .filter(isConversationUrl)
        );
      }

      let visible = collect();

      const scroller = document.querySelector("nav") || document.querySelector("aside");
      if (scroller && scroller.scrollHeight > scroller.clientHeight) {
        let stalls = 0;
        let lastH = scroller.scrollHeight;

        for (let i = 0; i < 200; i++) {
          scroller.scrollTop += Math.floor(scroller.clientHeight * 0.6);
          await sleep(900);

          visible = uniq(visible.concat(collect()));

          if (scroller.scrollHeight === lastH) stalls++;
          else stalls = 0;

          lastH = scroller.scrollHeight;
          if (stalls > 10) break;
        }
      }

      const merged = uniq(discovered.conversation_urls.concat(visible));
      discovered.conversation_urls = merged;
      await kvSet(STORAGE.DISCOVERY, discovered);

      await ledgerAppend({
        t: nowIso(),
        phase: PHASES.REVEAL,
        type: "DISCOVERY_MERGE",
        visible: visible.length,
        total: merged.length
      });

      return { ok: true, visibleUnique: visible.length, total: merged.length };
    } finally {
      await kvSet(STORAGE.REVEAL_LOCK, { running: false });
    }
  }

  /* ===================== PLAN ===================== */

  async function plan(batchSize = 5) {
    if ((await getPhase()) !== PHASES.REVEAL) throw new Error("PLAN_REQUIRES_REVEAL");
    await setPhase(PHASES.PLAN);

    const d = await kvGet(STORAGE.DISCOVERY, null);
    if (!d || !d.conversation_urls.length) throw new Error("NO_DISCOVERY");

    const batch = d.conversation_urls.slice(0, batchSize);
    await kvSet(STORAGE.PLAN, { schema: "mba.plan.v1", batch, frozen_at: nowIso() });

    await kvSet(STORAGE.RUNSTATE, { phase: PHASES.PLAN, exec: { running: false, idx: 0 } });

    await ledgerAppend({ t: nowIso(), phase: PHASES.PLAN, type: "PLAN_FROZEN", batch_size: batch.length });
    return { ok: true, batch_size: batch.length };
  }

  /* ===================== HYDRATION HELPERS ===================== */

  async function waitForRoleNodes(timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const n = document.querySelectorAll('[data-message-author-role]').length;
      if (n >= 2) return n;
      await sleep(250);
    }
    return 0;
  }

  async function scrollUpToLoadHistory() {
    const scroller = document.querySelector("main") || document.scrollingElement || document.documentElement;
    for (let i = 0; i < CFG.hydrate.scrollPasses; i++) {
      try { scroller.scrollTop = 0; } catch (_) {}
      try { window.scrollTo(0, 0); } catch (_) {}
      await sleep(CFG.hydrate.scrollPauseMs);
      if (document.querySelectorAll('[data-message-author-role]').length >= 2) return true;
    }
    return false;
  }

  function getLastAssistantNode() {
    const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
    return nodes && nodes.length ? nodes[nodes.length - 1] : null;
  }

  async function waitForNonEmptyAssistantText() {
    // Returns { ok, text, attempts, note }
    let last = null;
    let sameCount = 0;

    for (let i = 0; i < CFG.capture.stableTextMaxAttempts; i++) {
      const node = getLastAssistantNode();
      const raw = node ? (node.innerText || node.textContent || "") : "";
      const txt = cleanText(raw);

      if (txt) {
        if (CFG.capture.stableTextRequireSameTwice) {
          if (last === txt) sameCount++;
          else sameCount = 0;

          last = txt;

          if (sameCount >= 1) {
            return { ok: true, text: txt, attempts: i + 1, note: "stable_twice" };
          }
        } else {
          return { ok: true, text: txt, attempts: i + 1, note: "nonempty_once" };
        }
      }

      await sleep(CFG.capture.stableTextPollMs);
    }

    return { ok: false, text: "", attempts: CFG.capture.stableTextMaxAttempts, note: "never_stabilized_nonempty" };
  }

  /* ===================== EXECUTE ===================== */

  async function execute() {
    await setPhase(PHASES.EXECUTE);

    const rs = await kvGet(STORAGE.RUNSTATE, {});
    rs.phase = PHASES.EXECUTE;
    rs.exec = rs.exec || { running: true, idx: 0 };
    rs.exec.running = true;
    await kvSet(STORAGE.RUNSTATE, rs);

    await ledgerAppend({ t: nowIso(), phase: PHASES.EXECUTE, type: "EXECUTE_STARTED" });

    return executeTick();
  }

  async function executeTick() {
    const planObj = await kvGet(STORAGE.PLAN, null);
    const rs = await kvGet(STORAGE.RUNSTATE, {});
    if (!planObj || !Array.isArray(planObj.batch)) throw new Error("PLAN_MISSING");
    if (!rs.exec || !rs.exec.running) return;

    const idx = Number(rs.exec.idx || 0);

    if (idx >= planObj.batch.length) {
      rs.exec.running = false;
      rs.phase = PHASES.EXECUTE;
      await kvSet(STORAGE.RUNSTATE, rs);
      await ledgerAppend({ t: nowIso(), phase: PHASES.EXECUTE, type: "EXECUTE_COMPLETE", processed: planObj.batch.length });
      return;
    }

    const target = planObj.batch[idx];
    const currentCid = extractConversationId(location.href);
    const wantCid = extractConversationId(target);

    if (!currentCid || currentCid !== wantCid) {
      await ledgerAppend({ t: nowIso(), phase: PHASES.EXECUTE, type: "NAVIGATE", idx, url: target });
      location.href = target;
      return;
    }

    // We are at target conversation.
    await sleep(2000);

    await ledgerAppend({ t: nowIso(), phase: PHASES.EXECUTE, type: "HISTORY_LOAD_BEGIN", idx, conversation_id: currentCid });

    let roles = await waitForRoleNodes(CFG.hydrate.waitRoleNodesMs);
    if (roles < 2) {
      await scrollUpToLoadHistory();
      roles = document.querySelectorAll('[data-message-author-role]').length;
    }

    await ledgerAppend({ t: nowIso(), phase: PHASES.EXECUTE, type: "HISTORY_LOAD_END", idx, conversation_id: currentCid, role_nodes: roles });

    const lastNode = getLastAssistantNode();
    if (!lastNode) {
      await ledgerAppend({ t: nowIso(), phase: PHASES.EXECUTE, type: "FAIL_NO_ASSISTANT_NODES", idx, conversation_id: currentCid });
      throw new Error("FAIL_CLOSED_NO_ASSISTANT_NODES");
    }

    // NEW: stable non-empty text gating
    await ledgerAppend({ t: nowIso(), phase: PHASES.EXECUTE, type: "CAPTURE_TEXT_BEGIN", idx, conversation_id: currentCid });
    const stable = await waitForNonEmptyAssistantText();
    await ledgerAppend({
      t: nowIso(),
      phase: PHASES.EXECUTE,
      type: "CAPTURE_TEXT_END",
      idx,
      conversation_id: currentCid,
      ok: stable.ok,
      attempts: stable.attempts,
      note: stable.note,
      response_len: stable.text.length
    });

    if (!stable.ok) {
      // FAIL-CLOSED: do not persist an empty record
      throw new Error("FAIL_CLOSED_STABLE_TEXT_NOT_FOUND");
    }

    const turns = await kvGet(STORAGE.TURNS, []);
    turns.push({
      schema: "mba.turn.v1",
      conversation_id: currentCid,
      response: stable.text,
      response_len: stable.text.length,
      captured_at: nowIso()
    });
    await kvSet(STORAGE.TURNS, turns);

    await ledgerAppend({
      t: nowIso(),
      phase: PHASES.EXECUTE,
      type: "TURN_CAPTURED",
      idx,
      conversation_id: currentCid,
      response_len: stable.text.length
    });

    // Advance and navigate
    rs.exec.idx = idx + 1;
    rs.phase = PHASES.EXECUTE;
    await kvSet(STORAGE.RUNSTATE, rs);

    if (rs.exec.idx < planObj.batch.length) {
      const nextUrl = planObj.batch[rs.exec.idx];
      await ledgerAppend({ t: nowIso(), phase: PHASES.EXECUTE, type: "NAVIGATE", idx: rs.exec.idx, url: nextUrl });
      location.href = nextUrl;
      return;
    }

    rs.exec.running = false;
    await kvSet(STORAGE.RUNSTATE, rs);
    await ledgerAppend({ t: nowIso(), phase: PHASES.EXECUTE, type: "EXECUTE_COMPLETE", processed: planObj.batch.length });
  }

  async function executeFinalizeIfDone() {
    const rs = await kvGet(STORAGE.RUNSTATE, {});
    if (rs.exec && rs.exec.running === false) {
      if (rs.phase !== PHASES.EXECUTE && rs.phase !== PHASES.VERIFY && rs.phase !== PHASES.EXPORT) {
        rs.phase = PHASES.EXECUTE;
        await kvSet(STORAGE.RUNSTATE, rs);
      }
    }
  }

  /* ===================== VERIFY ===================== */

  function validateTurnsArray(turns) {
    const bad = [];
    const arr = Array.isArray(turns) ? turns : [];

    for (let i = 0; i < arr.length; i++) {
      const t = arr[i];
      const conv = t && t.conversation_id ? String(t.conversation_id) : "";
      const resp = t && t.response ? String(t.response) : "";

      if (!t || typeof t !== "object") {
        bad.push({ i, reason: "TURN_NOT_OBJECT", conversation_id: null, response_len: 0 });
        continue;
      }
      if (!conv) {
        bad.push({ i, reason: "MISSING_CONVERSATION_ID", conversation_id: null, response_len: cleanText(resp).length });
      }
      if (!cleanText(resp)) {
        bad.push({ i, reason: "MISSING_RESPONSE_TEXT", conversation_id: conv || null, response_len: cleanText(resp).length });
      }
    }

    return { ok: bad.length === 0, bad, total: arr.length };
  }

  async function verifyReport() {
    const rs = await kvGet(STORAGE.RUNSTATE, {});
    const turns = await kvGet(STORAGE.TURNS, []);

    const hasExec = !!(rs && rs.exec);
    const running = !!(rs && rs.exec && rs.exec.running);

    const report = validateTurnsArray(turns);

    return {
      ok: true,
      admissibility: {
        hasExec,
        execRunning: running,
        turnsCount: report.total
      },
      validation: report
    };
  }

  async function verify() {
    const rs = await kvGet(STORAGE.RUNSTATE, {});
    const turns = await kvGet(STORAGE.TURNS, []);

    const hasExec = !!(rs && rs.exec);
    const running = !!(rs && rs.exec && rs.exec.running);

    if (!hasExec) throw new Error("VERIFY_REQUIRES_EXEC_STATE");
    if (running) throw new Error("VERIFY_BLOCKED_EXECUTE_STILL_RUNNING");

    const report = validateTurnsArray(turns);
    if (!report.total) throw new Error("VERIFY_REQUIRES_TURNS");

    await setPhase(PHASES.VERIFY);

    if (!report.ok) {
      await ledgerAppend({
        t: nowIso(),
        phase: PHASES.VERIFY,
        type: "VERIFY_FAIL_DETAIL",
        total_turns: report.total,
        bad_count: report.bad.length,
        bad: report.bad
      });
      throw new Error("VERIFY_FAIL");
    }

    await ledgerAppend({ t: nowIso(), phase: PHASES.VERIFY, type: "VERIFY_OK", count: report.total });
    return { ok: true, verified: report.total };
  }

  /* ===================== TURNS ACCESS / REPAIR ===================== */

  async function getTurns() {
    const turns = await kvGet(STORAGE.TURNS, []);
    return { ok: true, turns };
  }

  async function repairTurns(options = {}) {
    // Explicit only. Default dry-run.
    const dryRun = options.dryRun !== false;
    const mode = options.mode || "drop_invalid";

    if (mode !== "drop_invalid") throw new Error("REPAIR_UNSUPPORTED_MODE");

    const turns = await kvGet(STORAGE.TURNS, []);
    const report = validateTurnsArray(turns);

    const plan = {
      ok: true,
      mode,
      dryRun,
      total_before: report.total,
      bad_count: report.bad.length,
      bad: report.bad
    };

    await ledgerAppend({
      t: nowIso(),
      phase: await getPhase(),
      type: "REPAIR_PLAN",
      mode,
      dryRun,
      total_before: report.total,
      bad_count: report.bad.length
    });

    if (dryRun) return plan;

    const badIdx = new Set(report.bad.map(x => x.i));
    const filtered = turns.filter((_, i) => !badIdx.has(i));

    await kvSet(STORAGE.TURNS, filtered);

    await ledgerAppend({
      t: nowIso(),
      phase: await getPhase(),
      type: "REPAIR_APPLIED",
      mode,
      removed: report.bad.length,
      total_after: filtered.length
    });

    return Object.assign(plan, { applied: true, total_after: filtered.length });
  }

  /* ===================== OPTIONAL: RECAPTURE PLAN ===================== */

  async function reCaptureBadPlan() {
    const rep = await verifyReport();
    const bad = rep.validation.bad || [];
    return {
      ok: true,
      note: "This is a plan only. To re-capture these, run a new Plan using these conversation_ids as targets.",
      bad
    };
  }

  /* ===================== EXPORT ===================== */

  async function exportArtifacts() {
    if ((await getPhase()) !== PHASES.VERIFY) throw new Error("EXPORT_REQUIRES_VERIFY");
    await setPhase(PHASES.EXPORT);

    const ledger = await kvGet(STORAGE.LEDGER, null);
    const turns = await kvGet(STORAGE.TURNS, []);
    const payload = { ledger, turns, mba_version: MBA_VERSION };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    GM_download({ url, name: safeFilename(`mba_export_${ledger.run_id}.json`), saveAs: true });
    await ledgerAppend({ t: nowIso(), phase: PHASES.EXPORT, type: "EXPORT_COMPLETE" });
  }

  /* ===================== ADMIN ===================== */

  async function exportLedger() {
    const ledger = await kvGet(STORAGE.LEDGER, null);
    if (!ledger) throw new Error("LEDGER_MISSING");
    const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    GM_download({ url, name: safeFilename(`mba_ledger_${ledger.run_id}.json`), saveAs: true });
    return { ok: true };
  }

  async function clearAll() {
    await kvDel(STORAGE.LEDGER);
    await kvDel(STORAGE.DISCOVERY);
    await kvDel(STORAGE.PLAN);
    await kvDel(STORAGE.RUNSTATE);
    await kvDel(STORAGE.TURNS);
    await kvDel(STORAGE.REVEAL_LOCK);
    return { ok: true };
  }

  /* ===================== EXPOSE ===================== */

  const api = {
    reveal,
    plan,
    execute,
    verify,
    verifyReport,
    getTurns,
    repairTurns,
    reCaptureBadPlan,
    export: exportArtifacts,
    exportLedger,
    status,
    clearAll
  };

  try { unsafeWindow.MBA = api; } catch (_) {}
  try { window.MBA = api; } catch (_) {}

  try { console.log("[MBA] injected", location.href, "version", MBA_VERSION); } catch (_) {}

  /* ===================== BOOTSTRAP ===================== */

  (async () => {
    await ledgerInit();
    await executeFinalizeIfDone();

    const rs = await kvGet(STORAGE.RUNSTATE, {});
    if (rs.phase === PHASES.EXECUTE && rs.exec && rs.exec.running) {
      try {
        await executeTick();
      } catch (e) {
        try { console.warn("[MBA] executeTick fail-closed:", e); } catch (_) {}
      }
    }
  })();

})();
