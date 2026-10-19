// SegDown background service worker (classic script, no modules).
// Sections: config, media capture (3.2), hub + frame routing (3.3, auto-pick 3.4,
// panel toggle 3.5, marking 3.6, fullscreen compact panel relay 3.8).

"use strict";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Logs one line per new capture (frameId, kind, header names; never values or URLs).
const DEBUG = true;

// Same canonical names as SegDownCore Validation.allowedHeaders.
const ALLOWED_HEADERS = ["Referer", "Origin", "User-Agent", "Cookie"];
const MAX_HEADER_VALUE_BYTES = 8 * 1024; // Validation.maxHeaderValueBytes
const MAX_ENTRIES_PER_TAB = 50;
const PENDING_TTL_MS = 60 * 1000;
const MAX_PENDING = 500;
// Request types that never carry media we can download.
const IGNORED_TYPES = new Set(["script", "stylesheet", "image", "font"]);

const HLS_TYPES = new Set(["application/vnd.apple.mpegurl", "application/x-mpegurl"]);
const MP4_TYPES = new Set(["video/mp4"]);
const CHUNK_TYPES = new Set(["video/mp2t", "video/iso.segment"]);

// ---------------------------------------------------------------------------
// Media capture: pending request headers (memory only, short-lived)
// ---------------------------------------------------------------------------

// requestId -> {tabId, frameId, url, headers, ts}. Map keeps insertion order, oldest first.
const pending = new Map();

function prunePending(now) {
  for (const [id, p] of pending) {
    if (pending.size <= MAX_PENDING && now - p.ts < PENDING_TTL_MS) break;
    pending.delete(id);
  }
}

// Keeps only allowlisted headers under their canonical names. Values that the app
// would reject (CR/LF/NUL, over 8 KB) are skipped. First occurrence wins.
function pickHeaders(requestHeaders) {
  const headers = {};
  for (const h of requestHeaders || []) {
    const name = ALLOWED_HEADERS.find((n) => n.toLowerCase() === String(h.name).toLowerCase());
    if (!name || name in headers || typeof h.value !== "string") continue;
    if (/[\r\n\0]/.test(h.value)) continue;
    if (new TextEncoder().encode(h.value).length > MAX_HEADER_VALUE_BYTES) continue;
    headers[name] = h.value;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Media capture: classification
// ---------------------------------------------------------------------------

function httpURL(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function contentType(responseHeaders) {
  const h = (responseHeaders || []).find((x) => String(x.name).toLowerCase() === "content-type");
  return h && typeof h.value === "string" ? h.value.split(";")[0].trim().toLowerCase() : "";
}

// Returns "hls" | "mp4" | "chunk" | null. A .ts/.m4s path wins over the Content-Type,
// because fMP4 segments are often served as video/mp4.
function classify(pathname, ctype) {
  const path = pathname.toLowerCase();
  if (path.endsWith(".ts") || path.endsWith(".m4s") || CHUNK_TYPES.has(ctype)) return "chunk";
  if (HLS_TYPES.has(ctype)) return "hls";
  if (MP4_TYPES.has(ctype)) return "mp4";
  if (path.endsWith(".m3u8")) return "hls";
  if (path.endsWith(".mp4")) return "mp4";
  return null;
}

// ---------------------------------------------------------------------------
// Media capture: per-tab store in chrome.storage.session
// Keys: cap:<tabId> -> [{url, frameId, kind, isMaster?, headers, ts}] (oldest first)
//       act:<tabId> -> {<frameId>: {lastChunkUrl, count, ts}}
//       hub:<tabId>, cand:<tabId>, segs:<tabId> and page:<tabId> belong to the hub (see the hub section).
// Never call storage.session.setAccessLevel: Cookie values live here. (storage.local,
// the panel's saved segments, is owned by the hub; see the end of its section.)
// ---------------------------------------------------------------------------

const capKey = (tabId) => `cap:${tabId}`;
const actKey = (tabId) => `act:${tabId}`;
const hubKey = (tabId) => `hub:${tabId}`;
const candKey = (tabId) => `cand:${tabId}`;
const segsKey = (tabId) => `segs:${tabId}`;
const pageKey = (tabId) => `page:${tabId}`;

// Serialises read-modify-write per tab. A failed task never blocks the next one.
const tabQueues = new Map();

function withTab(tabId, task) {
  const run = (tabQueues.get(tabId) || Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  tabQueues.set(tabId, tail);
  tail.then(() => {
    if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
  });
  return run;
}

function logError(err) {
  console.warn("[SegDown] capture store error:", err && err.message ? err.message : err);
}

async function addEntry(tabId, entry) {
  const key = capKey(tabId);
  const entries = (await chrome.storage.session.get({ [key]: [] }))[key];
  const index = entries.findIndex((e) => e.url === entry.url);
  const isNew = index < 0;
  if (!isNew) entries.splice(index, 1); // dedupe by URL (mp4 Range requests, playlist refetches)
  entries.push(entry);
  while (entries.length > MAX_ENTRIES_PER_TAB) {
    // Drop the oldest mp4 first so segment churn never evicts a playlist.
    const mp4 = entries.findIndex((e) => e.kind === "mp4");
    entries.splice(mp4 >= 0 ? mp4 : 0, 1);
  }
  await chrome.storage.session.set({ [key]: entries });
  if (DEBUG && isNew) {
    console.debug(
      `[SegDown] capture tab=${tabId} frame=${entry.frameId} kind=${entry.kind} headers=[${Object.keys(entry.headers).join(", ")}]`
    );
  }
}

async function bumpActive(tabId, frameId, url, ts) {
  const key = actKey(tabId);
  const active = (await chrome.storage.session.get({ [key]: {} }))[key];
  const prev = active[frameId];
  active[frameId] = { lastChunkUrl: url, count: (prev ? prev.count : 0) + 1, ts };
  await chrome.storage.session.set({ [key]: active });
}

function clearTab(tabId) {
  return withTab(tabId, () =>
    chrome.storage.session.remove([
      capKey(tabId),
      actKey(tabId),
      hubKey(tabId),
      candKey(tabId),
      segsKey(tabId),
      pageKey(tabId),
    ])
  );
}

// For the hub (3.3) and source correlation (4.1).
// Returns {entries: [...oldest first], active: {<frameId>: {lastChunkUrl, count, ts}}}.
function getCaptures(tabId) {
  return withTab(tabId, async () => {
    const got = await chrome.storage.session.get({ [capKey(tabId)]: [], [actKey(tabId)]: {} });
    return { entries: got[capKey(tabId)], active: got[actKey(tabId)] };
  });
}

// ---------------------------------------------------------------------------
// Media capture: listeners (registered synchronously at top level)
// ---------------------------------------------------------------------------

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const now = Date.now();
    pending.delete(details.requestId); // redirects re-fire with the same id; keep order honest
    pending.set(details.requestId, {
      tabId: details.tabId,
      frameId: details.frameId,
      url: details.url,
      headers: pickHeaders(details.requestHeaders),
      ts: now,
    });
    prunePending(now);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { tabId, frameId, requestId, url } = details;
    if (tabId < 0 || IGNORED_TYPES.has(details.type)) return;
    if (details.statusCode < 200 || details.statusCode > 299) return;
    const parsed = httpURL(url);
    if (!parsed) return;
    const kind = classify(parsed.pathname, contentType(details.responseHeaders));
    if (!kind) return;
    const ts = Date.now();
    if (kind === "chunk") {
      withTab(tabId, () => bumpActive(tabId, frameId, url, ts)).catch(logError);
      return;
    }
    // If the worker restarted since onSendHeaders, store the entry without headers.
    const p = pending.get(requestId);
    const headers = p ? p.headers : {};
    // isMaster stays undefined here; phase 4 probes playlists through the app.
    withTab(tabId, () => addEntry(tabId, { url, frameId, kind, headers, ts })).catch(logError);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webRequest.onCompleted.addListener((d) => pending.delete(d.requestId), { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener((d) => pending.delete(d.requestId), { urls: ["<all_urls>"] });

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [id, p] of pending) if (p.tabId === tabId) pending.delete(id);
  clearTab(tabId).catch(logError);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) clearTab(details.tabId).catch(logError);
});

// ---------------------------------------------------------------------------
// Hub + frame routing (3.3)
//
// Message protocol. Tasks 3.4-3.8 follow it; change it here first.
//
// Content -> hub: chrome.runtime.sendMessage({type, ...}). The hub takes the tab
// and frame ONLY from sender.tab.id / sender.frameId, never from the body. It
// ignores other extensions (sender.id), senders without a tab, and types it does
// not own (no sendResponse, so later onMessage listeners still get them). A
// malformed hub message gets {ok: false, error: "bad-message"}. Every hub reply
// has `ok`; failures add `error`.
//
//   Agent (every frame, owns that frame's <video> elements):
//   candidates {videos: [{videoKey, area, duration, live, paused, excluded, score,
//              currentSrc?}]}
//              The frame's full list (replaces the previous one, [] clears it).
//              videoKey: [A-Za-z0-9_-]{1,64}, stable per element for the frame's
//              lifetime. area: finite >= 0, the part of the video inside the
//              frame's viewport (CSS px^2). duration: finite >= 0, or null when
//              unknown or live (JSON turns Infinity into null, so live videos
//              send live: true). excluded: null | "ad" (an ancestor has an ad
//              class token or id, see agent.js) | "live" | "small" (rendered box
//              width * height < 200x112, on-screen or not), first match in that
//              order. score: area * min(duration, 3 h), 0 when excluded or
//              duration is null. currentSrc: only if http(s), max 8192 chars,
//              else omitted. At most 20 videos (the top scores when a frame has
//              more). Agents re-send only when a field the hub uses changes
//              (the score in coarse buckets, so scrolling rarely re-sends), and
//              send [] on pagehide (a removed iframe takes its videos with it).
//              -> {ok}. The hub relays the merged list to the panel and re-runs
//              the auto-pick (below).
//   tick       {videoKey, currentTime, duration, paused}, at most 4 Hz, only for
//              the selected video and only while the panel is open (one tick
//              when it opens). Ignored unless sender frame + videoKey match the
//              selection. -> {ok}. Relayed to the panel.
//   key        {action: "markStart" | "markEnd"} from any frame (3.6 keyboard:
//              `[` / `]`) or from panel buttons. The hub asks the selected agent
//              for getTime. markStart stores pendingStart (replacing an older
//              one) and sets selectedBy "user", so an auto re-pick cannot drop
//              the start. markEnd needs a pendingStart ("no-start") and a time
//              after it ("end-not-after-start"; the start is kept so the user
//              can seek on and mark again); on success it clears pendingStart.
//              -> {ok, action, time, frameId, videoKey} (markEnd adds start and
//              end = time), also relayed to the panel and the compact panel as
//              `mark`. Failures ("no-selection", "selection-changed", agent
//              errors and the two above) -> {ok: false, error}, also relayed as
//              `markError`.
//              The 3.8 compact panel's Mark start / Mark end buttons send `key`
//              too; it seeks its own video directly and draws the playhead from
//              it (it always lives in the video's frame), so it needs no ticks.
//
//   Panel (top frame), all aimed at the selected video, so they carry no target:
//   seek {time} | play | pause -> the agent's reply ({ok} or {ok: false, error})
//              An agent that cannot be reached ("agent-unreachable": its frame
//              was removed without a navigation event) loses its candidates,
//              which re-runs the auto-pick.
//   getTime                    -> {ok, currentTime, duration, paused}
//   select {frameId, videoKey} must match a reported candidate -> {ok, state}
//              Sets selectedBy "user". Changing the video clears pendingStart.
//   setPanelOpen {open: boolean} -> {ok, state} (the panel's close button);
//              sends state to "all" like the toggle.
//   getState   top frame -> {ok, state, candidates, captures, segments} where
//              captures = {entries: [{url, frameId, kind, isMaster, ts}],
//               active: {<frameId>: {count, ts}}}. Never header values or
//              cookies: content scripts live in possibly hostile pages.
//              segments: as stored by segmentsChanged, [] if none.
//              Other frames -> {ok, state}, plus `segments` only in the selected
//              video's frame (the compact panel asks for them when it mounts):
//              capture and candidate URLs may carry tokens, so third-party
//              frames never see them. Agents send it once at load (and after a
//              back/forward cache restore) for state.panelOpen (a frame that
//              loads after the panel opened missed the `state` broadcast).
//   segmentsChanged {segments: [{start, end}]} top frame only (else
//              {ok: false, error: "not-top-frame"}). The panel's full sorted list
//              (3.6/3.7 own it), sent after every change and after the 3.7
//              restore. At most 100; start, end finite >= 0, end > start.
//              -> {ok}. Stored as numbers only and relayed to the selected
//              video's frame as `segments` when it changed.
//
//   Panel persistence (3.7), top frame only (else {ok: false, error:
//   "not-top-frame"}). The page key is `seg:` + the top frame's URL without its
//   hash, taken from sender.url (never from the body) when loadPage arrives and
//   kept in page:<tabId> with sender.documentId. Saves from that document go
//   to that key until its next loadPage, so a save that races a pushState still
//   lands on the page it belongs to; any other document (e.g. an unloading
//   page's pagehide flush after the next page's loadPage) is keyed by its
//   sender.url.
//   loadPage   -> {ok, page, prefs, pos}: the stored seg:<url>, panel:prefs and
//              panel:pos values (null when missing; the panel validates them).
//              Sent at load, after pageChanged, and after a back/forward cache
//              restore (the commit cleared page:<tabId>; the reply is unused).
//   savePage {segments: [{start, end}] (at most 100), mode: "separate" |
//              "merged", precision: "precise" | "fast"} -> {ok}. Writes
//              panel:prefs {mode, precision}; an empty list removes the page
//              entry, else it becomes {segments, mode, precision, ts} and the
//              200 most recent seg:* entries are kept.
//   savePos {x, y} (finite) -> {ok}. Writes panel:pos.
//
// Hub -> content: chrome.tabs.sendMessage(tabId, msg, {frameId}). agent.js and
// panel.js share each frame, so every message names its receiver in `to`;
// each listener ignores the others.
//   to "agent" (the video's frame):
//     seek {videoKey, time} | play {videoKey} | pause {videoKey} -> {ok}
//     getTime {videoKey} -> {ok, currentTime, duration (null if unknown), paused}
//     select {videoKey | null}: tick only this video (null: stop ticking)
//   to "compact" (the selected video's frame; 3.8 fullscreen compact panel,
//   in agent.js, which ignores them while no compact panel is mounted):
//     segments {segments: [{start, end}]}
//     mark {action, time, frameId, videoKey, start?, end?} | markError {action, error}
//   to "panel" (frameId 0):
//     pageChanged {}: the top URL (without hash) changed without a reload
//       (pushState / replaceState); the panel flushes its pending save (still
//       keyed to the old page) and runs loadPage for the new one.
//     candidates {candidates: [{frameId, ...candidate}]}
//     tick {frameId, videoKey, currentTime, duration, paused}
//     mark {action, time, frameId, videoKey, start?, end?} (start/end: markEnd)
//     markError {action, error}
//   to "all" (every frame, no frameId option):
//     state {state} after the selection, selectedBy or pendingStart changes.
//     Also sent after panelOpen changes: agents listen for `[` / `]` only while
//     the panel is open, and the panel shows or hides itself.
//
// Panel toggle (3.5): chrome.action.onClicked and the "toggle-panel" command
// flip panelOpen for that tab, then send state to "all". The panel starts hidden
// and mounts on the first panelOpen: true. Top-frame navigation clears hub:<tabId>,
// so the panel is closed again on the next page.
//
// Same-document URL changes (webNavigation.onHistoryStateUpdated, frame 0, to a
// URL that, without its hash, differs from the one page:<tabId> was loaded for): the hub
// clears pendingStart and segs:<tabId> (captures stay; the next video's requests
// add to them), relays [] segments to the compact panel and sends `state` to
// "all" and `pageChanged` to the panel. The selection stays until the agents
// report other videos.
//
// Main-video auto-pick (3.4): whenever any frame's candidates change and
// selectedBy is "auto", the hub selects the top score across all frames (ties:
// larger area, then lower frameId / list order). It skips excluded candidates
// and, when a non-excluded candidate lasts >= 30 s, non-excluded ones known to be
// shorter. Unknown durations qualify with score 0. Nothing qualifies -> null.
// A user selection (picker, or a marked start) sticks until its video
// disappears; then selectedBy goes back to "auto". An auto switch clears pendingStart and sends the agents `select`.
//
// Storage (chrome.storage.session, cleared with the capture keys):
//   hub:<tabId>  -> {selected: {frameId, videoKey} | null, selectedBy: "auto" | "user",
//                    panelOpen, pendingStart}   (= `state` above)
//   cand:<tabId> -> {<frameId>: [candidate, ...]}
//   segs:<tabId> -> [{start, end}]   (the top panel's segments, for the compact panel)
//   page:<tabId> -> {key: "seg:<url>", documentId}   (persistence key, see above)
// chrome.storage.local (persistent; only this worker reads or writes it, and its
// access level is set to trusted contexts where the browser supports that):
//   seg:<url>    -> {segments, mode, precision, ts}   (at most 200, newest ts kept)
//   panel:prefs  -> {mode, precision}   (last used, for pages without an entry)
//   panel:pos    -> {x, y}   (panel position in CSS px)
// ---------------------------------------------------------------------------

const MAX_CANDIDATES_PER_FRAME = 20;
const MAX_URL_LENGTH = 8192;
const VIDEO_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MARK_ACTIONS = new Set(["markStart", "markEnd"]);
const EXCLUSIONS = new Set(["small", "ad", "live"]);
const MIN_MAIN_DURATION = 30; // seconds; shorter videos lose to a longer candidate
const MAX_SEGMENTS = 100; // SegDownCore Validation
const MAX_PAGES = 200; // seg:* entries kept in storage.local, most recent ts first
const PREFS_KEY = "panel:prefs";
const POS_KEY = "panel:pos";
const MODES = new Set(["separate", "merged"]);
const PRECISIONS = new Set(["precise", "fast"]);

const isFiniteNum = (n) => typeof n === "number" && Number.isFinite(n);
const isTime = (n) => isFiniteNum(n) && n >= 0;
const isDuration = (n) => n === null || isTime(n);
const isVideoKey = (k) => typeof k === "string" && VIDEO_KEY_RE.test(k);
const isObject = (o) => o !== null && typeof o === "object" && !Array.isArray(o);

function hubLog(...args) {
  if (DEBUG) console.debug("[SegDown] hub", ...args);
}

function hubWarn(err) {
  console.warn("[SegDown] hub error:", err && err.message ? err.message : err);
}

// --- validation: each returns a fresh object with only known fields, or null ---

function cleanCandidate(v) {
  if (!isObject(v) || !isVideoKey(v.videoKey)) return null;
  if (!isTime(v.area) || !isDuration(v.duration) || typeof v.paused !== "boolean") return null;
  if (v.live !== undefined && typeof v.live !== "boolean") return null;
  if (!(v.excluded === null || EXCLUSIONS.has(v.excluded)) || !isTime(v.score)) return null;
  const out = {
    videoKey: v.videoKey,
    area: v.area,
    duration: v.duration,
    live: v.live === true,
    paused: v.paused,
    excluded: v.excluded,
    score: v.score,
  };
  if (v.currentSrc !== undefined) {
    if (typeof v.currentSrc !== "string") return null;
    if (v.currentSrc.length <= MAX_URL_LENGTH && httpURL(v.currentSrc)) out.currentSrc = v.currentSrc;
  }
  return out;
}

const HUB_VALIDATORS = new Map([
  [
    "candidates",
    (m) => {
      if (!Array.isArray(m.videos) || m.videos.length > MAX_CANDIDATES_PER_FRAME) return null;
      const videos = m.videos.map(cleanCandidate);
      return videos.every(Boolean) ? { videos } : null;
    },
  ],
  [
    "tick",
    (m) =>
      isVideoKey(m.videoKey) && isTime(m.currentTime) && isDuration(m.duration) && typeof m.paused === "boolean"
        ? { videoKey: m.videoKey, currentTime: m.currentTime, duration: m.duration, paused: m.paused }
        : null,
  ],
  ["key", (m) => (MARK_ACTIONS.has(m.action) ? { action: m.action } : null)],
  ["seek", (m) => (isTime(m.time) ? { time: m.time } : null)],
  ["getTime", () => ({})],
  ["play", () => ({})],
  ["pause", () => ({})],
  [
    "select",
    (m) =>
      Number.isInteger(m.frameId) && m.frameId >= 0 && isVideoKey(m.videoKey)
        ? { frameId: m.frameId, videoKey: m.videoKey }
        : null,
  ],
  ["getState", () => ({})],
  ["setPanelOpen", (m) => (typeof m.open === "boolean" ? { open: m.open } : null)],
  [
    "segmentsChanged",
    (m) => {
      const segments = cleanSegments(m.segments);
      return segments ? { segments } : null;
    },
  ],
  ["loadPage", () => ({})],
  [
    "savePage",
    (m) => {
      const segments = cleanSegments(m.segments);
      return segments && MODES.has(m.mode) && PRECISIONS.has(m.precision)
        ? { segments, mode: m.mode, precision: m.precision }
        : null;
    },
  ],
  ["savePos", (m) => (isFiniteNum(m.x) && isFiniteNum(m.y) ? { x: m.x, y: m.y } : null)],
]);

function cleanSegments(list) {
  if (!Array.isArray(list) || list.length > MAX_SEGMENTS) return null;
  const out = [];
  for (const s of list) {
    if (!isObject(s) || !isTime(s.start) || !isTime(s.end) || !(s.end > s.start)) return null;
    out.push({ start: s.start, end: s.end });
  }
  return out;
}

// Agent replies are checked too before the hub stores or forwards a time.
function cleanTimeReply(r) {
  return isObject(r) && r.ok === true && isTime(r.currentTime) && isDuration(r.duration) && typeof r.paused === "boolean"
    ? { ok: true, currentTime: r.currentTime, duration: r.duration, paused: r.paused }
    : null;
}

// --- storage (call inside withTab) ---

async function readHub(tabId) {
  const key = hubKey(tabId);
  const got = (await chrome.storage.session.get(key))[key];
  return {
    selected: got && got.selected ? got.selected : null,
    selectedBy: got && got.selectedBy === "user" ? "user" : "auto",
    panelOpen: Boolean(got && got.panelOpen),
    pendingStart: got && isTime(got.pendingStart) ? got.pendingStart : null,
  };
}

function writeHub(tabId, hub) {
  return chrome.storage.session.set({ [hubKey(tabId)]: hub });
}

async function readSegments(tabId) {
  const key = segsKey(tabId);
  return (await chrome.storage.session.get({ [key]: [] }))[key];
}

async function readCands(tabId) {
  const key = candKey(tabId);
  return (await chrome.storage.session.get({ [key]: {} }))[key];
}

function hasCandidate(cands, sel) {
  return Boolean(sel && (cands[sel.frameId] || []).some((v) => v.videoKey === sel.videoKey));
}

function mergeCandidates(cands) {
  return Object.keys(cands)
    .map(Number)
    .sort((a, b) => a - b)
    .flatMap((frameId) => cands[frameId].map((v) => ({ frameId, ...v })));
}

const sameSelection = (a, b) => (a && b ? a.frameId === b.frameId && a.videoKey === b.videoKey : a === b);

// Top-score main video across frames, or null (rules in the protocol comment).
function autoPick(cands) {
  const pool = mergeCandidates(cands).filter((c) => c.excluded === null);
  const hasLong = pool.some((c) => c.duration !== null && c.duration >= MIN_MAIN_DURATION);
  let best = null;
  for (const c of pool) {
    if (hasLong && c.duration !== null && c.duration < MIN_MAIN_DURATION) continue;
    if (!best || c.score > best.score || (c.score === best.score && c.area > best.area)) best = c;
  }
  return best ? { frameId: best.frameId, videoKey: best.videoKey } : null;
}

// Stores a frame's list (null = the frame is gone), drops a selection that no
// longer exists and re-runs the auto-pick. Returns {changed, cands, hub, prev,
// stateChanged}; prev is the selection before this update.
function setFrameCandidates(tabId, frameId, videos) {
  return withTab(tabId, async () => {
    const cands = await readCands(tabId);
    if (!(videos && videos.length) && !(frameId in cands)) return { changed: false, cands };
    if (videos && videos.length) cands[frameId] = videos;
    else delete cands[frameId];
    await chrome.storage.session.set({ [candKey(tabId)]: cands });
    const hub = await readHub(tabId);
    const prev = hub.selected;
    const prevBy = hub.selectedBy;
    if (prev && !hasCandidate(cands, prev)) {
      hub.selected = null;
      hub.selectedBy = "auto"; // the user's video is gone: fall back to auto
    }
    if (hub.selectedBy === "auto") hub.selected = autoPick(cands);
    const stateChanged = !sameSelection(prev, hub.selected) || prevBy !== hub.selectedBy;
    if (stateChanged) {
      if (!sameSelection(prev, hub.selected)) hub.pendingStart = null; // a start belongs to its video
      await writeHub(tabId, hub);
    }
    return { changed: true, cands, hub, prev, stateChanged };
  });
}

// --- sending to content scripts ---

// Fire-and-forget: a frame without a listener ("Receiving end does not exist") is normal.
function notify(tabId, msg, frameId) {
  const opts = frameId === undefined ? undefined : { frameId };
  chrome.tabs.sendMessage(tabId, msg, opts).catch(() => {});
}

const notifyPanel = (tabId, msg) => notify(tabId, { to: "panel", ...msg }, 0);
const notifyCompact = (tabId, frameId, msg) => notify(tabId, { to: "compact", ...msg }, frameId);
const notifyAll = (tabId, msg) => notify(tabId, { to: "all", ...msg });

async function askAgent(tabId, frameId, msg) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { to: "agent", ...msg }, { frameId });
    return isObject(reply) ? reply : { ok: false, error: "agent-no-reply" };
  } catch {
    // The frame is gone without a navigation event (e.g. its iframe was removed):
    // drop its videos so the auto-pick can move on.
    dropFrame(tabId, frameId);
    return { ok: false, error: "agent-unreachable" };
  }
}

function dropFrame(tabId, frameId) {
  setFrameCandidates(tabId, frameId, null)
    .then((result) => announceCandidates(tabId, result))
    .catch(hubWarn);
}

// --- handlers ---

async function onCandidates(tabId, frameId, { videos }) {
  announceCandidates(tabId, await setFrameCandidates(tabId, frameId, videos));
  return { ok: true };
}

function announceCandidates(tabId, { changed, cands, hub, prev, stateChanged }) {
  if (!changed) return;
  notifyPanel(tabId, { type: "candidates", candidates: mergeCandidates(cands) });
  if (!stateChanged) return;
  notifySelectionAgents(tabId, prev, hub.selected);
  notifyAll(tabId, { type: "state", state: hub });
  if (!sameSelection(prev, hub.selected)) {
    const s = hub.selected;
    hubLog(`auto-select tab=${tabId} ${s ? `frame=${s.frameId} video=${s.videoKey}` : "none"}`);
  }
}

// Tells the agents which video ticks: the old frame stops, the new one starts.
function notifySelectionAgents(tabId, prev, next) {
  if (sameSelection(prev, next)) return;
  if (prev && (!next || prev.frameId !== next.frameId)) {
    notify(tabId, { to: "agent", type: "select", videoKey: null }, prev.frameId);
  }
  if (next) notify(tabId, { to: "agent", type: "select", videoKey: next.videoKey }, next.frameId);
}

async function onTick(tabId, frameId, tick) {
  const { selected } = await withTab(tabId, () => readHub(tabId));
  if (selected && selected.frameId === frameId && selected.videoKey === tick.videoKey) {
    notifyPanel(tabId, { type: "tick", frameId, ...tick });
  }
  return { ok: true };
}

async function toSelected(tabId, cmd) {
  const { selected } = await withTab(tabId, () => readHub(tabId));
  if (!selected) return { ok: false, error: "no-selection" };
  const reply = await askAgent(tabId, selected.frameId, { ...cmd, videoKey: selected.videoKey });
  if (cmd.type === "getTime") return cleanTimeReply(reply) || { ok: false, error: reply.error || "bad-reply" };
  return reply.ok === true ? { ok: true } : { ok: false, error: typeof reply.error === "string" ? reply.error : "failed" };
}

async function onSelect(tabId, sel) {
  const result = await withTab(tabId, async () => {
    const cands = await readCands(tabId);
    if (!hasCandidate(cands, sel)) return null;
    const hub = await readHub(tabId);
    const prev = hub.selected;
    const next = { frameId: sel.frameId, videoKey: sel.videoKey };
    if (!sameSelection(prev, next) || hub.selectedBy !== "user") {
      if (!sameSelection(prev, next)) hub.pendingStart = null; // a start belongs to the video it was marked on
      hub.selected = next;
      hub.selectedBy = "user";
      await writeHub(tabId, hub);
    }
    return { hub, prev };
  });
  if (!result) return { ok: false, error: "unknown-video" };
  const { hub, prev } = result;
  notifySelectionAgents(tabId, prev, hub.selected);
  notifyAll(tabId, { type: "state", state: hub });
  hubLog(`select tab=${tabId} frame=${sel.frameId} video=${sel.videoKey}`);
  return { ok: true, state: hub };
}

// Keys come from any frame, so a failure is also relayed to the panel (the
// frame that sent the key has no UI to show it) and to the compact panel.
function keyFailed(tabId, selected, action, error) {
  notifyPanel(tabId, { type: "markError", action, error });
  if (selected) notifyCompact(tabId, selected.frameId, { type: "markError", action, error });
  return { ok: false, error };
}

async function onKey(tabId, { action }) {
  const { selected } = await withTab(tabId, () => readHub(tabId));
  if (!selected) return keyFailed(tabId, null, action, "no-selection");
  const reply = await askAgent(tabId, selected.frameId, { type: "getTime", videoKey: selected.videoKey });
  const t = cleanTimeReply(reply);
  if (!t) return keyFailed(tabId, selected, action, typeof reply.error === "string" ? reply.error : "bad-reply");
  const time = t.currentTime;
  const result = await withTab(tabId, async () => {
    const h = await readHub(tabId);
    if (!sameSelection(h.selected, selected)) return { error: "selection-changed" };
    const start = h.pendingStart;
    if (action === "markStart") {
      h.pendingStart = time;
      h.selectedBy = "user"; // an auto re-pick would drop the start
    } else {
      if (start === null) return { error: "no-start" };
      if (time <= start) return { error: "end-not-after-start" }; // keep the start
      h.pendingStart = null;
    }
    await writeHub(tabId, h);
    return { hub: h, start };
  });
  if (result.error) return keyFailed(tabId, selected, action, result.error);
  const { hub } = result;
  const mark = { action, time, ...selected };
  if (action === "markEnd") Object.assign(mark, { start: result.start, end: time });
  notifyPanel(tabId, { type: "mark", ...mark });
  notifyCompact(tabId, selected.frameId, { type: "mark", ...mark });
  notifyAll(tabId, { type: "state", state: hub });
  hubLog(`${action} tab=${tabId} time=${time}`);
  return { ok: true, ...mark };
}

// open: true/false sets panelOpen, null flips it. Sends the new state to every frame.
async function setPanelOpen(tabId, open) {
  const hub = await withTab(tabId, async () => {
    const h = await readHub(tabId);
    h.panelOpen = open === null ? !h.panelOpen : open;
    await writeHub(tabId, h);
    return h;
  });
  notifyAll(tabId, { type: "state", state: hub });
  hubLog(`panelOpen tab=${tabId} ${hub.panelOpen}`);
  return { ok: true, state: hub };
}

// Stores the top panel's list; relays it to the selected video's frame (the
// only frame that can hold the compact panel) when it changed.
async function onSegmentsChanged(tabId, frameId, { segments }) {
  if (frameId !== 0) return { ok: false, error: "not-top-frame" };
  const selected = await withTab(tabId, async () => {
    const prev = await readSegments(tabId);
    if (JSON.stringify(prev) === JSON.stringify(segments)) return undefined;
    await chrome.storage.session.set({ [segsKey(tabId)]: segments });
    return (await readHub(tabId)).selected;
  });
  if (selected) notifyCompact(tabId, selected.frameId, { type: "segments", segments });
  return { ok: true };
}

// Explicit field map: header values and cookies never leave the service worker.
function summarizeCaptures({ entries, active }) {
  const out = { entries: [], active: {} };
  for (const e of entries) {
    out.entries.push({ url: e.url, frameId: e.frameId, kind: e.kind, isMaster: e.isMaster === true, ts: e.ts });
  }
  for (const [frameId, a] of Object.entries(active)) out.active[frameId] = { count: a.count, ts: a.ts };
  return out;
}

// Subframes (possibly third-party) get no URLs: see getState in the protocol.
async function onGetState(tabId, frameId) {
  const { hub, cands, segments } = await withTab(tabId, async () => ({
    hub: await readHub(tabId),
    cands: await readCands(tabId),
    segments: await readSegments(tabId),
  }));
  if (frameId !== 0) {
    const reply = { ok: true, state: hub };
    if (hub.selected && hub.selected.frameId === frameId) reply.segments = segments;
    return reply;
  }
  const captures = summarizeCaptures(await getCaptures(tabId)); // own withTab; never nest
  return { ok: true, state: hub, candidates: mergeCandidates(cands), captures, segments };
}

// --- panel persistence (3.7; rules under "Panel persistence" in the protocol) ---

// `seg:` + the URL without its hash, or null.
function pageKeyOf(url) {
  try {
    const u = new URL(url);
    return `seg:${u.origin}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

async function readPageRecord(tabId) {
  const key = pageKey(tabId);
  const rec = (await chrome.storage.session.get(key))[key];
  return isObject(rec) && typeof rec.key === "string" ? rec : null;
}

function onLoadPage(tabId, frameId, from) {
  if (frameId !== 0) return { ok: false, error: "not-top-frame" };
  const key = pageKeyOf(from.url);
  if (!key) return { ok: false, error: "no-url" };
  return withTab(tabId, async () => {
    await chrome.storage.session.set({ [pageKey(tabId)]: { key, documentId: from.documentId } });
    const got = await chrome.storage.local.get([key, PREFS_KEY, POS_KEY]);
    const value = (k) => (got[k] === undefined ? null : got[k]);
    return { ok: true, page: value(key), prefs: value(PREFS_KEY), pos: value(POS_KEY) };
  });
}

async function onSavePage(tabId, frameId, from, { segments, mode, precision }) {
  if (frameId !== 0) return { ok: false, error: "not-top-frame" };
  const saved = await withTab(tabId, async () => {
    const rec = await readPageRecord(tabId);
    const key = rec && rec.documentId === from.documentId ? rec.key : pageKeyOf(from.url);
    if (!key) return null;
    const prefs = { mode, precision };
    await chrome.storage.local.set({ [PREFS_KEY]: prefs });
    if (!segments.length) await chrome.storage.local.remove(key);
    else await chrome.storage.local.set({ [key]: { segments, ...prefs, ts: Date.now() } });
    return { pruneNeeded: segments.length > 0 };
  });
  if (!saved) return { ok: false, error: "no-url" };
  if (saved.pruneNeeded) await prunePages();
  return { ok: true };
}

// Keeps the MAX_PAGES most recent seg:* entries.
async function prunePages() {
  const all = await chrome.storage.local.get(null);
  const pages = Object.keys(all).filter((k) => k.startsWith("seg:"));
  if (pages.length <= MAX_PAGES) return;
  const ts = (k) => (all[k] && Number.isFinite(all[k].ts) ? all[k].ts : 0);
  pages.sort((a, b) => ts(b) - ts(a));
  await chrome.storage.local.remove(pages.slice(MAX_PAGES));
}

async function onSavePos(frameId, pos) {
  if (frameId !== 0) return { ok: false, error: "not-top-frame" };
  await chrome.storage.local.set({ [POS_KEY]: pos });
  return { ok: true };
}

// pushState / replaceState in the top frame (see the protocol). A URL that keys
// the page already loaded (same URL, or only the hash changed) is not a change.
async function onPageChanged(tabId, url) {
  const key = pageKeyOf(url);
  const hub = await withTab(tabId, async () => {
    const rec = await readPageRecord(tabId);
    if (rec && rec.key === key) return null;
    const h = await readHub(tabId);
    h.pendingStart = null; // a start belongs to the page it was marked on
    await writeHub(tabId, h);
    await chrome.storage.session.remove(segsKey(tabId));
    return h;
  });
  if (!hub) return;
  if (hub.selected) notifyCompact(tabId, hub.selected.frameId, { type: "segments", segments: [] });
  notifyAll(tabId, { type: "state", state: hub });
  notifyPanel(tabId, { type: "pageChanged" });
  hubLog(`pageChanged tab=${tabId}`);
}

// Single entry point for every hub message (the listener and the debug helper).
// tabId/frameId and from = {url, documentId} come from the sender, never from msg.
function hubDispatch(tabId, frameId, msg, from = {}) {
  const body = HUB_VALIDATORS.has(msg.type) ? HUB_VALIDATORS.get(msg.type)(msg) : null;
  if (!body) return Promise.resolve({ ok: false, error: "bad-message" });
  switch (msg.type) {
    case "candidates":
      return onCandidates(tabId, frameId, body);
    case "tick":
      return onTick(tabId, frameId, body);
    case "key":
      return onKey(tabId, body);
    case "seek":
    case "getTime":
    case "play":
    case "pause":
      return toSelected(tabId, { type: msg.type, ...body });
    case "select":
      return onSelect(tabId, body);
    case "getState":
      return onGetState(tabId, frameId);
    case "setPanelOpen":
      return setPanelOpen(tabId, body.open);
    case "segmentsChanged":
      return onSegmentsChanged(tabId, frameId, body);
    case "loadPage":
      return Promise.resolve(onLoadPage(tabId, frameId, from));
    case "savePage":
      return onSavePage(tabId, frameId, from, body);
    case "savePos":
      return onSavePos(frameId, body);
    default:
      return Promise.resolve({ ok: false, error: "bad-message" });
  }
}

// --- listeners (registered synchronously at top level) ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return undefined;
  if (!isObject(msg) || !HUB_VALIDATORS.has(msg.type)) return undefined; // not a hub message
  const tabId = sender.tab && sender.tab.id;
  if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(sender.frameId) || sender.frameId < 0) {
    return undefined;
  }
  const from = { url: sender.url, documentId: sender.documentId };
  hubDispatch(tabId, sender.frameId, msg, from).then(sendResponse, (err) => {
    hubWarn(err);
    sendResponse({ ok: false, error: "internal" });
  });
  return true; // async reply
});

// A subframe that navigates takes its videos with it (top-frame navigation clears
// the whole tab in the capture section).
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId > 0) dropFrame(details.tabId, details.frameId);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) onPageChanged(details.tabId, details.url).catch(hubWarn);
});

// Content scripts reach storage.local only through loadPage / savePage / savePos.
// Not every browser supports an access level for storage.local; then this only logs.
try {
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(hubWarn);
} catch (err) {
  hubWarn(err);
}

// Toolbar button and keyboard shortcut (3.5). From 4.4 the popup's "Toggle panel"
// button replaces the action click.
function togglePanelIn(tab) {
  if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return;
  setPanelOpen(tab.id, null).catch(hubWarn);
}

chrome.action.onClicked.addListener(togglePanelIn);

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-panel") return;
  if (tab) return togglePanelIn(tab);
  chrome.tabs
    .query({ active: true, currentWindow: true })
    .then((tabs) => togglePanelIn(tabs[0]))
    .catch(hubWarn);
});

// --- debug (service-worker console only) ---

// segdownDebugSeek(tabId, seconds): seeks the selected video (the auto-picked
// main video unless the user chose one). Goes through hubDispatch like the panel.
function segdownDebugSeek(tabId, time) {
  return hubDispatch(tabId, 0, { type: "seek", time });
}
