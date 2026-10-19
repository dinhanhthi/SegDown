// SegDown agent: runs in every frame and owns that frame's <video> elements.
// Talks to the hub in background.js; the message protocol is documented there.
// 3.3: discovery, stable videoKeys, seek/getTime/play/pause/select, ticks.
// 3.4: visible area, score and exclusions (the hub picks across frames).
// 3.6: `[` / `]` mark keys while the panel is open.
// 3.8: compact panel inside this frame's fullscreen element (see below).

"use strict";

(() => {
  const TICK_MS = 250; // at most 4 Hz
  const SCAN_DELAY_MS = 500;
  const MAX_CANDIDATES = 20;
  const MIN_AREA = 200 * 112;
  const MAX_SCORE_DURATION = 3 * 3600;
  // Ad containers, matched per class token so that "thread-container" or
  // "download-container" is not an ad: ima-ad-container / ad-container / any
  // "-ad-container" or "_ad-container" token, a token containing "preroll", or
  // an id containing "google_ads".
  const AD_CLASS_TOKEN = /(^|[-_])ad-container$|preroll/i;
  const MAX_WALK_ELEMENTS = 10000; // per rescan, across the document and open shadow roots
  const MAX_SHADOW_DEPTH = 4;

  const keyOf = new WeakMap(); // video -> videoKey
  const videos = new Map(); // videoKey -> video (pruned on rescan)
  let nextKey = 1;
  let selectedKey = null;
  let lastReport = "[]"; // signature of the last candidates sent (see scan)
  let lastTickAt = 0;
  let tickTimer = null;
  let scanTimer = null;
  let observer = null;
  let panelOpen = false; // from the hub's `state` broadcast; keys are live only while open
  let hubState = null; // last hub `state` (pendingStart for the compact panel)
  let stateSeen = false; // a broadcast beats the boot getState reply
  const observedRoots = new WeakSet(); // open shadow roots already under the observer

  // Throws once the extension reloads ("Extension context invalidated"); ignore.
  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // context gone
    }
  }

  const durationOf = (v) => (Number.isFinite(v.duration) && v.duration >= 0 ? v.duration : null);

  // Part of the video inside this frame's viewport, in CSS px^2.
  function visibleArea(v) {
    const r = v.getBoundingClientRect();
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return Math.round(Math.max(0, w) * Math.max(0, h));
  }

  // The video or an ancestor in its tree (like Element.closest, which stops at
  // a shadow root) is an ad container.
  function inAdContainer(v) {
    for (let el = v; el; el = el.parentElement) {
      if (typeof el.id === "string" && el.id.includes("google_ads")) return true;
      for (const token of el.classList || []) if (AD_CLASS_TOKEN.test(token)) return true;
    }
    return false;
  }

  // One reason, in this order: ad, live, small. "small" is the rendered size,
  // not the visible part, so scrolling the main video away keeps it eligible.
  // The cross-frame "under 30 s when a longer candidate exists" rule lives in the hub.
  function exclusionOf(v) {
    if (inAdContainer(v)) return "ad";
    if (v.duration === Infinity) return "live";
    const r = v.getBoundingClientRect();
    if (r.width * r.height < MIN_AREA) return "small";
    return null;
  }

  function describe(videoKey, v) {
    const area = visibleArea(v);
    const duration = durationOf(v);
    const excluded = exclusionOf(v);
    const out = {
      videoKey,
      area,
      duration,
      live: v.duration === Infinity,
      paused: v.paused,
      excluded,
      score: excluded || duration === null ? 0 : area * Math.min(duration, MAX_SCORE_DURATION),
    };
    const src = v.currentSrc;
    if (/^https?:/i.test(src) && src.length <= 8192) out.currentSrc = src;
    return out;
  }

  function onMediaEvent(e) {
    if (e.type === "loadedmetadata" || e.type === "durationchange" || e.type === "resize") scheduleScan();
    tick(e.currentTarget);
    if (compact.host && keyOf.get(e.currentTarget) === selectedKey) renderCompact();
  }

  function track(v) {
    const known = keyOf.get(v);
    if (known) {
      videos.set(known, v); // re-inserted after a prune: same key, listeners already attached
      return;
    }
    const key = `v${nextKey++}`;
    keyOf.set(v, key);
    videos.set(key, v);
    for (const type of ["loadedmetadata", "durationchange", "resize", "timeupdate", "seeked", "play", "pause"]) {
      v.addEventListener(type, onMediaEvent);
    }
  }

  function observe(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, { childList: true, subtree: true });
  }

  // Videos in the document and in open shadow roots (bounded walk). New shadow
  // roots join the MutationObserver, which does not see inside them otherwise.
  function findVideos() {
    const found = [...document.querySelectorAll("video")];
    let budget = MAX_WALK_ELEMENTS;
    const walk = (root, depth) => {
      for (const el of root.querySelectorAll("*")) {
        if (--budget < 0) return;
        const sr = el.shadowRoot;
        if (!sr) continue;
        observe(sr);
        found.push(...sr.querySelectorAll("video"));
        if (depth < MAX_SHADOW_DEPTH) walk(sr, depth + 1);
      }
    };
    walk(document, 1);
    return found;
  }

  function scan() {
    scanTimer = null;
    for (const v of findVideos()) track(v);
    for (const [key, v] of videos) {
      if (!v.isConnected) {
        videos.delete(key);
        if (key === selectedKey) selectedKey = null;
      }
    }
    if (compact.host) syncCompact(); // the video may be gone
    let list = [...videos].map(([key, v]) => describe(key, v));
    if (list.length > MAX_CANDIDATES) list = list.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
    const sig = signature(list);
    if (sig === lastReport) return;
    lastReport = sig;
    send({ type: "candidates", videos: list });
  }

  // What the hub and the panel use. Scrolling changes the visible area, and so
  // the score, all the time: only a score bucket change (factor ~1.19) or a new
  // order inside this frame re-sends. `paused` is a snapshot and play/pause does
  // not re-send either.
  function signature(list) {
    const bucket = (score) => (score > 0 ? Math.round(Math.log2(score) * 4) : -1);
    const rows = list.map((c) => [c.videoKey, c.duration, c.live, c.excluded, c.currentSrc, bucket(c.score)]);
    const order = [...list].sort((a, b) => b.score - a.score || b.area - a.area).map((c) => c.videoKey);
    return JSON.stringify([rows, order]);
  }

  function scheduleScan() {
    if (scanTimer === null) scanTimer = setTimeout(scan, SCAN_DELAY_MS);
  }

  function sendTick(v) {
    lastTickAt = Date.now();
    send({ type: "tick", videoKey: keyOf.get(v), currentTime: v.currentTime, duration: durationOf(v), paused: v.paused });
  }

  // Only the open panel draws ticks (the compact panel reads the video itself).
  // Throttled to TICK_MS with a trailing tick, so the last state always arrives.
  function tick(v) {
    if (!panelOpen || !v || keyOf.get(v) !== selectedKey) return;
    const wait = TICK_MS - (Date.now() - lastTickAt);
    if (wait <= 0) return sendTick(v);
    if (tickTimer !== null) return;
    tickTimer = setTimeout(() => {
      tickTimer = null;
      const cur = videos.get(selectedKey);
      if (cur && panelOpen) sendTick(cur);
    }, wait);
  }

  const isTime = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

  function handle(msg) {
    if (msg.type === "select") {
      selectedKey = typeof msg.videoKey === "string" && videos.has(msg.videoKey) ? msg.videoKey : null;
      if (selectedKey) tick(videos.get(selectedKey));
      return { ok: msg.videoKey === null || selectedKey !== null };
    }
    const v = typeof msg.videoKey === "string" ? videos.get(msg.videoKey) : undefined;
    if (!v || !v.isConnected) return { ok: false, error: "no-video" };
    switch (msg.type) {
      case "getTime":
        return { ok: true, currentTime: v.currentTime, duration: durationOf(v), paused: v.paused };
      case "seek": {
        if (!isTime(msg.time)) return { ok: false, error: "bad-time" };
        const d = durationOf(v);
        v.currentTime = d === null ? msg.time : Math.min(msg.time, d);
        return { ok: true };
      }
      case "play":
        v.play().catch(() => {}); // autoplay policy may refuse
        return { ok: true };
      case "pause":
        v.pause();
        return { ok: true };
      default:
        return { ok: false, error: "unknown-type" };
    }
  }

  function applyHubState(state) {
    if (!state || typeof state !== "object") return;
    hubState = state;
    const wasOpen = panelOpen;
    panelOpen = state.panelOpen === true;
    if (panelOpen && !wasOpen && selectedKey) tick(videos.get(selectedKey)); // the panel's first playhead
    syncCompact();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg) return undefined;
    if (msg.to === "all" && msg.type === "state") {
      stateSeen = true;
      applyHubState(msg.state);
      return undefined;
    }
    if (msg.to === "compact") {
      onCompactMessage(msg);
      return undefined;
    }
    if (msg.to !== "agent") return undefined;
    sendResponse(handle(msg));
    if (msg.type === "select") syncCompact();
    return undefined;
  });

  // --- fullscreen compact panel (3.8) ---
  //
  // In fullscreen only document.fullscreenElement and its descendants are
  // rendered, so the top-frame panel is gone (panel.js hides it). While the
  // panel is open and this frame's fullscreenElement contains the selected
  // video, a compact panel (timeline, Mark start / Mark end, one status line)
  // mounts inside that element, in its own closed shadow root. It always sits
  // in the video's frame, so it draws the playhead from the video itself and
  // seeks it directly. Marks go through the hub's `key` like the keyboard, so
  // they show in both panels; the hub relays `mark` / `markError` / `segments`
  // (the top panel's list) here as `to: "compact"`, and `state` brings
  // pendingStart.
  // Limitations: when the <video> itself is the fullscreenElement there is
  // nowhere to mount (a video renders no children), so nothing shows and only
  // the `[` / `]` keys mark (most players fullscreen a container div). When a
  // parent frame fullscreens the iframe that holds the video, this document has
  // no fullscreenElement and the parent cannot tell which video is selected, so
  // there is no compact panel either.

  const COMPACT_TIMELINE_W = 260;
  const COMPACT_TIMELINE_H = 24;
  const COMPACT_ERRORS = {
    "no-selection": "No video selected.",
    "no-video": "The video is gone.",
    "no-start": "Mark a start first.",
    "end-not-after-start": "The end must be after the start.",
    "selection-changed": "The video changed; mark again.",
  };
  // Players toggle play/pause or fullscreen on clicks and keys: keep them out.
  const ISOLATED_EVENTS = [
    "click", "dblclick", "contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup",
    "wheel", "keydown", "keyup", "keypress", "focusin", "focusout",
  ];
  const COMPACT_CSS = `
    :host { all: initial; }
    .box {
      box-sizing: border-box; width: ${COMPACT_TIMELINE_W + 24}px; padding: 8px 12px;
      display: flex; flex-direction: column; gap: 6px;
      background: rgba(28, 28, 30, 0.92); color: #f2f2f7; border: 1px solid #3a3a3c; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      user-select: none; -webkit-user-select: none;
    }
    canvas { display: block; width: ${COMPACT_TIMELINE_W}px; height: ${COMPACT_TIMELINE_H}px; cursor: pointer; }
    .row { display: flex; gap: 6px; }
    button {
      flex: 1; padding: 4px 0; font: inherit; color: inherit; cursor: pointer;
      border-radius: 6px; border: 1px solid #48484a; background: #2c2c2e;
    }
    button:hover:not(:disabled) { background: #3a3a3c; }
    button:disabled { opacity: 0.45; cursor: default; }
    .status { color: #aeaeb2; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status.warn { color: #ffd60a; }
  `;

  const compact = { host: null, segments: [], error: "" }; // DOM refs while mounted

  // 75 -> "1:15", 3725 -> "1:02:05"; tenths adds ".s" (same as panel.js).
  function fmtTime(sec, tenths) {
    if (typeof sec !== "number" || !Number.isFinite(sec)) return "-:--";
    const total = tenths ? Math.floor(sec * 10) / 10 : Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = tenths ? s.toFixed(1).padStart(4, "0") : String(s).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  // Also true when `node` sits in an open shadow root under `ancestor`.
  function containsDeep(ancestor, node) {
    for (let n = node; n; n = n.parentNode || n.host) if (n === ancestor) return true;
    return false;
  }

  // The node to mount in, or null. A custom-element player with an open shadow
  // root would not render a light-DOM child, so mount in its root.
  function compactParent() {
    const fse = document.fullscreenElement;
    const v = selectedKey ? videos.get(selectedKey) : null;
    if (!panelOpen || !fse || !v || fse === v || !containsDeep(fse, v)) return null;
    return fse.shadowRoot || fse;
  }

  // Mounts, moves (a player may re-render its children) or unmounts.
  function syncCompact() {
    const parent = compactParent();
    if (compact.host && compact.host.parentNode !== parent) unmountCompact();
    if (parent && !compact.host) mountCompact(parent);
    if (compact.host) renderCompact();
  }

  function mountCompact(parent) {
    const host = document.createElement("segdown-compact");
    for (const [k, v] of [
      ["all", "initial"],
      ["position", "fixed"],
      ["z-index", "2147483647"],
      ["left", "16px"],
      ["bottom", "72px"], // above most players' native controls
      ["display", "block"],
    ]) {
      host.style.setProperty(k, v, "important");
    }
    for (const type of ISOLATED_EVENTS) host.addEventListener(type, (e) => e.stopPropagation());
    const root = host.attachShadow({ mode: "closed" });
    const make = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const canvas = make("canvas");
    canvas.setAttribute("aria-label", "Timeline");
    canvas.addEventListener("click", onCompactTimelineClick);
    const start = make("button", null, "Mark start");
    const end = make("button", null, "Mark end");
    start.addEventListener("click", () => send({ type: "key", action: "markStart" }));
    end.addEventListener("click", () => send({ type: "key", action: "markEnd" }));
    const row = make("div", "row");
    row.append(start, end);
    const status = make("div", "status");
    const box = make("div", "box");
    box.append(canvas, row, status);
    const style = make("style", null, COMPACT_CSS);
    root.append(style, box);
    Object.assign(compact, { host, canvas, start, end, status, error: "" });
    parent.append(host);
    // The frame may have been selected after the last `segments` relay.
    try {
      chrome.runtime.sendMessage({ type: "getState" }).then(
        (r) => {
          if (!r || !r.ok || !compact.host) return;
          if (Array.isArray(r.segments)) compact.segments = r.segments;
          renderCompact();
        },
        () => {}
      );
    } catch {
      // context gone
    }
  }

  function unmountCompact() {
    compact.host.remove();
    compact.host = null;
  }

  function onCompactMessage(msg) {
    if (msg.type === "segments" && Array.isArray(msg.segments)) compact.segments = msg.segments;
    else if (msg.type === "mark") compact.error = "";
    else if (msg.type === "markError") compact.error = COMPACT_ERRORS[msg.error] || `Mark failed (${String(msg.error)}).`;
    if (compact.host) renderCompact();
  }

  function onCompactTimelineClick(e) {
    const v = videos.get(selectedKey);
    const d = v ? durationOf(v) : null;
    const r = compact.canvas.getBoundingClientRect();
    if (!d || !(r.width > 0)) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    handle({ type: "seek", videoKey: selectedKey, time: frac * d });
    renderCompact();
  }

  function drawCompactTimeline(t, d, pendingStart) {
    const W = COMPACT_TIMELINE_W;
    const H = COMPACT_TIMELINE_H;
    const canvas = compact.canvas;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr)) canvas.width = Math.round(W * dpr);
    if (canvas.height !== Math.round(H * dpr)) canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const top = 5;
    const barH = H - 10;
    ctx.fillStyle = "#3a3a3c";
    ctx.fillRect(0, top, W, barH);
    if (!d) return;
    const x = (sec) => Math.max(0, Math.min(W, (sec / d) * W));
    ctx.fillStyle = "#56565a"; // played part
    ctx.fillRect(0, top, x(t), barH);
    ctx.fillStyle = "rgba(10, 132, 255, 0.75)";
    for (const seg of compact.segments) {
      if (isTime(seg.start) && isTime(seg.end)) ctx.fillRect(x(seg.start), top, Math.max(2, x(seg.end) - x(seg.start)), barH);
    }
    if (pendingStart !== null) {
      ctx.fillStyle = "#30d158";
      ctx.fillRect(x(pendingStart) - 1, top - 4, 2, barH + 8);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x(t) - 1, 0, 2, H);
  }

  function renderCompact() {
    const v = videos.get(selectedKey);
    if (!compact.host || !v) return;
    const d = durationOf(v);
    const t = v.currentTime;
    const ps = hubState && isTime(hubState.pendingStart) ? hubState.pendingStart : null;
    drawCompactTimeline(t, d, ps);
    compact.start.disabled = compact.end.disabled = v.duration === Infinity; // live
    const n = compact.segments.length;
    let text = `${fmtTime(t)} / ${fmtTime(d)} · ${n} segment${n === 1 ? "" : "s"}`;
    if (ps !== null) text += ` · start ${fmtTime(ps, true)}`;
    compact.status.textContent = compact.error || text;
    compact.status.classList.toggle("warn", Boolean(compact.error));
  }

  document.addEventListener("fullscreenchange", syncCompact);

  // --- keyboard (3.6) ---

  const KEY_ACTIONS = { "[": "markStart", "]": "markEnd" };

  // Keys typed into a text field belong to it. composedPath()[0] sees inside
  // the page's open shadow roots; the SegDown panel's root is closed, so its
  // host is the target there and the panel says whether one of its fields has
  // focus (panel.js shares this frame's isolated world).
  // A page's closed shadow root hides its focused element the same way: the
  // target is then the host. Two tiers:
  // - chrome.dom.openOrClosedShadowRoot (Chrome 88+, content scripts): descend
  //   through the focused element's shadow roots, open or closed, to the element
  //   that really has focus, then apply the text-field check to it.
  // - without that API (e.g. Safari): a custom element (name with "-") without a
  //   reachable shadowRoot counts as typing, since closed roots live on custom
  //   elements in practice. Known false positive: while a focusable light-DOM
  //   custom element has focus (e.g. <video-js tabindex="-1">), `[` / `]` are
  //   left to the page and do not mark.
  // The SegDown hosts are exempt (the panel is asked above; the compact panel
  // has buttons only).
  function shadowRootOf(t) {
    try {
      return chrome.dom.openOrClosedShadowRoot(t) || null;
    } catch {
      return null;
    }
  }

  function isTextField(t) {
    return t.isContentEditable || ["input", "textarea", "select"].includes(t.localName);
  }

  function typingTarget(e) {
    let t = e.composedPath()[0] || e.target;
    if (!t || t.nodeType !== 1) return false;
    if (t.localName === "segdown-panel") {
      const hasFocus = window.segdownPanelHasTextFocus;
      return typeof hasFocus !== "function" || hasFocus();
    }
    if (t.localName === "segdown-compact") return false;
    const api = typeof chrome !== "undefined" && chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === "function";
    if (!api) return (t.localName.includes("-") && !t.shadowRoot) || isTextField(t);
    for (let depth = 0; depth < 32; depth++) {
      const root = shadowRootOf(t);
      const inner = root && root.activeElement;
      if (!inner || inner.nodeType !== 1) break;
      t = inner;
    }
    return isTextField(t);
  }

  function onKeyDown(e) {
    if (!e.isTrusted) return; // a page can dispatch synthetic keydown events
    const action = KEY_ACTIONS[e.key];
    if (!panelOpen || !action || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (typingTarget(e)) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.repeat) return; // holding the key marks once
    send({ type: "key", action }); // the hub relays the result or error to the panel
  }

  window.addEventListener("keydown", onKeyDown, true);

  // A frame that loads after the panel opened missed the broadcast.
  function requestState() {
    try {
      chrome.runtime.sendMessage({ type: "getState" }).then(
        (r) => {
          if (!stateSeen && r && r.ok) applyHubState(r.state);
        },
        () => {}
      );
    } catch {
      // context gone
    }
  }

  // Leaving the page (or entering the back/forward cache): the hub drops this
  // frame's videos, also when an iframe is removed without a navigation event.
  window.addEventListener("pagehide", () => {
    lastReport = "[]";
    send({ type: "candidates", videos: [] });
  });

  // Back/forward cache restore: the top-frame commit cleared the hub's tab state
  // and this script does not run again, so report everything anew.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    lastReport = null;
    selectedKey = null; // the hub sends `select` again after its auto-pick
    stateSeen = false;
    requestState();
    scheduleScan();
  });

  requestState();

  observer = new MutationObserver(scheduleScan);
  observe(document.documentElement);
  // scheduleScan coalesces bursts into one rescan per SCAN_DELAY_MS.
  window.addEventListener("resize", scheduleScan, { passive: true });
  window.addEventListener("scroll", scheduleScan, { passive: true });
  scan();
})();
