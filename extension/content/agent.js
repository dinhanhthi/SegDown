// SegDown agent: runs in every frame and owns that frame's <video> elements.
// Talks to the hub in background.js; the message protocol is documented there.
// 3.3: discovery, stable videoKeys, seek/getTime/play/pause/select.
// 3.4: visible area, score and exclusions (the hub picks across frames).
// 3.6: `[` / `]` mark keys while the overlay is open.
// 5.3: shares the selected video and the hub's state with overlay.js (below).
// Also shares the app's ui switches and the eligible videos with button.js.

"use strict";

(() => {
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
  const ON_FACEBOOK = location.hostname === "facebook.com" || location.hostname.endsWith(".facebook.com");
  const FB_VIDEO_ID = /^\d{1,25}$/;

  const keyOf = new WeakMap(); // video -> videoKey
  const videos = new Map(); // videoKey -> video (pruned on rescan)
  let nextKey = 1;
  let selectedKey = null;
  let lastReport = "[]"; // signature of the last candidates sent (see scan)
  let scanTimer = null;
  let observer = null;
  let panelOpen = false; // from the hub's `state` broadcast; keys are live only while open
  let hubState = null; // last hub `state` (for overlay.js)
  let stateSeen = false; // a broadcast beats the boot getState reply
  let ui = { fullClipButton: true, playerButton: true }; // the app's switches (getState, `ui` broadcast)
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
      width: v.videoWidth, // the hub keeps the pair only when both are > 0
      height: v.videoHeight,
    };
    const src = v.currentSrc;
    if (/^https?:/i.test(src) && src.length <= 8192) out.currentSrc = src;
    // Facebook plays MSE (no http currentSrc); the container's data-video-id names the clip.
    const box = ON_FACEBOOK && v.closest("[data-video-id]");
    if (box && box.querySelectorAll("video").length === 1) {
      const id = box.getAttribute("data-video-id");
      if (FB_VIDEO_ID.test(id)) out.videoId = id;
    }
    return out;
  }

  function onMediaEvent(e) {
    if (e.type === "loadedmetadata" || e.type === "durationchange" || e.type === "resize") scheduleScan();
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
    for (const type of ["loadedmetadata", "durationchange", "resize"]) {
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
        if (key === selectedKey) {
          selectedKey = null;
          changed();
        }
      }
    }
    let list = [...videos].map(([key, v]) => describe(key, v));
    if (list.length > MAX_CANDIDATES) list = list.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
    const sig = signature(list);
    if (sig === lastReport) return;
    lastReport = sig;
    send({ type: "candidates", videos: list });
  }

  // What the hub uses. Scrolling changes the visible area, and so
  // the score, all the time: only a score bucket change (factor ~1.19) or a new
  // order inside this frame re-sends. `paused` is a snapshot and play/pause does
  // not re-send either.
  function signature(list) {
    const bucket = (score) => (score > 0 ? Math.round(Math.log2(score) * 4) : -1);
    const rows = list.map((c) => [c.videoKey, c.duration, c.live, c.excluded, c.currentSrc, c.videoId, c.width, c.height, bucket(c.score)]);
    const order = [...list].sort((a, b) => b.score - a.score || b.area - a.area).map((c) => c.videoKey);
    return JSON.stringify([rows, order]);
  }

  function scheduleScan() {
    if (scanTimer === null) scanTimer = setTimeout(scan, SCAN_DELAY_MS);
  }

  const isTime = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

  function handle(msg) {
    if (msg.type === "select") {
      selectedKey = typeof msg.videoKey === "string" && videos.has(msg.videoKey) ? msg.videoKey : null;
      changed();
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

  // Replaced whole, only by two booleans.
  function applyUI(u) {
    if (u && typeof u === "object" && typeof u.fullClipButton === "boolean" && typeof u.playerButton === "boolean") {
      ui = { fullClipButton: u.fullClipButton, playerButton: u.playerButton };
    }
  }

  function applyHubState(state) {
    if (!state || typeof state !== "object") return;
    hubState = state;
    panelOpen = state.panelOpen === true;
    changed();
  }

  // Shared with overlay.js (same isolated world, loaded after this file; the page
  // cannot see it): the selected video of this frame and the hub's last `state`.
  // overlay.js sets onChange; it runs after a `select`, a `state` and when the
  // selected video leaves the document. button.js reads ui() and eligible():
  // the tracked videos that are connected, not excluded and of a finite
  // duration > 0, as [{videoKey, video}].
  const shared = {
    video: () => (selectedKey && videos.get(selectedKey)) || null,
    state: () => hubState,
    ui: () => ui,
    eligible: () => {
      const out = [];
      for (const [videoKey, video] of videos) {
        if (!video.isConnected || exclusionOf(video) !== null) continue;
        if (Number.isFinite(video.duration) && video.duration > 0) out.push({ videoKey, video });
      }
      return out;
    },
    onChange: null,
  };
  globalThis.segdownAgent = shared;

  function changed() {
    if (typeof shared.onChange === "function") shared.onChange();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg) return undefined;
    if (msg.to === "all" && msg.type === "state") {
      stateSeen = true;
      applyHubState(msg.state);
      return undefined;
    }
    if (msg.to === "all" && msg.type === "ui") {
      applyUI(msg.ui);
      return undefined;
    }
    if (msg.to !== "agent") return undefined;
    sendResponse(handle(msg));
    return undefined;
  });

  // --- keyboard (3.6) ---

  const KEY_ACTIONS = { "[": "markStart", "]": "markEnd" };

  // Keys typed into a text field belong to it. composedPath()[0] sees inside
  // the page's open shadow roots; a closed shadow root hides its focused
  // element: the target is then the host. Two tiers:
  // - chrome.dom.openOrClosedShadowRoot (Chrome 88+, content scripts): descend
  //   through the focused element's shadow roots, open or closed, to the element
  //   that really has focus, then apply the text-field check to it.
  // - without that API (e.g. Safari): a custom element (name with "-") without a
  //   reachable shadowRoot counts as typing, since closed roots live on custom
  //   elements in practice. Known false positive: while a focusable light-DOM
  //   custom element has focus (e.g. <video-js tabindex="-1">), `[` / `]` are
  //   left to the page and do not mark.
  // The SegDown overlay's and player button's hosts are exempt (their closed
  // roots have buttons only).
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
    if (t.localName === "segdown-overlay" || t.localName === "segdown-button") return false;
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
    send({ type: "key", action }); // the hub relays the result or error to the overlay
  }

  window.addEventListener("keydown", onKeyDown, true);

  // A frame that loads after the overlay opened missed the broadcast. The ui
  // switches are taken from every reply.
  function requestState() {
    try {
      chrome.runtime.sendMessage({ type: "getState" }).then(
        (r) => {
          if (!r || !r.ok) return;
          applyUI(r.ui);
          if (!stateSeen) applyHubState(r.state);
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
    changed();
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
