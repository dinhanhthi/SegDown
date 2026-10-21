// SegDown overlay (5.3): runs in every frame and shows only in the frame of the
// selected video while the overlay is open (hub state.panelOpen). A thin segment
// bar on the video's bottom edge plus Mark start / Mark end / Full clip / Download
// buttons (Full clip only while the app's switch is on), in a closed shadow root
// shown in the top layer (popover="manual", spike 1.2), so it stays above the page
// and every kind of fullscreen.
// Talks to the hub in background.js (the protocol is documented there) and reads
// the video through agent.js (globalThis.segdownAgent, same isolated world).
// Page data is untrusted: the DOM is built with textContent only, handlers act on
// trusted events only, and the hub gets menu choices only (never URLs, titles or
// times; a click on the bar seeks the video element here).

"use strict";

(() => {
  const agent = globalThis.segdownAgent;
  if (!agent) return;

  const HIDE_MS = 2000; // auto-hide after the mouse stops over the video
  const PLACE_MS = 500; // re-place tick (parent-frame scroll, layout changes)
  const POLL_MS = 1000; // `jobs` while a job is queued or running
  const REFRESH_MS = 100; // coalesces `view` calls (a mark brings several messages)
  const ACTIVE = new Set(["queued", "running"]);
  const VIDEO_EVENTS = ["timeupdate", "seeked", "durationchange", "loadedmetadata", "resize", "emptied"];
  // Players toggle play/pause or fullscreen on clicks and keys: keep them out.
  const ISOLATED_EVENTS = [
    "click", "dblclick", "contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup",
    "wheel", "keydown", "keyup", "keypress", "focusin", "focusout",
  ];
  const ERRORS = {
    "no-selection": "No video selected.",
    "no-video": "The video is gone.",
    "agent-unreachable": "The video is gone.",
    "no-start": "Mark a start first.",
    "end-not-after-start": "The end must be after the start.",
    "too-many-segments": "Too many segments (100 at most).",
    "selection-changed": "The video changed; mark again.",
    "not-selected-frame": "The video changed; try again.",
    "no-segments": "Mark a segment first.",
    "no-source": "No video source found on this page.",
    "no-duration": "The video's duration is unknown.",
    "over-limit": "The video is longer than the Max total duration in SegDown Settings.",
    "incognito-forced": "Incognito is always on in a private window.",
    "no-reply": "SegDown did not answer. Reload the page.",
  };
  // Undoes the page's and the popover UA styles on the host; the UI inside opts
  // back into pointer events, so the player's controls stay clickable elsewhere.
  const HOST_STYLE = [
    ["position", "fixed"],
    ["right", "auto"],
    ["bottom", "auto"],
    ["margin", "0"],
    ["padding", "0"],
    ["border", "0"],
    ["background", "transparent"],
    ["overflow", "visible"],
    ["max-width", "none"],
    ["max-height", "none"],
    ["min-width", "0"],
    ["min-height", "0"],
    ["box-sizing", "border-box"],
    ["transform", "none"],
    ["opacity", "1"],
    ["pointer-events", "none"],
    ["z-index", "2147483647"], // the fallback without popover support
  ];
  const CSS = `
    .wrap {
      all: initial; position: absolute; inset: 0; display: block; pointer-events: none;
      font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #f2f2f7;
      user-select: none; -webkit-user-select: none;
    }
    .ui { transition: opacity 0.2s; }
    .wrap.hidden .ui { opacity: 0; }
    .wrap.hidden .ui, .wrap.hidden .ui * { pointer-events: none !important; }
    .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 12px; pointer-events: auto; cursor: pointer; }
    .bar.live { cursor: default; }
    .track { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: rgba(255, 255, 255, 0.28); transition: height 0.1s; }
    .bar:hover .track { height: 8px; }
    .seg { position: absolute; top: 0; bottom: 0; min-width: 2px; background: rgba(10, 132, 255, 0.95); }
    .seg.done { background: rgba(48, 209, 88, 0.95); }
    .seg .del {
      position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); display: none;
      padding: 0 5px; line-height: 16px; font-size: 11px; border-radius: 4px; background: rgba(28, 28, 30, 0.9); color: #f2f2f7;
    }
    .seg:hover .del { display: block; }
    .seg .del:hover { background: #ff453a; }
    .pending { position: absolute; bottom: 0; width: 2px; height: 12px; margin-left: -1px; background: #30d158; }
    .head { position: absolute; bottom: 0; width: 2px; height: 12px; margin-left: -1px; background: #fff; }
    .panel {
      position: absolute; right: 12px; bottom: 60px; max-width: calc(100% - 24px);
      display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
    }
    .box { background: rgba(28, 28, 30, 0.9); border: 1px solid #3a3a3c; border-radius: 9px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); }
    .row { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; padding: 4px; pointer-events: auto; }
    button {
      all: unset; box-sizing: border-box; padding: 4px 9px; border-radius: 6px; background: #2c2c2e;
      color: inherit; font: inherit; white-space: nowrap; cursor: pointer;
    }
    button:hover:not(:disabled) { background: #3a3a3c; }
    button:disabled { opacity: 0.4; cursor: default; }
    button:focus-visible { outline: 2px solid #0a84ff; }
    .split { display: flex; }
    .split button { background: #0a84ff; }
    .split button:hover:not(:disabled) { background: #2f95ff; }
    .split .main { border-radius: 6px 0 0 6px; }
    .split .more { border-radius: 0 6px 6px 0; padding: 4px 6px; border-left: 1px solid rgba(0, 0, 0, 0.3); }
    .close { background: transparent; padding: 4px 7px; color: #aeaeb2; }
    .lines { max-width: 340px; padding: 3px 8px; color: #aeaeb2; font-variant-numeric: tabular-nums; }
    .lines div[hidden], .menu[hidden], button[hidden] { display: none; }
    .lines div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .warn { color: #ffd60a; }
    .err { color: #ff6961; }
    .menu { pointer-events: auto; display: block; width: 270px; padding: 4px; overflow-y: auto; overscroll-behavior: contain; }
    .h { color: #8e8e93; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin: 6px 6px 2px; }
    .item { display: flex; gap: 6px; width: 100%; background: transparent; padding: 3px 6px; }
    .item .check { width: 12px; flex: none; color: #0a84ff; }
    .item .text, .segrow .text { overflow: hidden; text-overflow: ellipsis; }
    .muted { color: #8e8e93; padding: 2px 6px; }
    .segrow { display: flex; align-items: center; }
    .segrow .text { flex: 1; padding: 2px 6px; font-variant-numeric: tabular-nums; }
    .segrow button { background: transparent; padding: 1px 7px; color: #aeaeb2; }
  `;

  let host = null; // the mounted host, or null
  let ui = null; // element refs while mounted
  let video = null; // the video the UI follows
  let rect = null; // the host's last placement (viewport px)
  let view = null; // the last `view` reply
  let job = null; // the shown job (view.job, then the `jobs` poll)
  let mode = null; // the Output choice (the hub keeps none; null = view.mode)
  let note = ""; // the last action's error
  let busy = false; // a download call is in flight
  let menuOpen = false;
  let lastMove = 0;
  let viewSeq = 0;
  let refreshTimer = null;
  let pollTimer = null;
  let placeTimer = null;
  let hideTimer = null;
  let placeFrame = 0;
  let segsKey = ""; // the drawn segments (renderBar)

  // --- helpers ---

  // -> the hub's reply, or {ok: false, error: "no-reply"} (also once the
  // extension reloads: "Extension context invalidated").
  function ask(msg) {
    const fail = { ok: false, error: "no-reply" };
    try {
      return chrome.runtime.sendMessage(msg).then((r) => (r && typeof r === "object" ? r : fail), () => fail);
    } catch {
      return Promise.resolve(fail);
    }
  }

  const isTime = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const durationOf = (v) => (v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
  const pendingStart = () => {
    const st = agent.state();
    return st && isTime(st.pendingStart) ? st.pendingStart : null;
  };
  const segments = () => (view && Array.isArray(view.segments) ? view.segments : []);
  const totalOf = (list) => list.reduce((sum, s) => sum + (s.end - s.start), 0);
  const currentMode = () => mode || (view && view.mode) || "separate";
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // 75 -> "1:15", 3725 -> "1:02:05"; tenths adds ".s".
  function fmtTime(sec, tenths) {
    if (!isTime(sec)) return "-:--";
    const total = tenths ? Math.floor(sec * 10) / 10 : Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = tenths ? s.toFixed(1).padStart(4, "0") : String(s).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  function fmtBytes(n) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1000 && i < units.length - 1) {
      n /= 1000;
      i++;
    }
    return `${i ? n.toFixed(1) : n} ${units[i]}`;
  }

  function errorText(r) {
    if (typeof r.message === "string" && r.message) return r.message;
    return ERRORS[r.error] || `Failed (${String(r.error)}).`;
  }

  function make(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // Click handlers act on trusted clicks only (a page can dispatch synthetic ones).
  function onClick(el, fn) {
    el.addEventListener("click", (e) => {
      if (e.isTrusted) fn(e);
    });
  }

  // --- mount / unmount ---

  // Shows the overlay when the hub says it is open and this frame holds the
  // selected video; hides it otherwise. Runs on every agent change.
  function sync() {
    const st = agent.state();
    const v = agent.video();
    if (!(st && st.panelOpen === true && v && v.isConnected)) return unmount();
    if (!host) mount();
    if (video !== v) attach(v);
    render();
    scheduleRefresh();
  }

  function mount() {
    host = document.createElement("segdown-overlay");
    for (const [k, v] of HOST_STYLE) host.style.setProperty(k, v, "important");
    host.setAttribute("popover", "manual");
    for (const type of ISOLATED_EVENTS) host.addEventListener(type, (e) => e.stopPropagation());
    ui = build(host.attachShadow({ mode: "closed" }));
    document.documentElement.append(host);
    show();
    window.addEventListener("scroll", schedulePlace, { capture: true, passive: true });
    window.addEventListener("resize", schedulePlace, { passive: true });
    window.addEventListener("mousemove", onMove, { capture: true, passive: true });
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onEscape, true);
    document.addEventListener("fullscreenchange", onFullscreen);
    document.addEventListener("webkitfullscreenchange", onFullscreen);
    placeTimer = setInterval(onPlaceTick, PLACE_MS);
    lastMove = Date.now();
  }

  function unmount() {
    if (!host) return;
    try {
      host.hidePopover();
    } catch {
      // not open, or no popover support
    }
    host.remove();
    host = ui = rect = view = job = null;
    menuOpen = false;
    note = "";
    detach();
    window.removeEventListener("scroll", schedulePlace, { capture: true });
    window.removeEventListener("resize", schedulePlace);
    window.removeEventListener("mousemove", onMove, { capture: true });
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onEscape, true);
    document.removeEventListener("fullscreenchange", onFullscreen);
    document.removeEventListener("webkitfullscreenchange", onFullscreen);
    for (const t of [placeTimer, pollTimer]) clearInterval(t);
    for (const t of [refreshTimer, hideTimer]) clearTimeout(t);
    cancelAnimationFrame(placeFrame);
    placeTimer = pollTimer = refreshTimer = hideTimer = null;
    placeFrame = 0;
    segsKey = "";
  }

  // (Re-)enters the top layer last, so it sits above a new fullscreen element.
  function show() {
    if (!host.isConnected) document.documentElement.append(host);
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {
      // no popover support: the fixed host with the top z-index stays
    }
    place();
  }

  function attach(v) {
    detach();
    video = v;
    for (const type of VIDEO_EVENTS) v.addEventListener(type, onVideoEvent);
    place();
  }

  function detach() {
    if (video) for (const type of VIDEO_EVENTS) video.removeEventListener(type, onVideoEvent);
    video = null;
  }

  // --- placement ---

  // The host covers the video's part inside this frame's viewport.
  function place() {
    if (!host || !video) return;
    const r = video.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const width = Math.min(r.right, window.innerWidth) - left;
    const height = Math.min(r.bottom, window.innerHeight) - top;
    const visible = video.isConnected && width > 0 && height > 0;
    rect = visible ? { left, top, right: left + width, bottom: top + height } : null;
    const s = host.style;
    s.setProperty("left", `${left}px`, "important");
    s.setProperty("top", `${top}px`, "important");
    s.setProperty("width", `${Math.max(0, width)}px`, "important");
    s.setProperty("height", `${Math.max(0, height)}px`, "important");
    s.setProperty("visibility", visible ? "visible" : "hidden", "important");
    ui.menu.style.maxHeight = `${Math.max(80, height - 110)}px`;
  }

  function schedulePlace() {
    if (!placeFrame) {
      placeFrame = requestAnimationFrame(() => {
        placeFrame = 0;
        place();
      });
    }
  }

  // A detached video only hides the host (place); the agent's rescan drops it.
  function onPlaceTick() {
    if (agent.video() !== video) return sync();
    if (!host.isConnected) show();
    else place();
  }

  // A plain re-show leaves the popover under the new fullscreen element (spike 1.2).
  function onFullscreen() {
    requestAnimationFrame(() => {
      if (host) show();
    });
  }

  function onVideoEvent(e) {
    if (e.type === "resize") place();
    if (e.type === "timeupdate" || e.type === "seeked") renderHead();
    else render();
  }

  // --- auto-hide ---

  // Stays visible while a start is pending, the menu is open, a download is being
  // sent or runs, or the pointer rests on the bar or the buttons.
  function pinned() {
    return (
      pendingStart() !== null ||
      menuOpen ||
      busy ||
      Boolean(job && ACTIVE.has(job.state)) ||
      ui.bar.matches(":hover") ||
      ui.panel.matches(":hover")
    );
  }

  function updateHide() {
    if (!ui) return;
    const idle = Date.now() - lastMove;
    const hide = idle >= HIDE_MS && !pinned();
    ui.wrap.classList.toggle("hidden", hide);
    clearTimeout(hideTimer);
    hideTimer = hide ? null : setTimeout(updateHide, Math.max(HIDE_MS - idle, 500));
  }

  function onMove(e) {
    if (!e.isTrusted || !rect) return;
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
    lastMove = Date.now();
    updateHide();
  }

  // --- menu open / close ---

  function setMenu(open) {
    menuOpen = open;
    ui.more.setAttribute("aria-expanded", String(open));
    render();
  }

  function onOutside(e) {
    if (e.isTrusted && menuOpen && !e.composedPath().includes(host)) setMenu(false);
  }

  function onEscape(e) {
    if (e.isTrusted && menuOpen && e.key === "Escape") setMenu(false);
  }

  // --- data flow ---

  function scheduleRefresh() {
    if (refreshTimer === null && host) refreshTimer = setTimeout(refresh, REFRESH_MS);
  }

  function refresh() {
    refreshTimer = null;
    const seq = ++viewSeq;
    ask({ type: "view" }).then((r) => {
      if (!host || seq !== viewSeq) return;
      if (r.ok) {
        view = r;
        if (!pollTimer) job = r.job || null; // the poll's answer is newer
      } else if (r.error !== "not-selected-frame") {
        note = errorText(r); // the frame lost the selection: sync() closes it
      }
      ensurePolling();
      render();
    });
  }

  // `jobs` every POLL_MS while a job of this tab is queued or running.
  function ensurePolling() {
    const active = Boolean(host && job && ACTIVE.has(job.state));
    if (active && !pollTimer) pollTimer = setInterval(poll, POLL_MS);
    if (!active && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function poll() {
    ask({ type: "jobs" }).then((r) => {
      if (!host) return;
      if (r.ok && Array.isArray(r.jobs)) {
        const wasActive = Boolean(job && ACTIVE.has(job.state));
        job = r.jobs.find((j) => ACTIVE.has(j.state)) || r.jobs[0] || null;
        if (wasActive && !(job && ACTIVE.has(job.state))) scheduleRefresh();
      } // a failed reply keeps the poll going; losing the selection unmounts (sync)
      ensurePolling();
      render();
    });
  }

  // Sends a menu choice; the reply's error shows in the status line.
  function act(msg) {
    note = "";
    ask(msg).then((r) => {
      if (!r.ok) note = errorText(r);
      render();
      scheduleRefresh();
    });
  }

  // full: the Full clip button (one segment [0, duration], built by the hub).
  function download(full) {
    if (full ? fullBlock() : downloadBlock()) return;
    busy = true;
    note = "";
    render();
    const incognito = Boolean(view.incognito && view.incognito.on);
    const msg = { type: "download", mode: currentMode(), incognito };
    if (full) msg.full = true;
    ask(msg).then((r) => {
      busy = false;
      if (!host) return;
      if (r.ok) {
        job = { state: "queued" };
        poll();
      } else {
        note = errorText(r);
      }
      render();
    });
  }

  // -> {text, warn} when Download must stay disabled, else null.
  function downloadBlock() {
    if (busy) return { text: "Sending…" };
    if (!view) return { text: "Loading…" };
    const list = segments();
    if (!list.length) return { text: "Mark a segment first: Mark start, then Mark end." };
    if (view.overLimit) {
      const text = `Total ${fmtTime(totalOf(list))} is over the ${fmtTime(view.maxDuration)} limit (Max total duration in SegDown Settings).`;
      return { text, warn: true };
    }
    if (typeof view.depsProblem === "string") return { text: view.depsProblem, warn: true };
    if (typeof view.appError === "string") return { text: view.appError, warn: true };
    return null;
  }

  // -> {text, warn} when Full clip must stay disabled, else null.
  function fullBlock() {
    if (busy) return { text: "Sending…" };
    if (!view) return { text: "Loading…" };
    if (!(view.duration > 0)) return { text: "Duration unknown (live stream?)" };
    if (view.maxDuration !== null && view.duration > view.maxDuration) {
      const text = `Video ${fmtTime(view.duration)} is over the ${fmtTime(view.maxDuration)} limit (Max total duration in SegDown Settings).`;
      return { text, warn: true };
    }
    if (typeof view.depsProblem === "string") return { text: view.depsProblem, warn: true };
    if (typeof view.appError === "string") return { text: view.appError, warn: true };
    return null;
  }

  function jobText(j) {
    let parts;
    switch (j.state) {
      case "queued":
        parts = ["Queued"];
        break;
      case "running": {
        const n = Number.isInteger(j.segmentCount) ? j.segmentCount : 0;
        const i = Number.isInteger(j.segmentIndex) ? Math.min(j.segmentIndex + 1, n) : 0;
        parts = [n ? `Segment ${i}/${n}` : "Downloading", `${Math.round((j.fraction || 0) * 100)}%`];
        if (Number.isInteger(j.bytes) && j.bytes > 0) parts.push(fmtBytes(j.bytes));
        break;
      }
      case "done":
        parts = ["Done"];
        break;
      case "failed":
        parts = ["Failed"];
        break;
      case "cancelled":
        parts = ["Cancelled"];
        break;
      default:
        return "";
    }
    if (j.fallbackUsed === true) parts.push("Switched to the captured media");
    if (typeof j.message === "string" && j.message) parts.push(j.message);
    return parts.join(" · ");
  }

  // --- DOM ---

  function build(root) {
    const wrap = make("div", "wrap");
    // Clicks must not move the keyboard focus into the overlay: Space and the
    // `[` / `]` keys stay with the page and its player.
    wrap.addEventListener("mousedown", (e) => e.preventDefault());

    const bar = make("div", "bar");
    const track = make("div", "track");
    const segs = make("div");
    const pending = make("div", "pending");
    const head = make("div", "head");
    track.append(segs);
    bar.append(track, pending, head);
    bar.setAttribute("aria-label", "SegDown timeline");
    onClick(bar, onBarClick);

    const start = make("button", null, "Mark start");
    const end = make("button", null, "Mark end");
    onClick(start, () => act({ type: "key", action: "markStart" }));
    onClick(end, () => act({ type: "key", action: "markEnd" }));
    const full = make("button", null, "Full clip");
    full.hidden = true;
    onClick(full, () => download(true));
    const main = make("button", "main", "Download");
    const more = make("button", "more", "▾");
    more.setAttribute("aria-label", "Download options");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    onClick(main, () => download(false));
    onClick(more, () => setMenu(!menuOpen));
    const split = make("div", "split");
    split.append(main, more);
    const close = make("button", "close", "×");
    close.setAttribute("aria-label", "Close SegDown");
    onClick(close, () => act({ type: "setPanelOpen", open: false }));
    const row = make("div", "box row");
    row.append(start, end, full, split, close);

    const menu = make("div", "box menu");
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    const jobLine = make("div");
    const statusLine = make("div");
    const lines = make("div", "box lines");
    lines.append(jobLine, statusLine);

    const panel = make("div", "panel");
    panel.append(menu, row, lines);
    const uiBox = make("div", "ui");
    uiBox.append(bar, panel);
    wrap.append(uiBox);
    root.append(make("style", null, CSS), wrap);
    return { wrap, bar, segs, pending, head, start, end, full, main, more, menu, panel, lines, jobLine, statusLine };
  }

  function onBarClick(e) {
    const d = durationOf(video);
    const r = ui.bar.getBoundingClientRect();
    if (d === null || !(r.width > 0)) return;
    video.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
    renderHead();
  }

  const pct = (t, d) => `${Math.max(0, Math.min(100, (t / d) * 100))}%`;

  function renderHead() {
    if (!ui) return;
    const d = durationOf(video);
    ui.head.hidden = d === null;
    if (d !== null) ui.head.style.left = pct(video.currentTime, d);
  }

  function renderBar() {
    const d = durationOf(video);
    ui.bar.classList.toggle("live", d === null);
    // Rebuilt only on change: a new node would drop :hover and its × button.
    const key = d === null ? "" : JSON.stringify([d, segments()]);
    if (key !== segsKey) {
      segsKey = key;
      ui.segs.replaceChildren();
      if (d !== null) {
        segments().forEach((s, index) => {
          if (!isTime(s.start) || !isTime(s.end)) return;
          const seg = make("div", s.done === true ? "seg done" : "seg");
          seg.style.left = pct(s.start, d);
          seg.style.width = pct(Math.min(s.end, d) - Math.min(s.start, d), d);
          const del = make("button", "del", "×");
          del.setAttribute("aria-label", `Delete segment ${index + 1}`);
          del.title = "Remove this segment";
          onClick(del, (e) => {
            e.stopPropagation(); // else onBarClick seeks the video
            act({ type: "removeSegment", index });
          });
          seg.append(del);
          ui.segs.append(seg);
        });
      }
    }
    const ps = pendingStart();
    ui.pending.hidden = d === null || ps === null;
    if (!ui.pending.hidden) ui.pending.style.left = pct(ps, d);
    renderHead();
  }

  function renderLines(block) {
    const jt = job ? jobText(job) : "";
    ui.jobLine.textContent = jt;
    ui.jobLine.hidden = !jt;
    ui.jobLine.className = job && job.state === "failed" ? "err" : "";
    let text = note;
    let cls = note ? "err" : "";
    if (!text && block && !busy) [text, cls] = [block.text, block.warn ? "warn" : ""];
    if (!text) {
      const list = segments();
      const ps = pendingStart();
      const done = list.filter((s) => s.done === true).length;
      text = `${plural(list.length, "segment")}${done ? ` · ${done} downloaded` : ""} · ${fmtTime(totalOf(list), true)}`;
      if (ps !== null) text += ` · start at ${fmtTime(ps, true)}`;
    }
    ui.statusLine.textContent = text;
    ui.statusLine.className = cls;
    ui.statusLine.title = text;
  }

  function render() {
    if (!ui) return;
    const ps = pendingStart();
    const live = Boolean(video && video.duration === Infinity);
    ui.start.disabled = live || ps !== null;
    ui.end.disabled = live || ps === null;
    const block = downloadBlock();
    ui.main.disabled = Boolean(block);
    ui.main.title = block ? block.text : "Download the marked segments";
    ui.full.hidden = !(view && view.fullClip === true);
    const fb = fullBlock();
    ui.full.disabled = Boolean(fb);
    ui.full.title = fb ? fb.text : "Download the whole video";
    renderBar();
    renderLines(block);
    ui.menu.hidden = !menuOpen;
    if (menuOpen) renderMenu();
    updateHide();
  }

  // --- menu ---

  function heading(text) {
    ui.menu.append(make("div", "h", text));
  }

  // checked: true / false for a choice, null for a plain action.
  function item(text, checked, fn, disabled) {
    const b = make("button", "item");
    b.setAttribute("role", checked === null ? "menuitem" : "menuitemradio");
    if (checked !== null) b.setAttribute("aria-checked", String(checked));
    b.append(make("span", "check", checked ? "✓" : ""), make("span", "text", text));
    b.title = text;
    b.disabled = Boolean(disabled);
    onClick(b, fn);
    ui.menu.append(b);
  }

  function muted(text) {
    ui.menu.append(make("div", "muted", text));
  }

  function renderMenu() {
    const scroll = ui.menu.scrollTop; // the 1 s poll re-renders an open menu
    ui.menu.replaceChildren();
    if (!view) return muted("Loading…");
    fillMenu();
    ui.menu.scrollTop = scroll;
  }

  function fillMenu() {
    heading("Output");
    for (const [value, label] of [["separate", "Separate files"], ["merged", "Merged into one file"]]) {
      item(label, currentMode() === value, () => {
        mode = value;
        render();
      });
    }

    const inc = view.incognito || { on: false, forced: false };
    heading("Privacy");
    item(inc.forced ? "Incognito (private window)" : "Incognito", inc.on, () => act({ type: "setIncognito", on: !inc.on }), inc.forced);

    const src = view.source;
    if (src && src.kind === "hls") {
      if (Array.isArray(src.variants) && src.variants.length > 1) {
        heading("Quality");
        src.variants.forEach((v, index) => {
          item(String(v.label || ""), index === src.variant, () => act({ type: "chooseVariant", index }));
        });
      } else if (src.probe && src.probe.state === "pending") {
        heading("Quality");
        muted("Checking the qualities…");
      } else if (src.probe && src.probe.state === "error") {
        heading("Quality");
        muted(String(src.probe.message || "Qualities unavailable."));
      }
    }

    if (Array.isArray(view.sources) && view.sources.length > 1) {
      heading("Source");
      view.sources.forEach((s, index) => {
        const label = [s.kind, s.host, s.file].filter(Boolean).join(" · ");
        item(label, index === view.sourceIndex, () => act({ type: "chooseSource", index }));
      });
    }

    if (Array.isArray(view.videos) && view.videos.length > 1) {
      heading("Video");
      view.videos.forEach((v, index) => {
        const sel = { type: "select", frameId: v.frameId, videoKey: v.videoKey };
        item(String(v.label || ""), index === view.videoIndex, () => act(sel));
      });
    }

    const list = segments();
    heading(`Segments (${list.length})`);
    if (!list.length) muted("None yet.");
    list.forEach((s, index) => {
      const row = make("div", "segrow");
      const text = `${s.done === true ? "✓ " : ""}${index + 1}. ${fmtTime(s.start, true)} – ${fmtTime(s.end, true)}`;
      const del = make("button", null, "×");
      del.setAttribute("aria-label", `Delete segment ${index + 1}`);
      onClick(del, () => act({ type: "removeSegment", index }));
      const label = make("span", "text", text);
      if (s.done === true) label.title = "Downloaded";
      row.append(label, del);
      ui.menu.append(row);
    });
    item("Clear all segments", null, () => act({ type: "clearSegments" }), !list.length);
  }

  // --- hub messages (to "overlay") ---

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || !msg || msg.to !== "overlay") return undefined;
    if (msg.type === "toggleOverlay") return void sync();
    if (!host) return undefined;
    if (msg.type === "markError") note = errorText({ error: msg.error });
    else if (msg.type === "mark") note = "";
    else if (msg.type === "segments" && view && Array.isArray(msg.segments)) view.segments = msg.segments;
    render();
    scheduleRefresh();
    return undefined;
  });

  window.addEventListener("pagehide", unmount);

  agent.onChange = sync;
  sync();
})();
