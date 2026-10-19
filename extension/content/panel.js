// SegDown panel: top frame only. A floating panel in a closed shadow root that
// renders the hub's data (video picker, timeline, marks, options, sources).
// Message protocol: see the hub in background.js.
// Blocks: state, hub messaging, render, mount + drag, persistence, boot.
// 3.6: segment list (the `[` / `]` keys live in agent.js), 3.7 persistence,
// 3.8: hidden while another element is fullscreen; the segments go to the hub
// for the compact fullscreen panel (agent.js).
// Page data (URLs) is untrusted: DOM is built with createElement/textContent only.

"use strict";

(() => {
  if (window !== window.top) return;

  // 3.7 persistence goes through the hub (loadPage / savePage / savePos), which
  // keys the page entry {segments, mode, precision} by the top URL without its
  // hash and keeps it in storage.local; panel:prefs and panel:pos live there too.
  const SAVE_DELAY_MS = 300;
  const MODES = ["separate", "merged"];
  const PRECISIONS = ["precise", "fast"];
  const PANEL_W = 300;
  const TIMELINE_W = 276; // PANEL_W minus padding; fixed so a hidden panel can still size the canvas
  const TIMELINE_H = 32;
  const MARGIN = 8; // min gap between the panel and the viewport edge
  const POLL_MS = 2000; // captures have no push path; refresh them while shown
  const MAX_SOURCES = 20;
  const MAX_SEGMENTS = 100; // SegDownCore Validation
  const EXCLUDED_LABEL = { ad: "ad", small: "small", live: "live" };
  const ERROR_TEXT = {
    "no-selection": "No video selected.",
    "no-video": "The video is gone; pick another one.",
    "agent-unreachable": "Cannot reach the video's frame.",
    "agent-no-reply": "The video's frame did not answer.",
    "unknown-video": "That video is gone.",
    "no-start": "Mark a start first.",
    "end-not-after-start": "The end must be after the start.",
    "selection-changed": "The video changed; mark again.",
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const view = {
    state: null, // hub state {selected, selectedBy, panelOpen, pendingStart}
    candidates: [], // [{frameId, videoKey, area, duration, live, paused, excluded, score, currentSrc?}]
    tick: null, // last tick of the selected video {frameId, videoKey, currentTime, duration, paused}
    captures: null, // {entries: [{url, frameId, kind, isMaster, ts}], active: {<frameId>: {count, ts}}}
    lastMark: null, // last `mark` relay {action, time, start?, frameId, videoKey}
    segments: [], // [{start, end}] sorted by start, at most MAX_SEGMENTS (3.7 persists them)
    segError: null, // {seg, text}: the last rejected edit, shown under that row
    mode: "separate", // "separate" | "merged" (3.7 persists it)
    precision: "precise", // "precise" | "fast" (3.7 persists it)
    error: "", // last failed action, shown in the status line
    pos: null, // {x, y} once loaded or dragged
  };

  const ui = {}; // DOM refs, filled by mount()
  let pollTimer = null;
  let restored = false; // saves wait for the stored entry, or they would overwrite it
  let saveTimer = null;
  let loadGen = 0; // a loadPage reply for an older page (pageChanged) is ignored

  const isShown = () => Boolean(view.state && view.state.panelOpen);

  const selected = () => (view.state && view.state.selected) || null;

  function selectedCandidate() {
    const s = selected();
    return s ? view.candidates.find((c) => c.frameId === s.frameId && c.videoKey === s.videoKey) || null : null;
  }

  function sameVideo(t, s) {
    return Boolean(t && s && t.frameId === s.frameId && t.videoKey === s.videoKey);
  }

  // Duration of the selected video: the live tick first, then its candidate report.
  function currentDuration() {
    const s = selected();
    if (sameVideo(view.tick, s) && view.tick.duration !== null) return view.tick.duration;
    const c = selectedCandidate();
    return c ? c.duration : null;
  }

  function currentTime() {
    return sameVideo(view.tick, selected()) ? view.tick.currentTime : null;
  }

  function setState(state) {
    if (!state || typeof state !== "object") return;
    const prev = selected();
    view.state = state;
    if (!sameVideo(prev, state.selected)) view.error = ""; // errors belong to the old video
    if (!sameVideo(view.tick, state.selected)) view.tick = null; // no stale playhead
  }

  // ---------------------------------------------------------------------------
  // Hub messaging
  // ---------------------------------------------------------------------------

  // Resolves to the hub reply, or {ok: false} once the extension context is gone.
  function ask(msg) {
    try {
      return chrome.runtime.sendMessage(msg).then(
        (r) => r || { ok: false, error: "no-reply" },
        () => ({ ok: false, error: "no-reply" })
      );
    } catch {
      return Promise.resolve({ ok: false, error: "no-reply" });
    }
  }

  function showError(reply) {
    view.error = ERROR_TEXT[reply.error] || `Failed (${String(reply.error || "unknown")}).`;
    renderStatus();
  }

  async function act(msg) {
    const r = await ask(msg);
    if (!r.ok) showError(r);
    else if (view.error) {
      view.error = "";
      renderStatus();
    }
    return r;
  }

  // The compact fullscreen panel (agent.js) draws these; the hub keeps a copy.
  function pushSegments() {
    ask({ type: "segmentsChanged", segments: view.segments.map(({ start, end }) => ({ start, end })) });
  }

  const seek = (time) => act({ type: "seek", time });
  // The result comes back as a `mark` relay (also used by the 3.6 keyboard); the reply only reports errors.
  const mark = (action) => act({ type: "key", action });
  const closePanel = () => act({ type: "setPanelOpen", open: false });

  async function selectVideo(frameId, videoKey) {
    const r = await act({ type: "select", frameId, videoKey });
    if (r.ok) setState(r.state);
    render();
  }

  // full: take everything (first load); otherwise only captures, because a late
  // reply could carry an older state than the last broadcast.
  async function refresh(full) {
    const r = await ask({ type: "getState" });
    if (r.error === "no-reply" && pollTimer !== null) {
      clearInterval(pollTimer); // extension reloaded: this script is orphaned
      pollTimer = null;
    }
    if (!r.ok) return;
    if (full) {
      setState(r.state);
      if (Array.isArray(r.candidates)) view.candidates = r.candidates;
    }
    view.captures = r.captures || null;
    if (full) applyVisibility();
    else if (ui.host) renderSources();
  }

  function onHubMessage(msg) {
    switch (msg.type) {
      case "candidates":
        if (!Array.isArray(msg.candidates)) return;
        view.candidates = msg.candidates;
        if (ui.host) {
          renderPicker();
          renderControls();
          renderStatus();
        }
        return;
      case "tick":
        if (!sameVideo(msg, selected())) return;
        view.tick = msg;
        if (ui.host && isShown()) renderTimeline();
        return;
      case "mark":
        view.lastMark = msg;
        if (msg.action === "markEnd") addSegment(msg.start, msg.end);
        if (ui.host) renderControls();
        return;
      case "markError":
        showError(msg);
        return;
      case "state":
        setState(msg.state);
        applyVisibility();
        return;
      case "pageChanged":
        onPageChanged();
        return;
      default:
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || !msg || (msg.to !== "panel" && msg.to !== "all")) return undefined;
    onHubMessage(msg);
    return undefined;
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) e.append(c);
    return e;
  }

  // 75 -> "1:15", 3725 -> "1:02:05"; tenths adds ".s" (marks).
  function fmtTime(sec, tenths) {
    if (typeof sec !== "number" || !Number.isFinite(sec)) return "-:--";
    const total = tenths ? Math.floor(sec * 10) / 10 : Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = tenths ? s.toFixed(1).padStart(4, "0") : String(s).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  const frameLabel = (frameId) => (frameId === 0 ? "Page" : `Frame ${frameId}`);

  function candidateLabel(c, index) {
    const parts = [frameLabel(c.frameId)];
    const sameFrame = view.candidates.filter((x) => x.frameId === c.frameId);
    if (sameFrame.length > 1) parts[0] += ` #${sameFrame.indexOf(c) + 1}`;
    parts.push(c.live ? "live" : c.duration === null ? "?:??" : fmtTime(c.duration));
    let label = parts.join(" · ");
    if (c.excluded) label += ` (${EXCLUDED_LABEL[c.excluded] || "excluded"})`;
    return label || `Video ${index + 1}`;
  }

  function render() {
    if (!ui.host) return;
    renderPicker();
    renderSegments();
    renderControls(); // also draws the timeline
    renderSources();
    renderStatus();
  }

  // Rebuilt only when the options change: agents resend candidates on scroll
  // (area), and a rebuild would close an open dropdown.
  function renderPicker() {
    const show = view.candidates.length >= 2;
    ui.pickerRow.hidden = !show;
    if (!show) return;
    const s = selected();
    const value = s ? `${s.frameId}:${s.videoKey}` : "";
    const opts = view.candidates.map((c, i) => ({
      value: `${c.frameId}:${c.videoKey}`,
      label: candidateLabel(c, i), // shows why ad / small videos were not auto-picked
      disabled: c.excluded === "live", // cannot be marked; ad and small stay selectable
    }));
    const known = opts.some((o) => o.value === value);
    const sig = JSON.stringify([opts, known]);
    if (sig !== ui.pickerSig) {
      ui.pickerSig = sig;
      const options = opts.map((o) => {
        const opt = el("option", { text: o.label });
        opt.value = o.value;
        opt.disabled = o.disabled;
        return opt;
      });
      if (!known) {
        const none = el("option", { text: "No video selected" });
        none.value = "";
        none.disabled = true;
        options.unshift(none);
      }
      ui.picker.replaceChildren(...options);
    }
    const want = known ? value : "";
    if (ui.picker.value !== want) ui.picker.value = want; // also undoes a failed choice
  }

  function onPickerChange() {
    const v = ui.picker.value;
    const i = v.indexOf(":");
    if (i < 0) return;
    selectVideo(Number(v.slice(0, i)), v.slice(i + 1));
  }

  // HiDPI: backing store at devicePixelRatio, drawing in CSS px.
  function renderTimeline() {
    const canvas = ui.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(TIMELINE_W * dpr);
    const h = Math.round(TIMELINE_H * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, TIMELINE_W, TIMELINE_H);
    const top = 6;
    const barH = TIMELINE_H - 12;
    ctx.fillStyle = "#3a3a3c";
    ctx.fillRect(0, top, TIMELINE_W, barH);

    const d = currentDuration();
    const t = currentTime();
    const x = (sec) => Math.max(0, Math.min(TIMELINE_W, (sec / d) * TIMELINE_W));
    if (d) {
      if (t !== null) {
        ctx.fillStyle = "#56565a"; // played part
        ctx.fillRect(0, top, x(t), barH);
      }
      ctx.fillStyle = "rgba(10, 132, 255, 0.75)";
      for (const seg of view.segments) ctx.fillRect(x(seg.start), top, Math.max(2, x(seg.end) - x(seg.start)), barH);
      const ps = view.state && view.state.pendingStart;
      if (typeof ps === "number") {
        ctx.fillStyle = "#30d158";
        ctx.fillRect(x(ps) - 1, top - 4, 2, barH + 8);
      }
      if (t !== null) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x(t) - 1, 0, 2, TIMELINE_H);
      }
    }
    ui.time.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
    canvas.classList.toggle("disabled", !canSeek());
  }

  function canSeek() {
    const c = selectedCandidate();
    return Boolean(selected() && currentDuration() && !(c && c.live));
  }

  function onTimelineClick(e) {
    if (!canSeek()) return;
    const r = ui.canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const time = frac * currentDuration();
    if (view.tick) view.tick = { ...view.tick, currentTime: time }; // move now; the next tick confirms
    renderTimeline();
    seek(time);
  }

  function canMark() {
    const c = selectedCandidate();
    return Boolean(c && !c.live);
  }

  function renderControls() {
    const ok = canMark();
    ui.markStart.disabled = !ok;
    ui.markEnd.disabled = !ok;
    const ps = view.state && view.state.pendingStart;
    const m = view.lastMark;
    let text = "";
    if (typeof ps === "number") text = `Start at ${fmtTime(ps, true)}; mark the end.`;
    else if (m && m.action === "markEnd") text = `Marked ${fmtTime(m.start, true)} → ${fmtTime(m.end, true)}`;
    ui.markInfo.textContent = text;
    for (const r of ui.modeRadios) r.checked = r.value === view.mode;
    for (const r of ui.precisionRadios) r.checked = r.value === view.precision;
    renderTimeline(); // pendingStart / segments may have changed
  }

  // --- segments (3.6) ---

  // "h:mm:ss.s", "mm:ss.s" or "ss.s" -> seconds; null when malformed. Minutes and
  // seconds after a colon must be < 60.
  function parseTime(text) {
    const parts = String(text).trim().split(":");
    if (parts.length > 3) return null;
    const secText = parts.pop();
    if (!/^\d+(\.\d+)?$/.test(secText) || !parts.every((p) => /^\d+$/.test(p))) return null;
    const sec = Number(secText);
    const [h, m] = parts.length === 2 ? parts.map(Number) : [0, parts.length ? Number(parts[0]) : 0];
    if ((parts.length && sec >= 60) || (parts.length === 2 && m >= 60)) return null;
    const t = h * 3600 + m * 60 + sec;
    return Number.isFinite(t) ? t : null;
  }

  function sortSegments() {
    view.segments.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function segmentsChanged() {
    sortSegments();
    scheduleSave();
    pushSegments();
    if (!ui.host) return;
    renderSegments();
    renderTimeline();
  }

  function addSegment(start, end) {
    if (typeof start !== "number" || typeof end !== "number" || !(end > start)) return;
    if (view.segments.length >= MAX_SEGMENTS) {
      view.error = `At most ${MAX_SEGMENTS} segments; delete one first.`;
      if (ui.host) renderStatus();
      return;
    }
    view.segments.push({ start, end });
    view.segError = null;
    segmentsChanged();
  }

  // Commits an edited start or end. A rejected value keeps the old one.
  function editSegment(seg, field, input) {
    const t = parseTime(input.value);
    let text = "";
    if (t === null) text = "Use h:mm:ss.s, mm:ss.s or ss.s.";
    else if (field === "start" ? t >= seg.end : t <= seg.start) text = "The end must be after the start.";
    if (text) view.segError = { seg, text };
    else {
      seg[field] = t;
      view.segError = null;
    }
    input.value = fmtTime(seg[field], true); // the old value when rejected
    segmentsChanged();
  }

  function clearSegments() {
    view.segments = [];
    view.segError = null;
    segmentsChanged();
  }

  function deleteSegment(seg) {
    const i = view.segments.indexOf(seg);
    if (i >= 0) view.segments.splice(i, 1);
    if (view.segError && view.segError.seg === seg) view.segError = null;
    segmentsChanged();
  }

  // One row per segment object, reused across renders so an edit (or Tab to the
  // next field) keeps focus unless the order changes.
  const segRows = new WeakMap();

  function segmentRow(seg) {
    let row = segRows.get(seg);
    if (row) return row;
    const timeInput = (field, label) => {
      const input = el("input", { type: "text", class: "time-in", "aria-label": label, spellcheck: "false" });
      input.addEventListener("change", () => editSegment(seg, field, input));
      return input;
    };
    row = {
      idx: el("span", { class: "idx" }),
      start: timeInput("start", "Start"),
      end: timeInput("end", "End"),
      dur: el("span", { class: "dur" }),
      warn: el("span", { class: "warn", text: "⚠", title: "Overlaps another segment" }),
      err: el("div", { class: "err" }),
    };
    const jump = el("button", { class: "jump", title: "Jump to start", "aria-label": "Jump to start", text: "▶" });
    jump.addEventListener("click", () => seek(seg.start));
    const del = el("button", { class: "del", title: "Delete", "aria-label": "Delete segment", text: "×" });
    del.addEventListener("click", () => deleteSegment(seg));
    row.li = el(
      "li",
      { class: "segment" },
      row.idx, row.start, el("span", { class: "dash", text: "–" }), row.end, row.dur, row.warn, jump, del, row.err
    );
    segRows.set(seg, row);
    return row;
  }

  // Leaves the focused field alone: a render mid-edit must not wipe the draft.
  function renderSegments() {
    const segs = view.segments;
    const active = ui.root.activeElement;
    let maxEnd = -Infinity;
    let overlaps = 0;
    const lis = segs.map((seg, i) => {
      const row = segmentRow(seg);
      const overlap = seg.start < maxEnd;
      maxEnd = Math.max(maxEnd, seg.end);
      if (overlap) overlaps++;
      row.idx.textContent = String(i + 1);
      if (row.start !== active) row.start.value = fmtTime(seg.start, true);
      if (row.end !== active) row.end.value = fmtTime(seg.end, true);
      row.dur.textContent = fmtTime(seg.end - seg.start, true);
      row.warn.hidden = !overlap;
      const err = view.segError && view.segError.seg === seg ? view.segError.text : "";
      row.err.textContent = err;
      row.err.hidden = !err;
      return row.li;
    });
    if (!lis.length) lis.push(el("li", { class: "empty", text: "No segments yet. Press [ and ] to mark." }));
    const same = lis.length === ui.segList.children.length && lis.every((li, i) => ui.segList.children[i] === li);
    if (!same) ui.segList.replaceChildren(...lis);
    ui.segTitle.textContent = segs.length ? `Segments (${segs.length})` : "Segments";
    ui.segWarn.textContent = overlaps ? "⚠ Some segments overlap." : "";
    ui.segWarn.hidden = !overlaps;
    if (!segs.length) ui.clearArmed = false;
    renderClear();
  }

  // Two clicks, no dialog: "Clear", then "Yes". "No" lands where "Clear" was, so
  // a double-click does not clear.
  function renderClear() {
    const any = view.segments.length > 0;
    ui.clear.hidden = !any || ui.clearArmed;
    ui.clearConfirm.hidden = !any || !ui.clearArmed;
  }

  function armClear(on) {
    ui.clearArmed = on;
    renderClear();
  }

  // "cdn.example.com/…/index.m3u8"; the raw URL otherwise (shortened).
  function sourceName(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return String(url).slice(0, 80);
    }
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : "";
    return parts.length > 1 ? `${u.host}/…/${last}` : `${u.host}/${last}`;
  }

  function renderSources() {
    const cap = view.captures;
    const rows = [];
    const entries = cap && Array.isArray(cap.entries) ? cap.entries.slice(-MAX_SOURCES).reverse() : [];
    for (const e of entries) {
      const kind = e.kind === "hls" ? (e.isMaster ? "HLS master" : "HLS") : e.kind === "mp4" ? "MP4" : String(e.kind);
      rows.push(
        el(
          "li",
          null,
          el("span", { class: "kind", text: kind }),
          el("span", { class: "name", text: sourceName(e.url) }),
          el("span", { class: "frame", text: frameLabel(e.frameId) })
        )
      );
    }
    const active = cap && cap.active && typeof cap.active === "object" ? cap.active : {};
    for (const [frameId, a] of Object.entries(active)) {
      if (!a || typeof a.count !== "number") continue;
      rows.push(
        el(
          "li",
          null,
          el("span", { class: "kind", text: "Stream" }),
          el("span", { class: "name", text: `${a.count} segment${a.count === 1 ? "" : "s"} loaded` }),
          el("span", { class: "frame", text: frameLabel(Number(frameId)) })
        )
      );
    }
    if (!rows.length) rows.push(el("li", { class: "empty", text: "Nothing captured yet. Play the video." }));
    const sig = rows.map((r) => r.textContent).join("\n");
    if (sig === ui.sourcesSig) return; // polled every POLL_MS; keep the list's scroll
    ui.sourcesSig = sig;
    ui.sources.replaceChildren(...rows);
  }

  function renderStatus() {
    const c = selectedCandidate();
    let text;
    let warn = false;
    if (view.error) {
      text = view.error;
      warn = true;
    } else if (!c) {
      text = view.candidates.length ? "No video selected." : "No video found on this page.";
      warn = true;
    } else if (c.live) {
      text = `${candidateLabel(c, 0)}: live stream, cannot be marked.`;
      warn = true;
    } else {
      const by = view.state && view.state.selectedBy === "user" ? "chosen" : "auto";
      text = `Video: ${candidateLabel(c, 0)} (${by})`;
    }
    ui.status.textContent = text;
    ui.status.classList.toggle("warn", warn);
  }

  // In fullscreen only document.fullscreenElement is rendered: an iframe (the
  // player's frame went fullscreen) or a container outside the panel's host.
  // The compact panel takes over there (agent.js).
  function hiddenByFullscreen() {
    const fse = document.fullscreenElement;
    return Boolean(fse) && !(ui.host && fse.contains(ui.host));
  }

  // Shows or hides the panel from view.state; mounts on the first show.
  function applyVisibility() {
    const show = isShown() && !hiddenByFullscreen();
    if (show && !ui.host) mount();
    if (!ui.host) return;
    ui.host.style.setProperty("display", show ? "block" : "none", "important");
    if (show) {
      render();
      placePanel();
      if (pollTimer === null) pollTimer = setInterval(() => refresh(false), POLL_MS);
    } else if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Mount + drag
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    .panel {
      box-sizing: border-box; width: ${PANEL_W}px; max-height: calc(100vh - ${2 * MARGIN}px); overflow: auto;
      background: #1c1c1e; color: #f2f2f7; border: 1px solid #3a3a3c; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      user-select: none; -webkit-user-select: none;
    }
    .header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 8px 6px 12px; cursor: move; border-bottom: 1px solid #3a3a3c; touch-action: none;
    }
    .title { font-weight: 600; font-size: 13px; }
    .body { padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 8px; }
    button, select { font: inherit; color: inherit; }
    .close { background: none; border: 0; font-size: 16px; line-height: 1; padding: 2px 6px; cursor: pointer; color: #aeaeb2; }
    .close:hover { color: #fff; }
    select { width: 100%; background: #2c2c2e; border: 1px solid #48484a; border-radius: 6px; padding: 3px 4px; }
    canvas { display: block; width: ${TIMELINE_W}px; height: ${TIMELINE_H}px; cursor: pointer; }
    canvas.disabled { cursor: default; opacity: 0.6; }
    .time { font-variant-numeric: tabular-nums; color: #aeaeb2; text-align: right; }
    .row { display: flex; gap: 6px; align-items: center; }
    .marks button {
      flex: 1; padding: 5px 0; border-radius: 6px; border: 1px solid #48484a; background: #2c2c2e; cursor: pointer;
    }
    .marks button:hover:not(:disabled) { background: #3a3a3c; }
    .marks button:disabled { opacity: 0.45; cursor: default; }
    .info { min-height: 1.4em; color: #aeaeb2; font-variant-numeric: tabular-nums; }
    .seg { display: flex; border: 1px solid #48484a; border-radius: 6px; overflow: hidden; flex: 1; }
    .seg label { flex: 1; text-align: center; padding: 3px 0; cursor: pointer; }
    .seg input { position: absolute; opacity: 0; pointer-events: none; }
    .seg label:has(input:checked) { background: #0a84ff; color: #fff; }
    .seg label:has(input:focus-visible) { outline: 2px solid #64d2ff; outline-offset: -2px; }
    .optname { width: 62px; color: #aeaeb2; }
    .seghead { display: flex; align-items: center; gap: 4px; }
    .seghead h3 { flex: 1; }
    .seghead button {
      flex: none; padding: 0 6px; border-radius: 4px; border: 1px solid #48484a; background: #2c2c2e;
      cursor: pointer; font-size: 11px; color: #aeaeb2;
    }
    .seghead button:hover { color: #fff; }
    .seghead button.yes { border-color: #ff453a; color: #ff453a; }
    .seghead .ask { font-size: 11px; color: #aeaeb2; }
    h3 { margin: 2px 0 0; font-size: 11px; font-weight: 600; color: #aeaeb2; text-transform: uppercase; letter-spacing: 0.04em; }
    ul { list-style: none; margin: 0; padding: 0; max-height: 120px; overflow: auto; }
    li { display: flex; gap: 6px; padding: 2px 0; white-space: nowrap; }
    li .kind { flex: none; width: 66px; color: #64d2ff; }
    li .name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    li .frame { flex: none; color: #8e8e93; }
    li.empty { color: #8e8e93; }
    ul.segments { max-height: 160px; }
    li.segment { align-items: center; gap: 4px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
    li.segment .idx { flex: none; width: 18px; text-align: right; color: #8e8e93; }
    li.segment .dash { color: #8e8e93; }
    li.segment input {
      width: 62px; box-sizing: border-box; padding: 1px 3px; border-radius: 4px; border: 1px solid #48484a;
      background: #2c2c2e; font: inherit; color: inherit; user-select: text; -webkit-user-select: text;
    }
    li.segment .dur { flex: 1; color: #aeaeb2; }
    li.segment button { flex: none; background: none; border: 0; padding: 0 3px; cursor: pointer; color: #aeaeb2; }
    li.segment button:hover { color: #fff; }
    li.segment .warn, .segwarn { color: #ffd60a; }
    li.segment .err { flex-basis: 100%; padding-left: 22px; color: #ff453a; white-space: normal; }
    .status { color: #aeaeb2; border-top: 1px solid #3a3a3c; padding-top: 6px; }
    .status.warn { color: #ffd60a; }
    [hidden] { display: none !important; }
  `;

  // Segmented control from radios; onChange(value) on user change.
  function segmented(name, choices, onChange) {
    const radios = [];
    const box = el("div", { class: "seg", role: "radiogroup" });
    for (const [value, label] of choices) {
      const input = el("input", { type: "radio", name });
      input.value = value;
      input.addEventListener("change", () => input.checked && onChange(value));
      radios.push(input);
      box.append(el("label", null, input, label));
    }
    return { box, radios };
  }

  // Page handlers must not react to clicks or keys inside the panel. Bubble
  // phase only: page and agent capture-phase listeners still run first.
  const ISOLATED_EVENTS = [
    "click", "dblclick", "contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup",
    "wheel", "keydown", "keyup", "keypress", "input", "change", "focusin", "focusout",
  ];

  function mount() {
    const host = document.createElement("segdown-panel");
    for (const [k, v] of [
      ["all", "initial"],
      ["position", "fixed"],
      ["z-index", "2147483647"],
      ["left", "0px"],
      ["top", "0px"],
      ["display", "none"],
    ]) {
      host.style.setProperty(k, v, "important");
    }
    for (const type of ISOLATED_EVENTS) host.addEventListener(type, (e) => e.stopPropagation());
    const root = host.attachShadow({ mode: "closed" });
    ui.root = root;

    const header = el("div", { class: "header" }, el("span", { class: "title", text: "SegDown" }));
    const close = el("button", { class: "close", title: "Close", "aria-label": "Close", text: "×" });
    close.addEventListener("click", closePanel);
    close.addEventListener("pointerdown", (e) => e.stopPropagation()); // no drag from the button
    header.append(close);

    ui.picker = el("select", { "aria-label": "Video" });
    ui.picker.addEventListener("change", onPickerChange);
    ui.pickerRow = el("div", null, ui.picker);

    ui.canvas = el("canvas", { "aria-label": "Timeline" });
    ui.canvas.addEventListener("click", onTimelineClick);
    ui.time = el("div", { class: "time" });

    ui.markStart = el("button", { text: "Mark start" });
    ui.markEnd = el("button", { text: "Mark end" });
    ui.markStart.addEventListener("click", () => mark("markStart"));
    ui.markEnd.addEventListener("click", () => mark("markEnd"));
    ui.markInfo = el("div", { class: "info" });

    ui.segTitle = el("h3");
    ui.segList = el("ul", { class: "segments" });
    ui.segWarn = el("div", { class: "segwarn" });
    ui.clear = el("button", { title: "Clear this page's segments", text: "Clear" });
    ui.clear.addEventListener("click", () => armClear(true));
    const yes = el("button", { class: "yes", text: "Yes" });
    yes.addEventListener("click", () => {
      ui.clearArmed = false;
      clearSegments();
    });
    const no = el("button", { text: "No" });
    no.addEventListener("click", () => armClear(false));
    ui.clearConfirm = el("span", null, el("span", { class: "ask", text: "Clear? " }), yes, " ", no);
    ui.clearArmed = false;
    const segHead = el("div", { class: "seghead" }, ui.segTitle, ui.clear, ui.clearConfirm);
    ui.segmentsSlot = el("div", null, segHead, ui.segList, ui.segWarn);

    const mode = segmented("segdown-mode", [["separate", "Separate"], ["merged", "Merged"]], (v) => {
      view.mode = v;
      scheduleSave();
    });
    const precision = segmented("segdown-precision", [["precise", "Precise"], ["fast", "Fast"]], (v) => {
      view.precision = v;
      scheduleSave();
    });
    ui.modeRadios = mode.radios;
    ui.precisionRadios = precision.radios;

    ui.sources = el("ul");
    ui.status = el("div", { class: "status" });

    const body = el(
      "div",
      { class: "body" },
      ui.pickerRow,
      el("div", null, ui.canvas, ui.time),
      el("div", { class: "row marks" }, ui.markStart, ui.markEnd),
      ui.markInfo,
      ui.segmentsSlot,
      el("div", { class: "row" }, el("span", { class: "optname", text: "Output" }), mode.box),
      el("div", { class: "row" }, el("span", { class: "optname", text: "Cut" }), precision.box),
      el("h3", { text: "Sources" }),
      ui.sources,
      ui.status
    );
    ui.panel = el("div", { class: "panel" }, header, body);
    root.append(el("style", { text: CSS }), ui.panel);
    ui.host = host;
    enableDrag(header);
    document.documentElement.append(host);
  }

  function clampPos(p) {
    const w = ui.panel.offsetWidth || PANEL_W;
    const h = ui.panel.offsetHeight || 200;
    const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
    const maxY = Math.max(MARGIN, window.innerHeight - h - MARGIN); // .panel max-height fits the viewport
    return { x: Math.round(Math.min(Math.max(p.x, MARGIN), maxX)), y: Math.round(Math.min(Math.max(p.y, MARGIN), maxY)) };
  }

  // Default: top right.
  function placePanel() {
    if (!ui.host) return;
    const p = clampPos(view.pos || { x: window.innerWidth - PANEL_W - 16, y: 16 });
    ui.host.style.setProperty("left", `${p.x}px`, "important");
    ui.host.style.setProperty("top", `${p.y}px`, "important");
  }

  function savePos() {
    if (view.pos) ask({ type: "savePos", x: view.pos.x, y: view.pos.y });
  }

  function enableDrag(handle) {
    let start = null; // {px, py, x, y}
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = ui.host.getBoundingClientRect();
      start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!start) return;
      view.pos = clampPos({ x: start.x + e.clientX - start.px, y: start.y + e.clientY - start.py });
      placePanel();
    });
    const end = () => {
      if (!start) return;
      start = null;
      savePos();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  window.addEventListener(
    "resize",
    () => {
      if (!ui.host || !isShown()) return;
      placePanel();
      renderTimeline(); // devicePixelRatio changes with zoom
    },
    { passive: true }
  );

  document.addEventListener("fullscreenchange", applyVisibility);

  // agent.js (same frame, same isolated world) skips `[` / `]` while one of the
  // panel's fields has focus: its key listener only sees the closed root's host.
  window.segdownPanelHasTextFocus = () => {
    const a = ui.root && ui.root.activeElement;
    return Boolean(a && ["input", "textarea", "select"].includes(a.localName));
  };

  // ---------------------------------------------------------------------------
  // Persistence (3.7)
  // ---------------------------------------------------------------------------

  // [{start, end}] when every item is valid enough to keep; invalid items are dropped.
  function validSegments(list) {
    if (!Array.isArray(list) || list.length > MAX_SEGMENTS) return [];
    return list
      .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.start < s.end)
      .map((s) => ({ start: s.start, end: s.end }));
  }

  // Page entry first, then the global prefs; anything invalid is ignored.
  function applyStored(got) {
    const p = got.pos;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) view.pos = { x: p.x, y: p.y };
    const page = got.page && typeof got.page === "object" ? got.page : {};
    const prefs = got.prefs && typeof got.prefs === "object" ? got.prefs : {};
    view.mode = [page.mode, prefs.mode].find((m) => MODES.includes(m)) || view.mode;
    view.precision = [page.precision, prefs.precision].find((m) => PRECISIONS.includes(m)) || view.precision;
    // Marks made before the load finished are kept too.
    view.segments = validSegments(page.segments).concat(view.segments).slice(0, MAX_SEGMENTS);
    sortSegments();
  }

  // Position and segments first, so the first show lands where the user left the
  // panel, with the restored marks (no flash of defaults).
  function loadStored() {
    const gen = ++loadGen;
    return ask({ type: "loadPage" }).then((got) => {
      if (gen !== loadGen) return;
      if (got.ok) applyStored(got);
      restored = true;
      pushSegments(); // restored marks reach the compact panel too
      if (saveTimer !== null) scheduleSave(); // a change arrived before the load
      if (ui.host) render();
    });
  }

  // The top URL changed without a reload. The pending save still goes to the
  // old page (the hub keys this document's saves by its last loadPage); then the
  // new page's entry replaces the list.
  function onPageChanged() {
    flushSave();
    if (saveTimer !== null) clearTimeout(saveTimer); // not restored yet: nothing to keep
    saveTimer = null;
    restored = false;
    Object.assign(view, { segments: [], segError: null, lastMark: null, error: "" });
    if (ui.host) render();
    loadStored();
  }

  function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, SAVE_DELAY_MS);
  }

  function flushSave() {
    if (saveTimer === null || !restored) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    save();
  }

  // An empty list removes the page entry; prefs still carry mode and precision
  // (the hub writes both and prunes old pages).
  function save() {
    if (!restored) {
      scheduleSave(); // retried once the stored entry is in
      return;
    }
    const segments = view.segments.map(({ start, end }) => ({ start, end }));
    ask({ type: "savePage", segments, mode: view.mode, precision: view.precision });
  }

  window.addEventListener("pagehide", flushSave);

  // Back/forward cache restore: the top-frame commit cleared the hub's tab
  // state (closed panel, no candidates, no page key). Register this page's key
  // again (the reply is ignored: the list in memory is current), take the
  // hub's state again and give it back this page's segments.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    ask({ type: "loadPage" });
    refresh(true);
    pushSegments();
  });

  loadStored().then(() => refresh(true));
})();
