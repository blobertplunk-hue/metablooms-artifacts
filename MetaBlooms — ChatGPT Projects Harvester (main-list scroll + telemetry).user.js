// ==UserScript==
// @name         MetaBlooms — ChatGPT Projects Harvester (main-list scroll + telemetry)
// @namespace    metablooms
// @version      0.4.1
// @description  Harvest chats from ChatGPT Projects main screen list (not sidebar); hydrate transcripts; export JSON/MD + index + telemetry.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// ==/UserScript==

(() => {
  'use strict';

  const STORE_KEY = 'MB_PROJ_HARVESTER_STATE_V2';
  const DEFAULTS = {
    maxChatsPerRun: 200,
    minDelayMs: 900,
    listStabilityCycles: 6,
    listScrollStepPx: 1200,
    listMaxScrolls: 240,
    hydrateStabilityMs: 1100,
    hydrateMaxTopScrolls: 140,
    emitMarkdown: true,
    emitRawHtml: false,
    stopOnFailure: false,
    filenamePrefix: 'mb_project',
    debugVerbose: false,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();
  const safeJson = (obj) => JSON.stringify(obj, null, 2);

  function asFilename(s) {
    return String(s || 'chat')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .slice(0, 180);
  }

  async function sha256Hex(text) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  function downloadText(filename, text, mime='application/json') {
    const blob = new Blob([text], {type: mime});
    const url = URL.createObjectURL(blob);
    GM_download({
      url,
      name: filename,
      saveAs: false,
      onload: () => URL.revokeObjectURL(url),
      onerror: () => URL.revokeObjectURL(url),
      ontimeout: () => URL.revokeObjectURL(url),
    });
  }

  function freshState() {
    return {
      cfg: {...DEFAULTS},
      running: false,
      stopRequested: false,
      queue: [],
      cursor: 0,
      harvested: {},
      failures: [],
      telemetry: [],
      lastError: null,
      runId: null,
    };
  }

  function loadState() {
    try {
      const raw = GM_getValue(STORE_KEY, null);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      obj.cfg = {...DEFAULTS, ...(obj.cfg || {})};
      return obj;
    } catch {
      return null;
    }
  }

  let state = loadState() || freshState();

  function persist() { GM_setValue(STORE_KEY, JSON.stringify(state)); }
  function hardReset() { GM_deleteValue(STORE_KEY); state = freshState(); persist(); }

  const ui = {
    el: null,
    statusEl: null,
    errEl: null,
    teleEl: null,
    setStatus: (s) => { if (ui.statusEl) ui.statusEl.textContent = s; },
    setError: (s) => { if (ui.errEl) ui.errEl.textContent = s || '—'; },
    renderTelemetryLine: (line) => {
      if (!ui.teleEl) return;
      const div = document.createElement('div');
      div.textContent = `${line.ts}  ${line.kind}  ${line.message || ''}`.trim();
      ui.teleEl.prepend(div);
      while (ui.teleEl.childNodes.length > 30) ui.teleEl.removeChild(ui.teleEl.lastChild);
    }
  };

  function tlog(kind, data={}) {
    const line = {ts: nowIso(), kind, ...data};
    state.telemetry.push(line);
    if (state.telemetry.length > 2500) state.telemetry.shift();
    if (state.cfg.debugVerbose) console.debug('[MBX]', line);
    persist();
    ui.renderTelemetryLine(line);
  }

  window.addEventListener('error', (ev) => {
    const msg = String(ev?.message || 'window.error');
    state.lastError = msg;
    tlog('window_error', {message: msg, filename: ev?.filename, lineno: ev?.lineno, colno: ev?.colno});
    ui.setStatus(`ERROR: ${msg}`);
    ui.setError(msg);
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const msg = String(ev?.reason?.message || ev?.reason || 'unhandledrejection');
    state.lastError = msg;
    tlog('unhandled_rejection', {message: msg});
    ui.setStatus(`ERROR: ${msg}`);
    ui.setError(msg);
  });

  GM_addStyle(`
    #mbx-proj {
      position: fixed; z-index: 999999; right: 12px; bottom: 12px;
      width: 410px; background: rgba(20,20,20,0.93); color: #eee;
      border: 1px solid rgba(255,255,255,0.18); border-radius: 12px;
      padding: 12px; font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    }
    #mbx-proj h3 { margin: 0 0 8px; font-size: 13px; font-weight: 700; }
    #mbx-proj .row { display: flex; gap: 8px; margin: 6px 0; }
    #mbx-proj label { display: block; opacity: 0.9; margin-bottom: 2px; }
    #mbx-proj input, #mbx-proj select {
      width: 100%; background: rgba(255,255,255,0.08); color: #eee;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
      padding: 6px 8px; outline: none;
    }
    #mbx-proj button {
      background: rgba(255,255,255,0.10); color: #eee; border: 1px solid rgba(255,255,255,0.14);
      border-radius: 10px; padding: 8px 10px; cursor: pointer; font-weight: 700;
    }
    #mbx-proj button:hover { background: rgba(255,255,255,0.16); }
    #mbx-proj .telemetry {
      margin-top: 8px; max-height: 240px; overflow: auto;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
      padding: 8px; background: rgba(0,0,0,0.25);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 10px;
    }
    #mbx-proj .errbox {
      margin-top: 6px; padding: 8px; border-radius: 10px;
      border: 1px solid rgba(255,120,120,0.25); background: rgba(255,60,60,0.10);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 10px;
      max-height: 80px; overflow: auto;
    }
  `);

  function buildUI() {
    if (ui.el) return;
    const el = document.createElement('div');
    el.id = 'mbx-proj';
    el.innerHTML = `
      <h3>MetaBlooms Projects Harvester</h3>

      <div class="row">
        <div style="flex:1">
          <label>Max chats/run</label>
          <input id="mbx-max" type="number" min="1" max="1000">
        </div>
        <div style="flex:1">
          <label>Min delay (ms)</label>
          <input id="mbx-delay" type="number" min="200" max="20000">
        </div>
      </div>

      <div class="row">
        <div style="flex:1">
          <label>Emit Markdown</label>
          <select id="mbx-md">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
        <div style="flex:1">
          <label>Stop on failure</label>
          <select id="mbx-stopfail">
            <option value="false">false</option>
            <option value="true">true</option>
          </select>
        </div>
      </div>

      <div class="row">
        <button id="mbx-start" style="flex:1">START / RESUME</button>
        <button id="mbx-stop" style="flex:1">STOP</button>
        <button id="mbx-export" style="flex:1">EXPORT TELEMETRY</button>
      </div>

      <div class="row">
        <button id="mbx-probe" style="flex:1">EXPORT DOM PROBE</button>
        <button id="mbx-index" style="flex:1">EXPORT INDEX</button>
        <button id="mbx-reset" style="flex:1">RESET</button>
      </div>

      <div class="status"><b>Status:</b> <span id="mbx-status">—</span></div>
      <div class="small">Discovery reads the MAIN Projects chat list (center pane). Open a Project and run START.</div>

      <div><b>Last error:</b></div>
      <div class="errbox" id="mbx-err">—</div>

      <div><b>Telemetry (latest first)</b></div>
      <div class="telemetry" id="mbx-tele"></div>
    `;
    document.body.appendChild(el);
    ui.el = el;
    ui.statusEl = el.querySelector('#mbx-status');
    ui.errEl = el.querySelector('#mbx-err');
    ui.teleEl = el.querySelector('#mbx-tele');

    el.querySelector('#mbx-max').value = String(state.cfg.maxChatsPerRun);
    el.querySelector('#mbx-delay').value = String(state.cfg.minDelayMs);
    el.querySelector('#mbx-md').value = String(state.cfg.emitMarkdown);
    el.querySelector('#mbx-stopfail').value = String(state.cfg.stopOnFailure);

    const syncCfg = () => {
      state.cfg.maxChatsPerRun = Number(el.querySelector('#mbx-max').value || DEFAULTS.maxChatsPerRun);
      state.cfg.minDelayMs = Number(el.querySelector('#mbx-delay').value || DEFAULTS.minDelayMs);
      state.cfg.emitMarkdown = el.querySelector('#mbx-md').value === 'true';
      state.cfg.stopOnFailure = el.querySelector('#mbx-stopfail').value === 'true';
      persist();
    };

    el.querySelector('#mbx-start').addEventListener('click', async () => {
      syncCfg();
      state.stopRequested = false;
      persist();
      await orchestrate();
    });

    el.querySelector('#mbx-stop').addEventListener('click', () => {
      state.stopRequested = true;
      persist();
      ui.setStatus('Stop requested…');
      tlog('stop_requested');
    });

    el.querySelector('#mbx-export').addEventListener('click', async () => exportTelemetry());
    el.querySelector('#mbx-probe').addEventListener('click', () => exportDomProbe());
    el.querySelector('#mbx-index').addEventListener('click', () => exportIndex());
    el.querySelector('#mbx-reset').addEventListener('click', () => { hardReset(); ui.setStatus('Reset complete'); ui.setError('—'); });

    ui.setStatus(state.running ? 'RUNNING (resumable)' : 'Ready');
    ui.setError(state.lastError || '—');
    (state.telemetry || []).slice(-12).reverse().forEach(l => ui.renderTelemetryLine(l));
  }

  GM_registerMenuCommand('MetaBlooms: START / RESUME', () => orchestrate());
  GM_registerMenuCommand('MetaBlooms: STOP', () => { state.stopRequested = true; persist(); });
  GM_registerMenuCommand('MetaBlooms: EXPORT TELEMETRY', () => exportTelemetry());
  GM_registerMenuCommand('MetaBlooms: EXPORT DOM PROBE', () => exportDomProbe());
  GM_registerMenuCommand('MetaBlooms: EXPORT INDEX', () => exportIndex());
  GM_registerMenuCommand('MetaBlooms: RESET STATE', () => hardReset());

  function getMain() {
    return document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
  }

  function isScrollable(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 20;
  }

  function nearestScrollableAncestor(el, stopAt) {
    let cur = el;
    while (cur && cur !== document.body && cur !== stopAt) {
      if (isScrollable(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function findProjectChatAnchors(root=getMain()) {
    const anchors = Array.from(root.querySelectorAll('a[href]'));
    const abs = anchors.map(a => {
      const href = a.getAttribute('href');
      if (!href) return null;
      try { return new URL(href, location.origin).toString(); } catch { return null; }
    }).filter(Boolean);
    const chatUrls = abs.filter(u => /\/c\/|\/chat\/|\/g\//.test(u));
    return {chatUrls};
  }

  function findProjectListScrollContainer() {
    const main = getMain();
    const allA = Array.from(main.querySelectorAll('a[href]'));
    const candidates = allA.filter(a => {
      const href = a.getAttribute('href') || '';
      return href.includes('/c/') || href.includes('/chat/') || href.includes('/g/');
    });

    if (candidates.length) {
      const counts = new Map();
      for (const a of candidates.slice(0, 80)) {
        const sc = nearestScrollableAncestor(a, main);
        if (!sc) continue;
        counts.set(sc, (counts.get(sc) || 0) + 1);
      }
      let best = null, bestN = 0;
      for (const [k,v] of counts.entries()) {
        if (v > bestN) { best = k; bestN = v; }
      }
      if (best) return best;
    }

    const all = Array.from(main.querySelectorAll('*')).filter(isScrollable);
    all.sort((a,b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return all[0] || null;
  }

  async function stabilizeProjectList(scroller) {
    let stable = 0;
    let lastH = -1;

    for (let i=0; i<state.cfg.listMaxScrolls; i++) {
      if (state.stopRequested) throw new Error('stop_requested');

      scroller.scrollTop = Math.min(scroller.scrollTop + state.cfg.listScrollStepPx, scroller.scrollHeight);
      await sleep(350);

      const h = scroller.scrollHeight;
      if (h === lastH) stable++; else stable = 0;
      lastH = h;

      const { chatUrls } = findProjectChatAnchors(getMain());
      tlog('list_scan', {i, stable, scrollHeight: h, chatUrlCount: chatUrls.length});

      if (stable >= state.cfg.listStabilityCycles) {
        tlog('list_stable', {cycles: stable, scrollHeight: h});
        return;
      }
    }
    throw new Error('list_stability_timeout');
  }

  function findChatScrollContainer() {
    const main = getMain();
    const sc = Array.from(main.querySelectorAll('*')).find(isScrollable);
    return sc || document.scrollingElement || document.documentElement;
  }

  function findMessageNodes() {
    const main = getMain();
    let nodes = Array.from(main.querySelectorAll('article[data-message-author-role], div[data-message-author-role]'));
    if (!nodes.length) nodes = Array.from(main.querySelectorAll('article, div[data-testid*="conversation-turn"]'));
    return nodes;
  }

  function inferRole(node) {
    return node.getAttribute('data-message-author-role') || node.getAttribute('data-message-role') || 'unknown';
  }

  async function waitForQuiescence(target, quietMs) {
    return await new Promise((resolve) => {
      let timer = null;
      const obs = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { obs.disconnect(); resolve(true); }, quietMs);
      });
      obs.observe(target, {childList: true, subtree: true});
      timer = setTimeout(() => { obs.disconnect(); resolve(false); }, quietMs);
    });
  }

  async function hydrateTranscript() {
    const main = getMain();
    const sc = findChatScrollContainer();
    if (!sc) throw new Error('chat_scroll_container_not_found');

    let stable = 0;
    let lastCount = -1;

    for (let i=0; i<state.cfg.hydrateMaxTopScrolls; i++) {
      if (state.stopRequested) throw new Error('stop_requested');
      sc.scrollTop = 0;
      await waitForQuiescence(main, state.cfg.hydrateStabilityMs);
      const count = findMessageNodes().length;
      if (count === lastCount) stable++; else stable = 0;
      lastCount = count;
      tlog('hydrate_scan', {i, count, stable});
      if (stable >= 3) break;
      await sleep(120);
    }

    sc.scrollTop = sc.scrollHeight;
    await sleep(200);
    tlog('hydrate_done', {messageCount: findMessageNodes().length});
  }

  function extractOne(node) {
    const role = inferRole(node);
    const text = (node.textContent || '').trim();

    const codeBlocks = Array.from(node.querySelectorAll('pre code')).map(c => ({
      lang: c.className || null,
      text: (c.textContent || '').replace(/\s+$/g,'')
    }));

    const links = Array.from(node.querySelectorAll('a[href]')).map(a => ({
      href: a.getAttribute('href'),
      text: (a.textContent || '').trim()
    }));

    return {role, text, codeBlocks, links};
  }

  function findChatTitle() {
    const main = getMain();
    const h = main.querySelector('h1, header h1, header h2');
    if (h && h.textContent.trim()) return h.textContent.trim();
    return (document.title || 'chat').replace(' - ChatGPT','').trim();
  }

  function extractTranscript() {
    const nodes = findMessageNodes();
    const messages = nodes.map(extractOne);
    return { url: location.href, title: findChatTitle(), extracted_at: nowIso(), message_count: messages.length, messages };
  }

  function renderMarkdown(t) {
    const out = [];
    out.push(`# ${t.title}`);
    out.push('');
    out.push(`Source: ${t.url}`);
    out.push(`Extracted: ${t.extracted_at}`);
    out.push('');
    t.messages.forEach((m,i) => {
      out.push(`## ${i+1}. ${String(m.role).toUpperCase()}`);
      out.push('');
      out.push(m.text || '');
      out.push('');
      for (const cb of (m.codeBlocks || [])) {
        out.push('```' + (cb.lang || ''));
        out.push(cb.text || '');
        out.push('```');
        out.push('');
      }
    });
    return out.join('\n');
  }

  async function exportTelemetry() {
    const ndjson = (state.telemetry || []).map(l => JSON.stringify(l)).join('\n') + '\n';
    downloadText(`${state.cfg.filenamePrefix}__telemetry.ndjson`, ndjson, 'application/x-ndjson');
    ui.setStatus('Telemetry exported');
    tlog('telemetry_export');
  }

  function exportIndex() {
    const index = {
      schema: 'MB_PROJECT_INDEX_V2',
      run_id: state.runId,
      origin: location.origin,
      exported_at: nowIso(),
      harvested: Object.values(state.harvested),
      failures: state.failures,
      cfg: state.cfg,
    };
    downloadText(`${state.cfg.filenamePrefix}__index.json`, safeJson(index), 'application/json');
    ui.setStatus('Index exported');
    tlog('index_export', {harvested: Object.keys(state.harvested).length, failures: state.failures.length});
  }

  function exportDomProbe() {
    const main = getMain();
    const scroller = findProjectListScrollContainer();
    const { chatUrls } = findProjectChatAnchors(main);

    const probe = {
      schema: 'MB_DOM_PROBE_V1',
      at: nowIso(),
      url: location.href,
      title: document.title,
      main: { tag: main.tagName, id: main.id || null, class: main.className || null },
      scroller: scroller ? {
        tag: scroller.tagName,
        id: scroller.id || null,
        class: scroller.className || null,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        overflowY: window.getComputedStyle(scroller).overflowY,
      } : null,
      chatUrlCount: chatUrls.length,
      sampleChatUrls: chatUrls.slice(0, 25),
    };

    downloadText(`${state.cfg.filenamePrefix}__dom_probe.json`, safeJson(probe), 'application/json');
    ui.setStatus('DOM probe exported');
    tlog('dom_probe_export', {chatUrlCount: chatUrls.length});
  }

  function isChatUrl(u) { return /\/c\/|\/chat\/|\/g\//.test(u); }

  async function discoverQueueFromMain() {
    const scroller = findProjectListScrollContainer();
    if (!scroller) throw new Error('project_list_scroller_not_found');

    tlog('discover_scroller', {
      tag: scroller.tagName,
      id: scroller.id || null,
      class: scroller.className || null,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      overflowY: window.getComputedStyle(scroller).overflowY,
    });

    await stabilizeProjectList(scroller);

    const { chatUrls } = findProjectChatAnchors(getMain());
    const uniq = Array.from(new Set(chatUrls)).filter(isChatUrl).slice(0, state.cfg.maxChatsPerRun);
    tlog('discover_done', {count: uniq.length});
    return uniq;
  }

  async function harvestCurrentChatUrl() {
    tlog('harvest_begin', {url: location.href});
    await hydrateTranscript();
    const t = extractTranscript();
    const json = safeJson(t);
    const hash = await sha256Hex(json);

    const base = `${state.cfg.filenamePrefix}__${asFilename(t.title)}__${hash.slice(0,12)}`;
    downloadText(`${base}.json`, json, 'application/json');

    if (state.cfg.emitMarkdown) downloadText(`${base}.md`, renderMarkdown(t), 'text/markdown');
    if (state.cfg.emitRawHtml) downloadText(`${base}.raw.html`, getMain().innerHTML || '', 'text/html');

    state.harvested[t.url] = { url: t.url, title: t.title, extracted_at: t.extracted_at, message_count: t.message_count, sha256: hash, file_base: base };
    persist();
    tlog('harvest_ok', {url: t.url, sha256: hash, message_count: t.message_count});
  }

  async function orchestrate() {
    buildUI();
    ui.setError(state.lastError || '—');

    if (!state.running) {
      state.runId = 'run_' + nowIso().replace(/[:.]/g,'_');
      state.running = true;
      state.stopRequested = false;
      state.cursor = 0;
      state.queue = [];
      state.failures = [];
      persist();
      tlog('run_start', {runId: state.runId});
    } else {
      tlog('resume_requested', {cursor: state.cursor, queue: state.queue.length});
    }

    try {
      ui.setStatus('Discovering chats from main Projects list…');
      if (!state.queue.length) state.queue = await discoverQueueFromMain();
      persist();

      ui.setStatus(`Queue: ${state.queue.length} chats. Starting harvest…`);

      if (isChatUrl(location.href) && state.queue.includes(location.href) && !state.harvested[location.href]) {
        await harvestCurrentChatUrl();
        await sleep(state.cfg.minDelayMs);
      }

      for (; state.cursor < state.queue.length; state.cursor++) {
        if (state.stopRequested) throw new Error('stop_requested');

        const url = state.queue[state.cursor];
        if (state.harvested[url]) continue;

        ui.setStatus(`Opening ${state.cursor+1}/${state.queue.length}`);
        tlog('navigate', {to: url, cursor: state.cursor});
        state.lastError = null;
        persist();
        location.href = url; // triggers autoboot resume
        return;
      }

      state.running = false;
      persist();
      ui.setStatus(`DONE. Harvested: ${Object.keys(state.harvested).length}, Failures: ${state.failures.length}`);
      tlog('run_done', {harvested: Object.keys(state.harvested).length, failures: state.failures.length});
      exportIndex();
      await exportTelemetry();
    } catch (e) {
      const msg = String(e?.message || e);
      state.lastError = msg;
      ui.setError(msg);
      ui.setStatus(`FAILED: ${msg}`);
      tlog('run_fail', {error: msg});
      if (state.cfg.stopOnFailure) { state.running = false; persist(); }
    }
  }

  (async () => {
    buildUI();
    if (state.running && !state.stopRequested) {
      ui.setStatus('Autoboot resume detected…');
      tlog('autoboot_resume', {url: location.href, cursor: state.cursor, queue: state.queue.length});
      try {
        if (isChatUrl(location.href) && !state.harvested[location.href]) {
          await harvestCurrentChatUrl();
          await sleep(state.cfg.minDelayMs);
        }
      } catch (e) {
        const msg = String(e?.message || e);
        state.failures.push({ts: nowIso(), url: location.href, error: msg});
        state.lastError = msg;
        persist();
        ui.setError(msg);
        tlog('autoboot_harvest_fail', {url: location.href, error: msg});
        if (state.cfg.stopOnFailure) { state.running = false; persist(); return; }
      }
      await orchestrate();
    } else {
      ui.setStatus('Ready');
    }
  })();

})();
