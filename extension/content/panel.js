// SegDown panel: top frame only. A floating panel in a closed shadow root that
// renders the hub's data (video picker, timeline, marks, options, sources).
// Message protocol: see the hub in background.js.
// Blocks: state, hub messaging, render, mount + drag, persistence, boot.
// 3.6: segment list (the `[` / `]` keys live in agent.js), 3.7 persistence,
// 3.8: hidden while another element is fullscreen; the segments go to the hub
// for the compact fullscreen panel (agent.js).
// 4.1: the hub's chosen source (summary only: kind, host, file, frame, how it was
// chosen) above the Download area; clicking a Sources row chooses that source.
// 4.2: for an HLS master, a Quality <select> of its variants (resolution and
// bandwidth labels only; the variant URLs stay in the hub), highest preselected.
// 4.3: the Download button sends `download` {title, mode, precision}; the hub
// builds the job from its own state (segments, source with headers) and shows
// the app's answer here.
// 4.4: below it, this tab's jobs (state, segment i/N, progress, message, Cancel),
// from the hub's `jobs` every JOBS_POLL_MS while shown and a job is queued or running.
// 4.5: a "Use yt-dlp (page URL)" checkbox (setYtDlp) makes the page URL the source;
// the hub's `deps` (the app's missing tools) disables Download when the source
// needs one (page: yt-dlp, ffmpeg; hls/mp4: ffmpeg, ffprobe) and warns when a page
// source lacks deno.
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
  const JOBS_POLL_MS = 1000; // only while a listed job is queued or running
  const JOB_STATE_LABEL = {
    queued: "Queued", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled", unknown: "Unknown",
  };
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
    "unknown-source": "That source is gone; pick another one.",
    "unknown-variant": "That quality is gone; pick another one.",
    "no-segments": "Mark a segment first.",
    "no-source": "No source yet. Play the video.",
    "unknown-job": "That job is gone.",
  };
  const QUEUED_TEXT = "Queued — see SegDown in the menu bar.";
  const VIA_LABEL = { currentSrc: "video src", capture: "captured", page: "yt-dlp", user: "chosen" };
  // Tools each source kind needs (SegDownCore Tool raw values); ffprobe ships in the ffmpeg formula.
  const PAGE_TOOLS = ["yt-dlp", "ffmpeg"];
  const MEDIA_TOOLS = ["ffmpeg", "ffprobe"];
  const FORMULA = { "yt-dlp": "yt-dlp", ffmpeg: "ffmpeg", ffprobe: "ffmpeg" };
  const DENO_TEXT = "deno is missing: some sites (e.g. YouTube) may fail. brew install deno";
  const KIND_LABEL = { hls: "HLS", mp4: "MP4", page: "Page" };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const view = {
    state: null, // hub state {selected, selectedBy, panelOpen, pendingStart}
    candidates: [], // [{frameId, videoKey, area, duration, live, paused, excluded, score, currentSrc?}]
    tick: null, // last tick of the selected video {frameId, videoKey, currentTime, duration, paused}
    captures: null, // {entries: [{url, frameId, kind, isMaster, ts}], active: {<frameId>: {count, ts}}}
    // hub summary {kind, host, file, frameId, via, probe?, variants?, variant?} or null
    // (never URLs or headers; variants: [{width, height, bandwidth}], highest first)
    source: null,
    lastMark: null, // last `mark` relay {action, time, start?, frameId, videoKey}
    segments: [], // [{start, end}] sorted by start, at most MAX_SEGMENTS (3.7 persists them)
    segError: null, // {seg, text}: the last rejected edit, shown under that row
    mode: "separate", // "separate" | "merged" (3.7 persists it)
    precision: "precise", // "precise" | "fast" (3.7 persists it)
    error: "", // last failed action, shown in the status line
    pos: null, // {x, y} once loaded or dragged
    download: { busy: false, text: "", ok: false }, // last Download result (4.3)
    // hub job summaries {id, title, state, segmentIndex, segmentCount, fraction, message}, newest first (4.4)
    jobs: [],
    jobsError: "", // the hub's appError
    cancelError: "", // the last failed Cancel, until the next one
    ytDlp: false, // the hub's "Use yt-dlp (page URL)" toggle (4.5)
    missing: [], // tools the app reports missing, from the hub's `deps` (4.5)
  };

  const ui = {}; // DOM refs, filled by mount()
  let pollTimer = null;
  let restored = false; // saves wait for the stored entry, or they would overwrite it
  let loadFailed = false; // loadPage failed: saves stay blocked (and are not retried) until the next page
  let saveTimer = null;
  let loadGen = 0; // a loadPage reply for an older page (pageChanged) is ignored
  let sourceGen = 0; // only the newest getSource / chooseSource reply is shown
  let jobsTimer = null;
  let jobsGen = 0; // only the newest `jobs` reply is shown
  let depsGen = 0; // only the newest `deps` reply is used

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
    refreshSource();
  }

  function applySource(gen, r) {
    if (gen !== sourceGen || !r.ok) return;
    view.source = r.source && typeof r.source === "object" ? r.source : null;
    view.ytDlp = r.ytDlp === true;
    if (ui.host) renderSource();
  }

  async function refreshSource() {
    const gen = ++sourceGen;
    applySource(gen, await ask({ type: "getSource" }));
  }

  // index/url: the row's entry in view.captures (the hub re-checks both).
  async function chooseSource(index, url) {
    const gen = ++sourceGen;
    const r = await act({ type: "chooseSource", index, url });
    if (!r.ok) refresh(false); // the list moved on
    applySource(gen, r);
  }

  // index into view.source.variants; the hub maps it to the variant.
  async function chooseVariant(index) {
    const gen = ++sourceGen;
    const r = await act({ type: "chooseVariant", index });
    if (!r.ok) refreshSource(); // puts the select back
    applySource(gen, r);
  }

  // on: the checkbox's new value; a failure puts it back.
  async function setYtDlp(on) {
    const gen = ++sourceGen;
    const r = await act({ type: "setYtDlp", on });
    if (!r.ok) refreshSource();
    applySource(gen, r);
  }

  // Asked when the panel opens (each ping spawns a host, which may launch the
  // app, so not on the poll). An app error leaves the list empty (Download
  // reports it as before).
  async function refreshDeps() {
    const gen = ++depsGen;
    const r = await ask({ type: "deps" });
    if (gen !== depsGen || !r.ok) return;
    view.missing = Array.isArray(r.missing) ? r.missing.filter((t) => typeof t === "string") : [];
    if (ui.host) renderSource();
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
    // Only while shown: getSource can start an HLS probe (a native host, which
    // may launch the app) on a page the user never opened the panel on.
    if (isShown()) refreshSource();
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
          renderDownload(); // live flag
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
        if (isShown()) refreshSource(); // the selection may have changed
        return;
      case "pageChanged":
        onPageChanged();
        return;
      case "sourceChanged":
        if (isShown()) refreshSource(); // a probe finished
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
    renderSource();
    renderSources();
    renderStatus();
    renderDownload();
    renderJobs();
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
    const notes = [];
    if (overlaps) notes.push("⚠ Some segments overlap.");
    if (loadFailed) notes.push("⚠ Could not load this page's saved segments; changes are not saved.");
    ui.segWarn.textContent = notes.join(" ");
    ui.segWarn.hidden = !notes.length;
    if (!segs.length) ui.clearArmed = false;
    renderClear();
    renderDownload();
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

  // The source the download will use (4.3 puts the Download button below it).
  function renderSource() {
    const s = view.source;
    let text = "No source yet. Play the video.";
    if (s && s.kind === "page") text = `Page URL via yt-dlp · ${s.host}/${s.file}`;
    else if (s) {
      const kind = KIND_LABEL[s.kind] || String(s.kind);
      text = `${kind} · ${s.host}/${s.file} · ${frameLabel(s.frameId)} · ${VIA_LABEL[s.via] || String(s.via)}`;
    }
    ui.source.textContent = text;
    ui.source.title = text;
    ui.source.classList.toggle("warn", !s);
    ui.ytDlp.checked = view.ytDlp;
    const deno = Boolean(s && s.kind === "page" && view.missing.includes("deno"));
    ui.depsInfo.textContent = deno ? DENO_TEXT : "";
    ui.depsInfo.hidden = !deno;
    renderVariants(s);
    renderDownload();
  }

  // "Install yt-dlp and ffmpeg: brew install yt-dlp ffmpeg" for the tools source s
  // needs and the app lacks, or "".
  function installHint(s) {
    const need = s.kind === "page" ? PAGE_TOOLS : MEDIA_TOOLS;
    const formulas = [...new Set(need.filter((t) => view.missing.includes(t)).map((t) => FORMULA[t]))];
    return formulas.length ? `Install ${formulas.join(" and ")}: brew install ${formulas.join(" ")}` : "";
  }

  const isDim = (n) => Number.isInteger(n) && n > 0;

  // 6200000 -> "6.2 Mbps", 128000 -> "128 kbps".
  function fmtBandwidth(b) {
    if (!Number.isFinite(b) || b < 0) return "? kbps";
    return b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mbps` : `${Math.round(b / 1e3)} kbps`;
  }

  // "1920×1080 · 6.2 Mbps". Without a resolution: "audio only" when other variants
  // have one (a master's resolution-less variant is its audio-only stream), else "unknown".
  function variantLabel(v, all) {
    let res = "unknown";
    if (isDim(v.width) && isDim(v.height)) res = `${v.width}×${v.height}`;
    else if (all.some((x) => isDim(x.width) && isDim(x.height))) res = "audio only";
    return `${res} · ${fmtBandwidth(v.bandwidth)}`;
  }

  // Options are rebuilt only when the labels change: the poll would close an open dropdown.
  function renderVariants(s) {
    const list = s && Array.isArray(s.variants) ? s.variants.filter((v) => v && typeof v === "object") : [];
    ui.variantRow.hidden = !list.length;
    if (list.length) {
      const labels = list.map((v) => variantLabel(v, list));
      const sig = JSON.stringify(labels);
      if (sig !== ui.variantSig) {
        ui.variantSig = sig;
        ui.variant.replaceChildren(
          ...labels.map((label, i) => {
            const opt = el("option", { text: label });
            opt.value = String(i);
            return opt;
          })
        );
      }
      const want = String(Number.isInteger(s.variant) && s.variant >= 0 && s.variant < list.length ? s.variant : 0);
      if (ui.variant.value !== want) ui.variant.value = want; // also undoes a failed choice
    }
    const p = s && s.probe && typeof s.probe === "object" ? s.probe : null;
    let info = "";
    if (p && p.state === "pending") info = "Reading qualities…";
    else if (p && p.state === "error") info = String(p.message || "Could not read the playlist.");
    ui.probeInfo.textContent = info;
    ui.probeInfo.title = info;
    ui.probeInfo.hidden = !info;
    ui.probeInfo.classList.toggle("warn", Boolean(p && p.state === "error"));
  }

  // --- download (4.3) ---

  // Why Download is disabled, or "" when it can be used.
  function downloadBlocker() {
    const s = view.source;
    const c = selectedCandidate();
    const hint = s ? installHint(s) : "";
    if (hint) return hint;
    if (!view.segments.length) return ERROR_TEXT["no-segments"];
    if (!s) return ERROR_TEXT["no-source"];
    if (c && c.live) return "Live streams cannot be downloaded.";
    if (s.kind === "hls" && s.probe && s.probe.state === "pending") return "Wait for the quality list.";
    return "";
  }

  function renderDownload() {
    if (!ui.download) return;
    const d = view.download;
    const reason = downloadBlocker();
    ui.download.disabled = d.busy || Boolean(reason);
    ui.download.title = reason;
    let text = d.text; // a later block replaces the last result with its reason
    if (d.busy) text = "Sending to SegDown…";
    else if (reason) text = reason;
    const isResult = !d.busy && !reason && Boolean(d.text);
    ui.downloadInfo.textContent = text;
    ui.downloadInfo.title = text;
    ui.downloadInfo.hidden = !text;
    ui.downloadInfo.classList.toggle("ok", isResult && d.ok);
    ui.downloadInfo.classList.toggle("warn", isResult && !d.ok);
  }

  // The hub takes the segments and the source from its own state.
  async function download() {
    if (view.download.busy || downloadBlocker()) return;
    view.download = { busy: true, text: "", ok: false };
    renderDownload();
    const r = await ask({ type: "download", title: String(document.title || ""), mode: view.mode, precision: view.precision });
    let text = QUEUED_TEXT;
    if (!r.ok) {
      text = typeof r.message === "string" && r.message ? r.message : ERROR_TEXT[r.error] || `Failed (${String(r.error || "unknown")}).`;
    }
    view.download = { busy: false, text, ok: r.ok === true };
    renderDownload();
    if (r.ok) refreshJobs();
  }

  // --- jobs (4.4) ---

  const isActiveJob = (j) => j.state === "queued" || j.state === "running";

  // Asks the hub once, then again every JOBS_POLL_MS while shown and a job is active.
  async function refreshJobs() {
    clearTimeout(jobsTimer);
    jobsTimer = null;
    const gen = ++jobsGen;
    const r = await ask({ type: "jobs" });
    if (gen !== jobsGen || r.error === "no-reply") return; // superseded, or orphaned
    if (r.ok) {
      view.jobs = Array.isArray(r.jobs) ? r.jobs.filter((j) => j && typeof j === "object" && typeof j.id === "string") : [];
      view.jobsError = typeof r.appError === "string" ? r.appError : "";
    }
    if (ui.host) renderJobs();
    if (isShown() && view.jobs.some(isActiveJob)) jobsTimer = setTimeout(refreshJobs, JOBS_POLL_MS);
  }

  function stopJobs() {
    clearTimeout(jobsTimer);
    jobsTimer = null;
    jobsGen++; // a reply in flight schedules nothing
  }

  async function cancelJob(id, button) {
    button.disabled = true;
    const r = await ask({ type: "cancel", id });
    view.cancelError = r.ok
      ? ""
      : (typeof r.message === "string" && r.message) || ERROR_TEXT[r.error] || `Failed (${String(r.error || "unknown")}).`;
    button.disabled = false;
    refreshJobs();
  }

  // "Segment 2/5 · 37%"; a queued job shows its segment count.
  function jobProgressText(j) {
    const n = Number.isInteger(j.segmentCount) ? j.segmentCount : 0;
    if (!n) return "";
    if (j.state === "queued") return `${n} segment${n === 1 ? "" : "s"}`;
    const i = Number.isInteger(j.segmentIndex) ? Math.min(j.segmentIndex + 1, n) : 1;
    const pct = Math.round(Math.max(0, Math.min(1, Number(j.fraction) || 0)) * 100);
    return `Segment ${i}/${n} · ${pct}%`;
  }

  // One row per job id, reused across polls so a Cancel click is not lost to a rebuild.
  const jobRows = new Map();

  function jobRow(id) {
    let row = jobRows.get(id);
    if (row) return row;
    row = {
      title: el("span", { class: "jtitle" }),
      state: el("span", { class: "jstate" }),
      cancel: el("button", { class: "jcancel", text: "Cancel" }),
      fill: el("div", { class: "fill" }),
      info: el("div", { class: "jinfo" }),
      msg: el("div", { class: "jmsg" }),
    };
    row.cancel.addEventListener("click", () => cancelJob(id, row.cancel));
    row.li = el(
      "li",
      { class: "job" },
      el("div", { class: "jhead" }, row.title, row.state, row.cancel),
      el("div", { class: "bar" }, row.fill),
      row.info,
      row.msg
    );
    jobRows.set(id, row);
    return row;
  }

  function renderJobs() {
    const lis = view.jobs.map((j) => {
      const row = jobRow(j.id);
      const title = String(j.title || "");
      row.title.textContent = title;
      row.title.title = title;
      row.state.textContent = Object.hasOwn(JOB_STATE_LABEL, j.state) ? JOB_STATE_LABEL[j.state] : String(j.state);
      row.state.className = `jstate ${Object.hasOwn(JOB_STATE_LABEL, j.state) ? j.state : ""}`;
      row.cancel.hidden = !isActiveJob(j);
      const frac = Math.max(0, Math.min(1, Number(j.fraction) || 0));
      row.fill.style.setProperty("width", `${(frac * 100).toFixed(1)}%`);
      row.info.textContent = jobProgressText(j);
      const msg = typeof j.message === "string" ? j.message : "";
      row.msg.textContent = msg;
      row.msg.hidden = !msg;
      row.msg.classList.toggle("warn", j.state === "failed");
      return row.li;
    });
    for (const id of jobRows.keys()) if (!view.jobs.some((j) => j.id === id)) jobRows.delete(id);
    const same = lis.length === ui.jobs.children.length && lis.every((li, i) => ui.jobs.children[i] === li);
    if (!same) ui.jobs.replaceChildren(...lis);
    const err = [view.jobsError, view.cancelError].filter(Boolean).join(" ");
    ui.jobsSlot.hidden = !lis.length && !err;
    ui.jobsInfo.textContent = err;
    ui.jobsInfo.hidden = !err;
  }

  // Entry rows choose that source on click (or Enter / Space).
  function sourceRow(e, index, kind) {
    const li = el(
      "li",
      { class: "pick", role: "button", tabindex: "0", title: "Use this source" },
      el("span", { class: "kind", text: kind }),
      el("span", { class: "name", text: sourceName(e.url) }),
      el("span", { class: "frame", text: frameLabel(e.frameId) })
    );
    li.addEventListener("click", () => chooseSource(index, e.url));
    li.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      chooseSource(index, e.url);
    });
    return li;
  }

  function renderSources() {
    const cap = view.captures;
    const rows = [];
    const keys = []; // index + url per row: rows with the same text may hold another entry
    const all = cap && Array.isArray(cap.entries) ? cap.entries : [];
    for (let i = all.length - 1; i >= Math.max(0, all.length - MAX_SOURCES); i--) {
      const e = all[i];
      if (!e || typeof e.url !== "string") continue;
      const kind = e.kind === "hls" ? (e.isMaster ? "HLS master" : "HLS") : e.kind === "mp4" ? "MP4" : String(e.kind);
      rows.push(sourceRow(e, i, kind));
      keys.push(`${i} ${e.url}`);
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
    const sig = rows.map((r) => r.textContent).concat(keys).join("\n");
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
      if (pollTimer === null) {
        pollTimer = setInterval(() => refresh(false), POLL_MS);
        refreshJobs(); // just shown
        refreshDeps();
      }
    } else {
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
      stopJobs();
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
    li.pick { cursor: pointer; border-radius: 4px; }
    li.pick:hover, li.pick:focus-visible { background: #2c2c2e; outline: none; }
    .source { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .source.warn, .probe.warn, .deps { color: #ffd60a; }
    label.check { display: flex; gap: 6px; align-items: center; cursor: pointer; }
    label.check input { margin: 0; }
    button.download {
      width: 100%; padding: 6px 0; border-radius: 6px; border: 0; background: #0a84ff; color: #fff;
      font-weight: 600; cursor: pointer;
    }
    button.download:hover:not(:disabled) { background: #409cff; }
    button.download:disabled { opacity: 0.45; cursor: default; }
    .dlinfo { color: #aeaeb2; white-space: normal; overflow-wrap: anywhere; }
    .dlinfo.ok { color: #30d158; }
    .dlinfo.warn { color: #ff453a; }
    ul.jobs { max-height: 180px; }
    li.job { display: block; white-space: normal; padding: 4px 0; border-top: 1px solid #2c2c2e; }
    .jhead { display: flex; align-items: center; gap: 6px; }
    .jtitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .jstate { flex: none; color: #aeaeb2; }
    .jstate.running { color: #64d2ff; }
    .jstate.done { color: #30d158; }
    .jstate.failed { color: #ff453a; }
    button.jcancel {
      flex: none; padding: 0 6px; border-radius: 4px; border: 1px solid #48484a; background: #2c2c2e;
      cursor: pointer; font-size: 11px; color: #aeaeb2;
    }
    button.jcancel:hover:not(:disabled) { color: #fff; }
    .bar { height: 4px; margin: 3px 0; background: #3a3a3c; border-radius: 2px; overflow: hidden; }
    .bar .fill { height: 100%; width: 0; background: #0a84ff; }
    .jinfo { color: #8e8e93; font-variant-numeric: tabular-nums; }
    .jmsg { color: #aeaeb2; overflow-wrap: anywhere; }
    .jmsg.warn, .jobsinfo { color: #ff453a; }
    .probe { color: #aeaeb2; }
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

    ui.source = el("div", { class: "source" });
    ui.ytDlp = el("input", { type: "checkbox" });
    ui.ytDlp.addEventListener("change", () => setYtDlp(ui.ytDlp.checked));
    ui.ytDlpRow = el(
      "label",
      { class: "check", title: "Send the page URL to yt-dlp instead of the captured media" },
      ui.ytDlp,
      "Use yt-dlp (page URL)"
    );
    ui.depsInfo = el("div", { class: "deps" });
    ui.variant = el("select", { "aria-label": "Quality" });
    ui.variant.addEventListener("change", () => chooseVariant(Number(ui.variant.value)));
    ui.variantRow = el("div", { class: "row" }, el("span", { class: "optname", text: "Quality" }), ui.variant);
    ui.probeInfo = el("div", { class: "probe" });
    ui.download = el("button", { class: "download", text: "Download" });
    ui.download.addEventListener("click", download);
    ui.downloadInfo = el("div", { class: "dlinfo" });
    ui.jobs = el("ul", { class: "jobs" });
    ui.jobsInfo = el("div", { class: "jobsinfo" });
    ui.jobsSlot = el("div", null, el("h3", { text: "Jobs" }), ui.jobs, ui.jobsInfo);
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
      el("h3", { text: "Source" }),
      ui.source,
      ui.ytDlpRow,
      ui.variantRow,
      ui.probeInfo,
      ui.depsInfo,
      ui.download,
      ui.downloadInfo,
      ui.jobsSlot,
      el("h3", { text: "Sources", title: "Click one to use it" }),
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
    if (a && a.localName === "input" && a.type === "checkbox") return false; // the yt-dlp toggle takes no text
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
  // A failed load leaves saves blocked for this page (loadFailed): a save would
  // overwrite the stored entry that could not be read.
  function loadStored() {
    const gen = ++loadGen;
    loadFailed = false;
    return ask({ type: "loadPage" }).then((got) => {
      if (gen !== loadGen) return;
      if (got.ok) {
        applyStored(got);
        restored = true;
        if (saveTimer !== null) scheduleSave(); // a change arrived before the load
      } else {
        loadFailed = true;
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = null;
      }
      pushSegments(); // restored marks reach the compact panel too
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
    view.download = { busy: view.download.busy, text: "", ok: false }; // the result belonged to the old page
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
      if (!loadFailed) scheduleSave(); // retried once the stored entry is in
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
