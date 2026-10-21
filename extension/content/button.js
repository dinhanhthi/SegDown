// SegDown player button: runs in every frame and shows a small SegDown icon at
// the top-left of the eligible video under the pointer (agent.eligible(): not
// an ad, not live, not small, finite duration). A click opens the overlay on that
// video through the hub's `openOverlay` (the protocol is documented in
// background.js). One host per frame, in a closed shadow root shown in the top
// layer (popover="manual"), so it stays above the page and every kind of
// fullscreen. Hidden while the app's playerButton switch is off and on the video
// whose overlay is open.
// Page data is untrusted: the DOM is built from constants only (SVG via
// createElementNS, no page strings), handlers act on trusted events only, and
// the hub gets a videoKey only (the frame comes from the sender).

"use strict";

(() => {
  const agent = globalThis.segdownAgent;
  if (!agent || typeof agent.eligible !== "function" || typeof agent.ui !== "function") return;

  const HIDE_MS = 2000; // auto-hide after the mouse stops over the video
  const MIN_TICK_MS = 500; // the hide re-check while the pointer rests on the button
  const BLOCK_MS = 1000; // after a click, until the hub's `state` marks the overlay open
  const SIZE = 28; // px
  const OFFSET = 8; // px from the video's top-left corner
  const SVG_NS = "http://www.w3.org/2000/svg";
  // Players toggle play/pause or fullscreen on clicks and keys: keep them out.
  const ISOLATED_EVENTS = [
    "click", "dblclick", "contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup",
    "wheel", "keydown", "keyup", "keypress", "focusin", "focusout",
  ];
  // Undoes the page's and the popover UA styles on the host (left / top are set
  // on each show); the button inside opts back into pointer events.
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
    button {
      all: unset; box-sizing: border-box; position: absolute; inset: 0; display: flex;
      align-items: center; justify-content: center; border-radius: 50%; cursor: pointer;
      background: rgba(28, 28, 30, 0.9); border: 1px solid #3a3a3c; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      pointer-events: auto;
    }
    button:hover { background: #3a3a3c; }
    button:focus-visible { outline: 2px solid #0a84ff; }
    svg { display: block; width: 18px; height: 18px; pointer-events: none; }
  `;
  // The logo's glyph on a 24 px grid: a strip with a marked segment between two
  // handles, and a down arrow under it.
  const GLYPH = [
    ["rect", { x: "2.75", y: "3.75", width: "18.5", height: "8", rx: "2", fill: "none", stroke: "#fff", "stroke-width": "1.5" }],
    ["rect", { x: "8", y: "3.75", width: "8", height: "8", fill: "#0a84ff" }],
    ["path", { d: "M8 2.5v10.5M16 2.5v10.5", fill: "none", stroke: "#fff", "stroke-width": "1.75", "stroke-linecap": "round" }],
    ["path", { d: "M10.5 13.5h3v3.5H16l-4 4.5-4-4.5h2.5z", fill: "#fff" }],
  ];

  let host = null; // built on first show
  let button = null;
  let shown = false;
  let target = null; // {videoKey, video} the button is on while shown
  let lastMove = 0; // the last pointer move over the target
  let blockedUntil = 0;
  let hideTimer = null;
  let frame = 0;
  let pointX = 0;
  let pointY = 0;

  // The hub's reply is not needed; errors (also "Extension context invalidated"
  // once the extension reloads) are ignored.
  function ask(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // context gone
    }
  }

  const overlayOn = (v) => {
    const st = agent.state();
    return Boolean(st && st.panelOpen === true && agent.video() === v);
  };

  // --- DOM ---

  function glyph() {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of [["viewBox", "0 0 24 24"], ["width", "18"], ["height", "18"], ["aria-hidden", "true"], ["focusable", "false"]]) {
      svg.setAttribute(k, v);
    }
    for (const [tag, attrs] of GLYPH) {
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
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    // Clicks must not move the keyboard focus here: keys stay with the player.
    wrap.addEventListener("mousedown", (e) => e.preventDefault());
    button = document.createElement("button");
    button.setAttribute("aria-label", "SegDown");
    button.title = "SegDown";
    button.append(glyph());
    button.addEventListener("click", (e) => {
      if (e.isTrusted) onButtonClick();
    });
    wrap.append(button);
    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(style, wrap);
  }

  // --- show / hide ---

  // (Re-)enters the top layer last, so it sits above a fullscreen element.
  function show(r) {
    if (!host) build();
    if (!host.isConnected) document.documentElement.append(host);
    const left = Math.max(0, Math.min(Math.max(r.left, 0) + OFFSET, window.innerWidth - SIZE));
    const top = Math.max(0, Math.min(Math.max(r.top, 0) + OFFSET, window.innerHeight - SIZE));
    host.style.setProperty("left", `${left}px`, "important");
    host.style.setProperty("top", `${top}px`, "important");
    host.style.setProperty("visibility", "visible", "important");
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {
      // no popover support: the fixed host with the top z-index stays
    }
    shown = true;
    scheduleHide();
  }

  function hide() {
    if (!shown) return;
    shown = false;
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
  function onHideTick() {
    hideTimer = null;
    if (!shown) return;
    if (!agent.ui().playerButton || !target.video.isConnected || overlayOn(target.video)) return hide();
    if (button.matches(":hover")) {
      hideTimer = setTimeout(onHideTick, MIN_TICK_MS);
      return;
    }
    const idle = Date.now() - lastMove;
    if (idle >= HIDE_MS) return hide();
    hideTimer = setTimeout(onHideTick, Math.max(HIDE_MS - idle, MIN_TICK_MS));
  }

  // --- pointer ---

  // The eligible video under the point, the smallest if several overlap; the
  // video whose overlay is open does not count.
  function hitTest(x, y) {
    let best = null;
    let bestArea = Infinity;
    for (const c of agent.eligible()) {
      const r = c.video.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea && !overlayOn(c.video)) {
        best = { videoKey: c.videoKey, video: c.video, rect: r };
        bestArea = area;
      }
    }
    return best;
  }

  function onFrame() {
    frame = 0;
    if (!agent.ui().playerButton) return hide();
    const hit = hitTest(pointX, pointY);
    if (!hit) {
      if (shown && overlayOn(target.video)) hide();
      return;
    }
    if (shown && hit.video === target.video) {
      lastMove = Date.now();
      return;
    }
    if (Date.now() < blockedUntil) return;
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

  function onButtonClick() {
    if (!shown) return;
    const videoKey = target.videoKey;
    blockedUntil = Date.now() + BLOCK_MS;
    hide();
    ask({ type: "openOverlay", videoKey });
  }

  window.addEventListener("mousemove", onMove, { capture: true, passive: true });
  window.addEventListener("scroll", hide, { capture: true, passive: true });
  document.addEventListener("fullscreenchange", hide);
  document.addEventListener("webkitfullscreenchange", hide);
  window.addEventListener("pagehide", hide);
})();
