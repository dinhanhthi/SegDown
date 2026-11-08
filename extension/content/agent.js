// SegDown agent: runs in every frame and owns that frame's <video> elements.
// Talks to the hub in background.js; the message protocol is documented there.
// 3.3: discovery, stable videoKeys, seek/getTime/play/pause/select.
// 3.4: visible area, score and exclusions (the hub picks across frames).
// 3.6: `[` / `]` mark keys while the overlay is open.
// 5.3: shares the selected video and the hub's state with overlay.js (below).
// Also shares the app's ui switches and the eligible videos with button.js.
// Flags blob: (MSE) and EME videos, and carries the hub's player-probe marker (tag / untag).
// Fetches a playlist again for the hub when the app was refused it (refetch).
// Scores a background loop down and the frame's last played video up.
// Once per frame (a re-injection next to a live copy is a no-op); tears down
// once orphaned by an extension reload or update.

"use strict";

(() => {
  // A live copy already runs in this frame (the manifest injection and the
  // hub's re-injection after an update can both arrive). Orphans of 0.6.12 and
  // older have no alive() and are replaced.
  const prev = globalThis.segdownAgent;
  if (prev && typeof prev.alive === "function" && prev.alive()) return;
  // Any SegDown host already in the page belongs to an orphan (Chrome gives each
  // extension load its own isolated world, so its globalThis is not ours): hidden,
  // never removed (an orphan re-appends a removed host). An orphan's open overlay
  // would otherwise stay up until ours opens.
  for (const h of document.querySelectorAll("segdown-button, segdown-overlay")) {
    h.style.setProperty("display", "none", "important");
  }

  const SCAN_DELAY_MS = 500;
  const MAX_CANDIDATES = 20;
  const MIN_AREA = 200 * 112;
  const MAX_SCORE_DURATION = 3 * 3600;
  const BACKGROUND_FACTOR = 0.1; // score of a background loop (isBackground)
  const PLAYED_FACTOR = 4; // score of the frame's last played video
  const MEDIA_EVENTS = ["loadedmetadata", "durationchange", "resize", "play", "volumechange"];
  // Ad containers, matched per class token so that "thread-container" or
  // "download-container" is not an ad: ima-ad-container / ad-container / any
  // "-ad-container" or "_ad-container" token, a token containing "preroll", or
  // an id containing "google_ads".
  const AD_CLASS_TOKEN = /(^|[-_])ad-container$|preroll/i;
  const MAX_WALK_ELEMENTS = 10000; // per rescan, across the document and open shadow roots
  const MAX_SHADOW_DEPTH = 4;
  const ON_FACEBOOK = location.hostname === "facebook.com" || location.hostname.endsWith(".facebook.com");
  const FB_VIDEO_ID = /^\d{1,25}$/;
  const TAG_ATTR = /^data-segdown-[0-9a-f]{16}$/; // the hub's player-probe marker (tag / untag)
  const TAG_MS = 5000;
  const REFETCH_TIMEOUT_MS = 5000; // the hub waits 1 s more
  const MAX_REFETCH_BYTES = 1024 * 1024;

  const keyOf = new WeakMap(); // video -> videoKey
  const videos = new Map(); // videoKey -> video (pruned on rescan)
  let nextKey = 1;
  let selectedKey = null;
  let lastPlayedKey = null; // the last tracked video that played while not a background loop
  let lastReport = "[]"; // signature of the last candidates sent (see scan)
  let scanTimer = null;
  let observer = null;
  let panelOpen = false; // from the hub's `state` broadcast; keys are live only while open
  let hubState = null; // last hub `state` (for overlay.js)
  let stateSeen = false; // a broadcast beats the boot getState reply
  let ui = { fullClipButton: true, playerButton: true, fullDownloadButton: true, ignored: false }; // the app's switches and this tab's Ignored sites flag (getState, `ui` broadcast)
  const observedRoots = new WeakSet(); // open shadow roots already under the observer
  const tagged = new Map(); // attr -> video carrying the hub's probe marker (tag / untag)
  let dead = false; // orphaned and torn down: nothing re-arms

  // False once the extension reloads or updates: this copy is then an orphan
  // (chrome.runtime.id reads undefined, every chrome.runtime call throws).
  function alive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  // True once orphaned; the first call that notices tears down.
  function gone() {
    if (dead) return true;
    if (alive()) return false;
    teardown();
    return true;
  }

  // Once: stops the observer, the scan timer and every listener added at boot,
  // then tells overlay.js (dead is set first: it re-enters through changed()).
  function teardown() {
    dead = true;
    shared.dead = true;
    if (observer) observer.disconnect();
    clearTimeout(scanTimer);
    scanTimer = null;
    for (const v of videos.values()) {
      for (const type of MEDIA_EVENTS) v.removeEventListener(type, onMediaEvent);
    }
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", scheduleScan);
    window.removeEventListener("scroll", scheduleScan);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("prerenderingchange", onActivated);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // context gone
    }
    changed();
  }

  // Throws once the extension reloads ("Extension context invalidated"): tear down.
  function send(msg) {
    if (gone()) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => {
        gone();
      });
    } catch {
      gone(); // context gone
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

  // A landing page's hero loop. Feed and reel players (muted until tapped, custom
  // controls) match too: a score penalty only, never an exclusion; it ends once unmuted.
  function isBackground(v) {
    return v.muted && v.loop && !v.controls && getComputedStyle(v).objectFit === "cover";
  }

  function describe(videoKey, v) {
    const area = visibleArea(v);
    const duration = durationOf(v);
    const excluded = exclusionOf(v);
    const base = excluded || duration === null ? 0 : area * Math.min(duration, MAX_SCORE_DURATION);
    const out = {
      videoKey,
      area,
      duration,
      live: v.duration === Infinity,
      paused: v.paused,
      excluded,
      score: base && base * (isBackground(v) ? BACKGROUND_FACTOR : 1) * (videoKey === lastPlayedKey ? PLAYED_FACTOR : 1),
      width: v.videoWidth, // the hub keeps the pair only when both are > 0
      height: v.videoHeight,
    };
    const src = v.currentSrc;
    if (/^https?:/i.test(src) && src.length <= 8192) out.currentSrc = src;
    if (/^blob:/i.test(src)) out.blob = true; // MSE: the hub may ask the page's player (on demand)
    if (v.mediaKeys) out.drm = true; // EME attached (false positives: clear content can have keys)
    // Facebook plays MSE (no http currentSrc); the container's data-video-id names the clip.
    const box = ON_FACEBOOK && v.closest("[data-video-id]");
    if (box && box.querySelectorAll("video").length === 1) {
      const id = box.getAttribute("data-video-id");
      if (FB_VIDEO_ID.test(id)) out.videoId = id;
    }
    return out;
  }

  // A click on a player starts it (play); unmuting a reel ends its penalty (volumechange).
  function onMediaEvent(e) {
    const v = e.target;
    if ((e.type === "play" || e.type === "volumechange") && !v.paused && !isBackground(v)) {
      const key = keyOf.get(v);
      if (key && videos.get(key) === v) lastPlayedKey = key;
    }
    scheduleScan();
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
    for (const type of MEDIA_EVENTS) {
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
    if (gone()) return;
    if (ui.ignored) return; // Ignored sites: nothing to report (applyUI sent [])
    if (document.prerendering) return; // not shown yet: reported on activation (onActivated)
    for (const v of findVideos()) track(v);
    for (const [key, v] of videos) {
      if (!v.isConnected) {
        videos.delete(key);
        if (key === lastPlayedKey) lastPlayedKey = null;
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
  // order inside this frame re-sends. `paused` is a snapshot: a play re-sends only
  // through the score (the last played factor), a pause never.
  function signature(list) {
    const bucket = (score) => (score > 0 ? Math.round(Math.log2(score) * 4) : -1);
    const rows = list.map((c) => [c.videoKey, c.duration, c.live, c.excluded, c.currentSrc, c.videoId, c.width, c.height, c.blob, c.drm, bucket(c.score)]);
    const order = [...list].sort((a, b) => b.score - a.score || b.area - a.area).map((c) => c.videoKey);
    return JSON.stringify([rows, order]);
  }

  function scheduleScan() {
    if (scanTimer !== null || gone()) return;
    scanTimer = setTimeout(scan, SCAN_DELAY_MS);
  }

  const isTime = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

  // Removes the hub's marker attr from the video that carries it (if any).
  function untag(attr) {
    const el = tagged.get(attr);
    if (el) el.removeAttribute(attr);
    tagged.delete(attr);
  }

  // The hub's checks for a refetch, or null. A referrer of another origin is dropped
  // (the frame's own URL is the default).
  function refetchOptions(msg) {
    const isHttp = (s, max) => {
      if (typeof s !== "string" || s.length > max) return null;
      try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:" ? u : null;
      } catch {
        return null;
      }
    };
    if (!isHttp(msg.url, 8192)) return null;
    if (msg.credentials !== "include" && msg.credentials !== "same-origin") return null;
    if (!Number.isInteger(msg.maxBytes) || msg.maxBytes < 1 || msg.maxBytes > MAX_REFETCH_BYTES) return null;
    const ref = isHttp(msg.referrer, 8192);
    const referrer = ref && ref.origin === location.origin ? msg.referrer : undefined;
    return { url: msg.url, credentials: msg.credentials, referrer, maxBytes: msg.maxBytes };
  }

  // Fetches a playlist the frame already loaded (usually from the HTTP cache), in the
  // isolated world. The reply never carries the URL, status text or headers.
  async function refetch({ url, credentials, referrer, maxBytes }) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REFETCH_TIMEOUT_MS);
    try {
      // redirect "error": the hub resolves relative URIs against this exact URL.
      const init = { cache: "force-cache", credentials, redirect: "error", signal: ctl.signal };
      if (referrer) init.referrer = referrer;
      const res = await fetch(url, init);
      if (!res.ok) return { ok: false, error: "http" };
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          reader.cancel().catch(() => {});
          return { ok: false, error: "too-big" };
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      return { ok: false, error: "failed" }; // CORS, abort, decode
    } finally {
      clearTimeout(timer);
    }
  }

  // A Promise for refetch (onMessage replies once it settles), else the reply.
  function handle(msg) {
    if (msg.type === "refetch") {
      const opts = refetchOptions(msg);
      return opts ? refetch(opts) : { ok: false, error: "bad-message" };
    }
    if (msg.type === "select") {
      selectedKey = typeof msg.videoKey === "string" && videos.has(msg.videoKey) ? msg.videoKey : null;
      changed();
      return { ok: msg.videoKey === null || selectedKey !== null };
    }
    // The hub's player probe finds its target video in the page's MAIN world by
    // this short-lived attribute; removed by untag or after TAG_MS.
    if (msg.type === "tag") {
      const v = typeof msg.videoKey === "string" ? videos.get(msg.videoKey) : undefined;
      if (typeof msg.attr !== "string" || !TAG_ATTR.test(msg.attr) || !v || !v.isConnected) return { ok: false };
      const attr = msg.attr;
      untag(attr);
      v.setAttribute(attr, "1");
      tagged.set(attr, v);
      setTimeout(() => {
        if (tagged.get(attr) === v) untag(attr);
      }, TAG_MS);
      return { ok: true };
    }
    if (msg.type === "untag") {
      if (typeof msg.attr !== "string" || !TAG_ATTR.test(msg.attr)) return { ok: false };
      untag(msg.attr);
      return { ok: true };
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

  // Replaced whole, only by four booleans. Becoming ignored reports no videos
  // once; no longer ignored reports everything anew.
  function applyUI(u) {
    if (!u || typeof u !== "object") return;
    if (
      typeof u.fullClipButton !== "boolean" ||
      typeof u.playerButton !== "boolean" ||
      typeof u.fullDownloadButton !== "boolean" ||
      typeof u.ignored !== "boolean"
    )
      return;
    const wasIgnored = ui.ignored;
    ui = {
      fullClipButton: u.fullClipButton,
      playerButton: u.playerButton,
      fullDownloadButton: u.fullDownloadButton,
      ignored: u.ignored,
    };
    if (ui.ignored && !wasIgnored) {
      lastReport = "[]";
      send({ type: "candidates", videos: [] });
    } else if (!ui.ignored && wasIgnored) {
      lastReport = null;
      scheduleScan();
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
  // selected video leaves the document. button.js reads ui() (it hides while
  // playerButton is off or ignored is true; fullDownloadButton shows its Download
  // full video button) and eligible():
  // the tracked videos that are connected, not excluded and of a finite
  // duration > 0, as [{videoKey, video}]. alive() turns false (and dead true)
  // once this copy is orphaned; overlay.js and button.js then tear down too.
  const shared = {
    alive: () => !dead && alive(),
    dead: false,
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

  function onMessage(msg, sender, sendResponse) {
    if (dead) return undefined;
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
    const r = handle(msg);
    if (r instanceof Promise) {
      r.then(sendResponse);
      return true; // the reply comes later (refetch)
    }
    sendResponse(r);
    return undefined;
  }

  chrome.runtime.onMessage.addListener(onMessage);

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
        () => {
          gone();
        }
      );
    } catch {
      gone(); // context gone
    }
  }

  // Leaving the page (or entering the back/forward cache): the hub drops this
  // frame's videos, also when an iframe is removed without a navigation event.
  function onPageHide() {
    lastReport = "[]";
    send({ type: "candidates", videos: [] });
  }

  window.addEventListener("pagehide", onPageHide);

  // Back/forward cache restore: the top-frame commit cleared the hub's tab state
  // and this script does not run again, so report everything anew.
  function onPageShow(e) {
    if (!e.persisted || gone()) return;
    lastReport = null;
    selectedKey = null; // the hub sends `select` again after its auto-pick
    stateSeen = false;
    changed();
    requestState();
    scheduleScan();
  }

  window.addEventListener("pageshow", onPageShow);

  // A prerendered page (Chrome speculation rules) reports nothing until it is shown
  // (the hub ignores it; its activation clears the tab): then report everything anew.
  function onActivated() {
    if (gone()) return;
    lastReport = null;
    selectedKey = null;
    stateSeen = false;
    changed();
    requestState();
    scheduleScan();
  }

  if (document.prerendering) {
    document.addEventListener("prerenderingchange", onActivated, { once: true });
  } else {
    requestState();
    if (dead) return; // already orphaned at boot: requestState tore down
  }

  observer = new MutationObserver(scheduleScan);
  observe(document.documentElement);
  // scheduleScan coalesces bursts into one rescan per SCAN_DELAY_MS.
  window.addEventListener("resize", scheduleScan, { passive: true });
  window.addEventListener("scroll", scheduleScan, { passive: true });
  scan();
})();
