// SegDown player buttons: run in every frame and show up to two small buttons
// side by side at the top-left of the eligible video under the pointer
// (agent.eligible(): not an ad, not live, not small, finite duration). The
// SegDown icon opens the overlay on that video through the hub's `openOverlay`;
// "Download full video" downloads the whole video through the hub's
// `downloadFull`. When the hub's `fullOptions` has a quality list for it (HLS
// variants or the page's heights) that click opens a small menu with the
// overlay's default highlighted, else it downloads at once; a check mark or a
// short error line shows the reply (the protocol is documented in
// background.js). `fullOptions` is asked from the hub's cache when the buttons
// appear; a probe (probe: true, it may run yt-dlp) is asked only when the
// pointer enters the Download button or on a click while no list is known.
// One host per frame, in a closed shadow root shown in the top layer
// (popover="manual"), so it stays above the page and every kind of fullscreen.
// Each button follows its own app switch (playerButton, fullDownloadButton);
// the host is hidden while both are off and on an ignored site (Ignored sites).
// On the video whose overlay is open (or opening after its click) the SegDown
// icon is left out and Download full stays, in its own place.
// Page data is untrusted: the DOM is built from constants only (SVG via
// createElementNS, no page strings; the menu labels are the hub's own strings
// built from numbers, set with textContent), handlers act on trusted events
// only, and the hub gets a videoKey (and an index into its own list) only (the
// frame comes from the sender).
// Loads once per agent; tears down for good once the agent is orphaned (an
// extension update), and hides the hosts of older, orphaned copies.

"use strict";

(() => {
  const agent = globalThis.segdownAgent;
  if (!agent || typeof agent.eligible !== "function" || typeof agent.ui !== "function") return;
  if (agent.buttonLoaded) return; // a re-injection next to this live agent
  agent.buttonLoaded = true;

  const HIDE_MS = 2000; // auto-hide after the mouse stops over the video
  const MIN_TICK_MS = 500; // the hide re-check while the pointer rests on the buttons
  const BLOCK_MS = 1000; // after a click, until the hub's `state` marks the overlay open
  const CHECK_MS = 1500; // the check mark after a download started
  const ERROR_MS = 4000; // the error line under the buttons
  const POLL_MS = 1000; // fullOptions re-asked while the menu waits for the qualities
  const MAX_POLLS = 60;
  const MAX_OPTIONS = 32; // cached fullOptions replies, all dropped when full
  const MAX_ITEMS = 128; // menu entries at most (the hub keeps fewer)
  const SIZE = 28; // px
  const GAP = 6; // px between the two buttons
  const OFFSET = 8; // px from the video's top-left corner
  const MENU_GAP = 4; // px between the buttons and the menu / error line
  const EDGE = 4; // px kept from the viewport's edges by the menu / error line
  const MAX_CLIP_WALK = 15; // ancestors read for a clipping card (visibleRect)
  const MAX_CLIPS = 3;
  const MAX_HEADER_WALK = 10; // ancestors of the probe hit read for a header
  const CLIPPING = new Set(["hidden", "clip"]);
  const SVG_NS = "http://www.w3.org/2000/svg";
  // Players toggle play/pause or fullscreen on clicks and keys: keep them out.
  const ISOLATED_EVENTS = [
    "click", "dblclick", "contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup",
    "wheel", "keydown", "keyup", "keypress", "focusin", "focusout",
  ];
  // Wording of overlay.js where it has the same error.
  const ERRORS = {
    "no-video": "The video is gone.",
    "no-source": "No video source found on this page.",
    drm: "This video is DRM-protected: SegDown can't download it.",
    "no-duration": "The video's duration is unknown.",
    "over-limit": "The video is longer than the Max total duration in SegDown Settings.",
    "no-reply": "SegDown did not answer. Reload the page.",
    ignored: "SegDown is off on this site.",
    "options-changed": "The qualities changed. Try again.",
    "app-unreachable": "SegDown app not reachable.",
    "copy-only": "Open SegDown (its icon) to copy this stream's link.",
    "inline-only": "This stream exists only in the page: it needs the SegDown app.",
    "private-window": "The browser download is off in a private window.",
    "browser-download": "The browser refused the download.",
  };
  // Undoes the page's and the popover UA styles on the host (left / top / width
  // are set on each show); the buttons and the menu inside opt back into pointer
  // events. The menu and the error line overflow the host (overflow visible).
  const HOST_STYLE = [
    ["position", "fixed"],
    ["right", "auto"],
    ["bottom", "auto"],
    ["width", `${SIZE}px`],
    ["height", `${SIZE}px`],
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
    ["visibility", "hidden"],
    ["z-index", "2147483647"], // the fallback without popover support
  ];
  const CSS = `
    .wrap { all: initial; position: absolute; inset: 0; display: block; pointer-events: none; }
    [hidden] { display: none !important; }
    .btn {
      all: unset; box-sizing: border-box; position: absolute; top: 0; left: 0; width: ${SIZE}px; height: ${SIZE}px;
      display: flex; align-items: center; justify-content: center; border-radius: 50%; cursor: pointer;
      background: rgba(28, 28, 30, 0.9); border: 1px solid #3a3a3c; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      pointer-events: auto;
    }
    .btn:hover { background: #3a3a3c; }
    .btn:focus-visible { outline: 2px solid #0a84ff; }
    .btn.busy { opacity: 0.5; cursor: progress; }
    .btn.busy:hover { background: rgba(28, 28, 30, 0.9); }
    svg { display: block; width: 18px; height: 18px; pointer-events: none; }
    .menu, .msg {
      position: absolute; left: 0; top: 0; box-sizing: border-box; max-width: 260px;
      background: rgba(28, 28, 30, 0.95); border: 1px solid #3a3a3c; border-radius: 8px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); color: #fff;
      font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    .menu { pointer-events: auto; width: max-content; min-width: 160px; padding: 4px; overflow-y: auto; overscroll-behavior: contain; }
    .item {
      all: unset; box-sizing: border-box; display: flex; gap: 6px; width: 100%; padding: 4px 8px;
      border-radius: 5px; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    .item:hover { background: #3a3a3c; }
    .item:focus-visible, .item.def { outline: 2px solid #0a84ff; outline-offset: -2px; }
    .item .check { width: 12px; flex: none; color: #0a84ff; }
    .item .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .muted { display: flex; align-items: center; gap: 6px; padding: 4px 8px; color: #8e8e93; white-space: nowrap; }
    .spin {
      width: 10px; height: 10px; flex: none; box-sizing: border-box; border: 2px solid #8e8e93;
      border-right-color: transparent; border-radius: 50%; opacity: 0;
      animation: spin-in 0.2s linear 150ms forwards, spin-turn 0.8s linear infinite;
    }
    @keyframes spin-in { to { opacity: 1; } }
    @keyframes spin-turn { to { transform: rotate(360deg); } }
    .msg { pointer-events: none; width: max-content; padding: 5px 8px; overflow: hidden; color: #ff6961; }
  `;
  // The logo's glyph on a 24 px grid: a strip with a marked segment between two
  // handles, and a down arrow under it.
  const GLYPH = [
    ["rect", { x: "2.75", y: "3.75", width: "18.5", height: "8", rx: "2", fill: "none", stroke: "#fff", "stroke-width": "1.5" }],
    ["rect", { x: "8", y: "3.75", width: "8", height: "8", fill: "#0a84ff" }],
    ["path", { d: "M8 2.5v10.5M16 2.5v10.5", fill: "none", stroke: "#fff", "stroke-width": "1.75", "stroke-linecap": "round" }],
    ["path", { d: "M10.5 13.5h3v3.5H16l-4 4.5-4-4.5h2.5z", fill: "#fff" }],
  ];
  const LINE = { fill: "none", stroke: "#fff", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round" };
  // Download full video: a down arrow into a tray.
  const DOWNLOAD_GLYPH = [
    ["path", { d: "M12 3.5v11M7.5 10.5 12 15l4.5-4.5", ...LINE }],
    ["path", { d: "M4 15v3.25c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V15", ...LINE }],
  ];
  // The download started.
  const CHECK_GLYPH = [["path", { d: "M5 12.5l4.5 4.5L19 7.5", ...LINE, stroke: "#30d158", "stroke-width": "2.25" }]];

  let host = null; // built on first show
  let wrap = null;
  let button = null; // SegDown (opens the overlay)
  let fullButton = null; // Download full video
  let downGlyph = null;
  let okGlyph = null;
  let menu = null;
  let errorLine = null;
  let shown = false;
  let target = null; // {videoKey, video, probed?} the buttons are on while shown
  let lastMove = 0; // the last pointer move over the target
  let opening = null; // the video whose SegDown icon was clicked, until blockedUntil
  let blockedUntil = 0;
  let hideTimer = null;
  let frame = 0;
  let pointX = 0;
  let pointY = 0;
  let hostLeft = 0; // px, the host's place and width (show, layout)
  let hostTop = 0;
  let hostWidth = SIZE;
  let layoutKey = ""; // the switches the buttons are laid out for
  const options = new Map(); // videoKey -> {n, r}: the newest fullOptions reply
  let asked = 0; // fullOptions requests sent: a late reply never replaces a newer one
  let menuKey = null; // the videoKey whose menu is open
  let menuSig = ""; // what the open menu shows (re-rendered only on a change)
  let pollTimer = null;
  let polls = 0;
  let busy = 0; // the pending downloadFull's number, 0 when none
  let downloads = 0;
  let feedbackTimer = null; // the check mark or the error line shows
  let dead = false; // the agent is orphaned: torn down, never shows again

  // The hub's reply is not needed; errors (also "Extension context invalidated"
  // once the extension reloads) are ignored.
  function ask(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // context gone
    }
  }

  // -> the hub's reply, or {ok: false, error: "no-reply"} (also once the
  // extension reloads: "Extension context invalidated").
  function request(msg) {
    const fail = { ok: false, error: "no-reply" };
    try {
      return chrome.runtime.sendMessage(msg).then((r) => (r && typeof r === "object" ? r : fail), () => fail);
    } catch {
      return Promise.resolve(fail);
    }
  }

  function errorText(r) {
    if (typeof r.message === "string" && r.message) return r.message;
    return ERRORS[r.error] || `Failed (${String(r.error)}).`;
  }

  const overlayOn = (v) => {
    const st = agent.state();
    return Boolean(st && st.panelOpen === true && agent.video() === v);
  };

  // The SegDown icon shows on v: its switch is on, v's overlay is not open and
  // not opening after a click.
  const iconOn = (v) => agent.ui().playerButton && !overlayOn(v) && !(v === opening && Date.now() < blockedUntil);
  // At least one button shows on v.
  const anyOn = (v) => iconOn(v) || agent.ui().fullDownloadButton;

  // At least one button is switched on, on a site that is not ignored.
  const wanted = () => {
    const u = agent.ui();
    return !u.ignored && (u.playerButton || u.fullDownloadButton);
  };

  // The menu, the busy state or the feedback keeps the buttons where they are.
  const stuck = () => menuKey !== null || busy !== 0 || feedbackTimer !== null;

  // A list to pick from: more than one label, nothing pending.
  function listOf(r) {
    if (!r || r.ok !== true || r.pending !== false) return null;
    if (r.kind !== "heights" && r.kind !== "variants") return null;
    if (!Array.isArray(r.items) || r.items.length < 2 || r.items.length > MAX_ITEMS) return null;
    return r.items.every((s) => typeof s === "string") ? r : null;
  }

  // The hub's last word for the video: a list, no list possible, or an error.
  const settled = (r) => Boolean(r) && (r.ok !== true || r.pending === false);

  const optionsOf = (videoKey) => {
    const e = options.get(videoKey);
    return e ? e.r : null;
  };

  // --- DOM ---

  function glyph(parts) {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of [["viewBox", "0 0 24 24"], ["width", "18"], ["height", "18"], ["aria-hidden", "true"], ["focusable", "false"]]) {
      svg.setAttribute(k, v);
    }
    for (const [tag, attrs] of parts) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    }
    return svg;
  }

  function build() {
    host = document.createElement("segdown-button");
    for (const [k, v] of HOST_STYLE) host.style.setProperty(k, v, "important");
    host.setAttribute("popover", "manual");
    for (const type of ISOLATED_EVENTS) host.addEventListener(type, (e) => e.stopPropagation());
    const root = host.attachShadow({ mode: "closed" });
    wrap = document.createElement("div");
    wrap.className = "wrap";
    // Clicks must not move the keyboard focus here: keys stay with the player.
    wrap.addEventListener("mousedown", (e) => e.preventDefault());
    button = document.createElement("button");
    button.className = "btn";
    button.setAttribute("aria-label", "SegDown");
    button.title = "SegDown";
    button.append(glyph(GLYPH));
    button.addEventListener("click", (e) => {
      if (e.isTrusted) onButtonClick();
    });
    fullButton = document.createElement("button");
    fullButton.className = "btn";
    fullButton.setAttribute("aria-label", "Download full video");
    fullButton.title = "Download full video";
    downGlyph = glyph(DOWNLOAD_GLYPH);
    okGlyph = glyph(CHECK_GLYPH);
    okGlyph.toggleAttribute("hidden", true);
    fullButton.append(downGlyph, okGlyph);
    fullButton.addEventListener("pointerenter", (e) => {
      if (e.isTrusted) probe();
    });
    fullButton.addEventListener("click", (e) => {
      if (e.isTrusted) onFullClick();
    });
    menu = document.createElement("div");
    menu.className = "menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Download full video");
    menu.hidden = true;
    errorLine = document.createElement("div");
    errorLine.className = "msg";
    errorLine.setAttribute("role", "status");
    errorLine.hidden = true;
    wrap.append(button, fullButton, menu, errorLine);
    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(style, wrap);
  }

  // Shows the buttons whose switch is on, side by side, SegDown first. The
  // icon's slot stays while it is left out (iconOn), so Download full never
  // slides under the pointer that just clicked the icon.
  const layoutKeyOf = () => {
    const u = agent.ui();
    return `${u.playerButton} ${u.fullDownloadButton} ${iconOn(target.video)}`;
  };

  function layout() {
    const u = agent.ui();
    layoutKey = layoutKeyOf();
    button.hidden = !iconOn(target.video);
    fullButton.hidden = !u.fullDownloadButton;
    fullButton.style.left = u.playerButton ? `${SIZE + GAP}px` : "0px";
    const n = Number(u.playerButton) + Number(u.fullDownloadButton);
    hostWidth = SIZE * n + GAP * Math.max(n - 1, 0);
    host.style.setProperty("width", `${hostWidth}px`, "important");
    if (!u.fullDownloadButton) resetFull();
  }

  // el.contains(video), also through the shadow roots the video sits in.
  function holds(el, video) {
    for (let n = video; n; n = n.getRootNode().host) if (el.contains(n)) return true;
    return false;
  }

  // The top-left of the video's visible part: r clipped by the first MAX_CLIPS
  // overflow hidden / clip ancestors (a card that crops the video), then moved
  // below a fixed or sticky full-width header over it (one elementFromPoint). An
  // ancestor of the video (a player in theater or web fullscreen) is never a
  // header. Fullscreen keeps r.
  function visibleRect(video, r) {
    if (document.fullscreenElement || document.webkitFullscreenElement) return r;
    let { left, top, right, bottom } = r;
    let clips = 0;
    for (let el = video.parentElement, n = 0; el && el !== document.body && n < MAX_CLIP_WALK && clips < MAX_CLIPS; el = el.parentElement, n++) {
      const s = getComputedStyle(el);
      if (!CLIPPING.has(s.overflowX) && !CLIPPING.has(s.overflowY)) continue;
      clips++;
      const c = el.getBoundingClientRect();
      const l = Math.max(left, c.left);
      const t = Math.max(top, c.top);
      const rt = Math.min(right, c.right);
      const b = Math.min(bottom, c.bottom);
      if (rt > l && b > t) [left, top, right, bottom] = [l, t, rt, b]; // empty: keep the rect
    }
    const x = (Math.max(left, 0) + Math.min(right, window.innerWidth)) / 2;
    const cx = Math.max(0, Math.min(x, window.innerWidth - 1));
    const y = Math.max(0, Math.min(top, window.innerHeight - 2));
    const hit = document.elementFromPoint(cx, y + 1);
    if (!hit || hit.localName === "segdown-button" || hit.localName === "segdown-overlay") return { left, top };
    for (let el = hit, n = 0; el && n <= MAX_HEADER_WALK; el = el.parentElement, n++) {
      if (holds(el, video)) break;
      const pos = getComputedStyle(el).position;
      if (pos !== "fixed" && pos !== "sticky") continue;
      const h = el.getBoundingClientRect();
      if (h.top > 1 || h.width < 0.9 * window.innerWidth) continue;
      if (h.bottom > top) top = h.bottom;
      break;
    }
    return { left, top };
  }

  let rectKey = ""; // the video's rect at the last position(): a move or resize re-places the host

  function position(video, r) {
    rectKey = `${r.left} ${r.top} ${r.width} ${r.height}`;
    const p = visibleRect(video, r);
    hostLeft = Math.max(0, Math.min(Math.max(p.left, 0) + OFFSET, window.innerWidth - hostWidth));
    hostTop = Math.max(0, Math.min(Math.max(p.top, 0) + OFFSET, window.innerHeight - SIZE));
    host.style.setProperty("left", `${hostLeft}px`, "important");
    host.style.setProperty("top", `${hostTop}px`, "important");
  }

  // While shown: the switches or the icon changed -> lay the buttons out again;
  // the video moved or resized (a player that lays out again on its first play)
  // -> place them again; none left on the video -> hide.
  function relayout() {
    if (!anyOn(target.video)) return hide();
    const r = target.video.getBoundingClientRect();
    const moved = `${r.left} ${r.top} ${r.width} ${r.height}` !== rectKey;
    if (layoutKeyOf() === layoutKey && !moved) return;
    if (layoutKeyOf() !== layoutKey) layout();
    position(target.video, r);
    if (menuKey !== null) place(menu);
    if (!errorLine.hidden) place(errorLine);
  }

  // Under the buttons, or above them when there is more room there; inside the
  // viewport (scrolls when taller than the room). Host-relative, from viewport
  // coordinates.
  function place(el) {
    el.style.maxHeight = "none";
    el.style.left = "0px";
    el.style.top = `${SIZE + MENU_GAP}px`;
    const below = window.innerHeight - EDGE - (hostTop + SIZE + MENU_GAP);
    const above = hostTop - MENU_GAP - EDGE;
    const h = el.offsetHeight;
    const up = h > below && above > below;
    const room = Math.max(0, up ? above : below);
    if (h > room) el.style.maxHeight = `${room}px`;
    if (up) el.style.top = `${-MENU_GAP - Math.min(h, room)}px`;
    const x = Math.max(EDGE, Math.min(hostLeft, window.innerWidth - EDGE - el.offsetWidth));
    el.style.left = `${x - hostLeft}px`;
  }

  // --- orphan teardown ---

  // True once the agent is orphaned (an extension reload or update); the first
  // call that notices tears down: host, timers, frame and every listener, so
  // nothing shows again. Checked on the pointer's frame and the hide tick.
  function gone() {
    if (dead) return true;
    if (typeof agent.alive !== "function" || agent.alive()) return false;
    dead = true;
    hide();
    if (host) {
      resetFull(); // the menu's timer and listeners, the feedback timer
      host.remove();
    }
    clearTimeout(hideTimer);
    hideTimer = null;
    cancelAnimationFrame(frame);
    frame = 0;
    window.removeEventListener("keydown", onMenuKey, true);
    window.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("mousemove", onMove, { capture: true });
    window.removeEventListener("scroll", hide, { capture: true });
    document.removeEventListener("fullscreenchange", hide);
    document.removeEventListener("webkitfullscreenchange", hide);
    window.removeEventListener("pagehide", hide);
    return true;
  }

  // Older copies left by an extension update keep re-showing their own host:
  // hide those (never remove them, they would append it again).
  function hideOthers() {
    for (const el of document.querySelectorAll("segdown-button")) {
      if (el !== host) el.style.setProperty("display", "none", "important");
    }
  }

  // --- show / hide ---

  // (Re-)enters the top layer last, so it sits above a fullscreen element and
  // above an overlay that opened after it.
  function raise() {
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {
      // no popover support: the fixed host with the top z-index stays
    }
  }

  function show(r) {
    if (gone()) return;
    if (!host) build();
    if (!host.isConnected) document.documentElement.append(host);
    hideOthers();
    layout();
    position(target.video, r);
    host.style.setProperty("visibility", "visible", "important");
    raise();
    shown = true;
    scheduleHide();
    if (agent.ui().fullDownloadButton) askOptions(target.videoKey, false);
  }

  function hide() {
    if (!shown) return;
    shown = false;
    resetFull();
    target = null;
    clearTimeout(hideTimer);
    hideTimer = null;
    host.style.setProperty("visibility", "hidden", "important");
    try {
      host.hidePopover();
    } catch {
      // not open, or no popover support
    }
  }

  function scheduleHide() {
    if (hideTimer === null) hideTimer = setTimeout(onHideTick, HIDE_MS);
  }

  // One pending timeout that re-checks the idle time (no reset on every move).
  // Never an idle hide while the menu, the busy state or the feedback shows.
  function onHideTick() {
    hideTimer = null;
    if (gone() || !shown) return;
    if (!wanted() || !target.video.isConnected) return hide();
    relayout();
    if (!shown) return;
    if (stuck() || wrap.matches(":hover")) {
      hideTimer = setTimeout(onHideTick, MIN_TICK_MS);
      return;
    }
    const idle = Date.now() - lastMove;
    if (idle >= HIDE_MS) return hide();
    hideTimer = setTimeout(onHideTick, Math.max(HIDE_MS - idle, MIN_TICK_MS));
  }

  // --- pointer ---

  // The eligible video under the point, the smallest if several overlap; a
  // video with no button to show (its overlay open, Download full off) does not
  // count.
  function hitTest(x, y) {
    let best = null;
    let bestArea = Infinity;
    for (const c of agent.eligible()) {
      const r = c.video.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea && anyOn(c.video)) {
        best = { videoKey: c.videoKey, video: c.video, rect: r };
        bestArea = area;
      }
    }
    return best;
  }

  function onFrame() {
    frame = 0;
    if (gone()) return;
    if (!wanted()) return hide();
    if (shown) relayout();
    const hit = hitTest(pointX, pointY);
    if (!hit) return;
    if (shown && hit.video === target.video) {
      lastMove = Date.now();
      return;
    }
    if (shown && stuck()) return;
    target = { videoKey: hit.videoKey, video: hit.video };
    lastMove = Date.now();
    show(hit.rect);
  }

  // Only stores the point: the hit test runs once per animation frame.
  function onMove(e) {
    if (!e.isTrusted) return;
    pointX = e.clientX;
    pointY = e.clientY;
    if (!frame) frame = requestAnimationFrame(onFrame);
  }

  // Drops the icon at once (the hub's `state` marks the overlay open later);
  // Download full stays.
  function onButtonClick() {
    if (!shown) return;
    opening = target.video;
    blockedUntil = Date.now() + BLOCK_MS;
    ask({ type: "openOverlay", videoKey: target.videoKey });
    relayout();
  }

  // --- Download full video ---

  // probe: false reads the hub's cache only; true may start the native probe.
  function askOptions(videoKey, probe) {
    const n = ++asked;
    request(probe ? { type: "fullOptions", videoKey, probe: true } : { type: "fullOptions", videoKey }).then((r) => {
      const old = options.get(videoKey);
      if (old && old.n > n) return;
      if (!old && options.size >= MAX_OPTIONS) options.clear();
      options.set(videoKey, { n, r });
      if (menuKey === videoKey) renderMenu();
    });
  }

  // Once per target: on pointer-enter, or on a click while no list is known.
  function probe() {
    if (!shown || target.probed || !agent.ui().fullDownloadButton) return;
    target.probed = true;
    askOptions(target.videoKey, true);
  }

  // Reacts at once (no await before the menu or the busy state shows).
  function onFullClick() {
    if (!shown || busy) return;
    if (menuKey !== null) return closeMenu();
    const videoKey = target.videoKey;
    const r = optionsOf(videoKey);
    if (!listOf(r) && settled(r)) return download({ type: "downloadFull", videoKey });
    openMenu(videoKey);
    if (listOf(r)) return;
    // The pointer-enter reply may be old: re-read the cache now, not after POLL_MS.
    if (target.probed) askOptions(videoKey, false);
    else probe();
    polls = 0;
    pollTimer = setTimeout(poll, POLL_MS);
  }

  // Cache-only, while the menu waits for the qualities.
  function poll() {
    pollTimer = null;
    if (menuKey === null || settled(optionsOf(menuKey)) || ++polls > MAX_POLLS) return;
    askOptions(menuKey, false);
    pollTimer = setTimeout(poll, POLL_MS);
  }

  function openMenu(videoKey) {
    clearFeedback();
    menuKey = videoKey;
    raise(); // above the overlay's panel
    menu.hidden = false;
    renderMenu();
    window.addEventListener("keydown", onMenuKey, true);
    window.addEventListener("pointerdown", onOutside, true);
  }

  function closeMenu() {
    if (menuKey === null) return;
    menuKey = null;
    menuSig = "";
    clearTimeout(pollTimer);
    pollTimer = null;
    menu.hidden = true;
    menu.replaceChildren();
    window.removeEventListener("keydown", onMenuKey, true);
    window.removeEventListener("pointerdown", onOutside, true);
  }

  // The list with the default highlighted; while unknown, "Checking the
  // qualities…" and "Download now (default)"; no list possible: that item only.
  function renderMenu() {
    const videoKey = menuKey;
    const r = optionsOf(videoKey);
    const list = listOf(r);
    const def = list && Number.isInteger(list.defaultIndex) && list.defaultIndex >= 0 && list.defaultIndex < list.items.length
      ? list.defaultIndex
      : 0;
    const sig = list ? JSON.stringify([list.kind, list.items, def]) : String(settled(r));
    if (sig === menuSig) return;
    menuSig = sig;
    menu.replaceChildren();
    if (list) {
      list.items.forEach((label, i) => {
        item(label, i === def, () => download({ type: "downloadFull", videoKey, kind: list.kind, index: i }));
      });
    } else {
      if (!settled(r)) {
        const line = document.createElement("div");
        line.className = "muted";
        const spin = document.createElement("span");
        spin.className = "spin";
        const text = document.createElement("span");
        text.textContent = "Checking the qualities…";
        line.append(spin, text);
        menu.append(line);
      }
      item("Download now (default)", true, () => download({ type: "downloadFull", videoKey }));
    }
    place(menu);
    // The highlighted item in view (the menu is the items' offsetParent).
    const d = menu.querySelector(".def");
    menu.scrollTop = d ? Math.max(0, d.offsetTop - (menu.clientHeight - d.offsetHeight) / 2) : 0;
  }

  // def: the highlighted item.
  function item(text, def, fn) {
    const b = document.createElement("button");
    b.className = def ? "item def" : "item";
    b.setAttribute("role", "menuitem");
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = def ? "✓" : "";
    const label = document.createElement("span");
    label.className = "text";
    label.textContent = text;
    b.append(check, label);
    b.title = text;
    b.addEventListener("click", (e) => {
      if (e.isTrusted) fn();
    });
    menu.append(b);
  }

  function onMenuKey(e) {
    if (!e.isTrusted || menuKey === null) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeMenu();
    }
  }

  // The closed shadow root retargets every event inside it to the host.
  function onOutside(e) {
    if (e.isTrusted && e.target !== host) closeMenu();
  }

  function download(message) {
    closeMenu();
    clearFeedback();
    const token = ++downloads;
    busy = token;
    fullButton.classList.add("busy");
    fullButton.setAttribute("aria-busy", "true");
    request(message).then((r) => {
      if (busy !== token || !shown || target.videoKey !== message.videoKey) return;
      endBusy();
      if (r.ok === true) feedback(null);
      else feedback(errorText(r));
    });
  }

  function endBusy() {
    busy = 0;
    fullButton.classList.remove("busy");
    fullButton.removeAttribute("aria-busy");
  }

  // text null: the check mark; else the error line.
  function feedback(text) {
    clearFeedback();
    if (text === null) {
      downGlyph.toggleAttribute("hidden", true);
      okGlyph.toggleAttribute("hidden", false);
    } else {
      errorLine.textContent = text;
      raise();
      errorLine.hidden = false;
      place(errorLine);
    }
    feedbackTimer = setTimeout(clearFeedback, text === null ? CHECK_MS : ERROR_MS);
  }

  function clearFeedback() {
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
    downGlyph.toggleAttribute("hidden", false);
    okGlyph.toggleAttribute("hidden", true);
    errorLine.hidden = true;
    errorLine.textContent = "";
  }

  // Hidden, retargeted or switched off: no menu, busy state or feedback left.
  function resetFull() {
    closeMenu();
    clearFeedback();
    endBusy();
  }

  window.addEventListener("mousemove", onMove, { capture: true, passive: true });
  window.addEventListener("scroll", hide, { capture: true, passive: true });
  document.addEventListener("fullscreenchange", hide);
  document.addEventListener("webkitfullscreenchange", hide);
  window.addEventListener("pagehide", hide);
})();
