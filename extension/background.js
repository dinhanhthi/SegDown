// SegDown background service worker (classic script, no modules).
// Sections: config, media capture (3.2), hub + frame routing (3.3, auto-pick 3.4,
// overlay toggle 3.5, marking 3.6, hub-owned segments and their persistence,
// selected-frame gating, source correlation 4.1, HLS variant picker 4.2, send the
// job 4.3, progress + cancel 4.4, app settings, incognito and the overlay view 5.2).

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
// Within the tab cap, so one frame (e.g. a page flooding fake .m3u8 requests)
// cannot evict another frame's playlist.
const MAX_ENTRIES_PER_FRAME = 20;
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
//       top:<tabId> -> the top frame's http(s) URL, from webNavigation (never from a content script)
//       hub:<tabId>, cand:<tabId>, segs:<tabId>, page:<tabId>, src:<tabId>, probe:<tabId>, var:<tabId>,
//       jobs:<tabId> and inc:<tabId> belong to the hub (see the hub section).
// isMaster comes from the app's probe (4.2): set on every entry with the probed URL,
// and on entries captured later from the probe:<tabId> cache.
// At most MAX_ENTRIES_PER_FRAME entries per frame (that frame's oldest mp4 goes
// first, then its oldest entry) and MAX_ENTRIES_PER_TAB per tab (taken from the
// frame with the most entries, same order).
// Never call storage.session.setAccessLevel: Cookie values live here. (storage.local,
// the saved segments and the app's ui switches, is owned by the hub; see the end
// of its section.)
// ---------------------------------------------------------------------------

const capKey = (tabId) => `cap:${tabId}`;
const actKey = (tabId) => `act:${tabId}`;
const hubKey = (tabId) => `hub:${tabId}`;
const candKey = (tabId) => `cand:${tabId}`;
const segsKey = (tabId) => `segs:${tabId}`;
const pageKey = (tabId) => `page:${tabId}`;
const srcKey = (tabId) => `src:${tabId}`;
const topKey = (tabId) => `top:${tabId}`;
const probeKey = (tabId) => `probe:${tabId}`;
const varKey = (tabId) => `var:${tabId}`;
const jobsKey = (tabId) => `jobs:${tabId}`;
const incKey = (tabId) => `inc:${tabId}`;

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
  const got = await chrome.storage.session.get({ [key]: [], [probeKey(tabId)]: {} });
  const entries = got[key];
  const probed = got[probeKey(tabId)][entry.url];
  if (probed && Array.isArray(probed.variants)) entry.isMaster = probed.variants.length > 0;
  const index = entries.findIndex((e) => e.url === entry.url);
  const isNew = index < 0;
  if (!isNew) entries.splice(index, 1); // dedupe by URL (mp4 Range requests, playlist refetches)
  entries.push(entry);
  const inFrame = () => entries.filter((e) => e.frameId === entry.frameId).length;
  while (inFrame() > MAX_ENTRIES_PER_FRAME) dropOldest(entries, entry.frameId);
  while (entries.length > MAX_ENTRIES_PER_TAB) dropOldest(entries, largestFrame(entries));
  await chrome.storage.session.set({ [key]: entries });
  if (DEBUG && isNew) {
    console.debug(
      `[SegDown] capture tab=${tabId} frame=${entry.frameId} kind=${entry.kind} headers=[${Object.keys(entry.headers).join(", ")}]`
    );
  }
}

// Removes one entry of frameId: its oldest mp4 first, so segment churn never
// evicts a playlist, else its oldest entry.
function dropOldest(entries, frameId) {
  let i = entries.findIndex((e) => e.frameId === frameId && e.kind === "mp4");
  if (i < 0) i = entries.findIndex((e) => e.frameId === frameId);
  entries.splice(i, 1);
}

// The frame with the most entries (ties: the one holding the oldest entry).
function largestFrame(entries) {
  const counts = new Map();
  for (const e of entries) counts.set(e.frameId, (counts.get(e.frameId) || 0) + 1);
  let best = entries[0].frameId;
  for (const [frameId, n] of counts) if (n > counts.get(best)) best = frameId;
  return best;
}

async function bumpActive(tabId, frameId, url, ts) {
  const key = actKey(tabId);
  const active = (await chrome.storage.session.get({ [key]: {} }))[key];
  const prev = active[frameId];
  active[frameId] = { lastChunkUrl: url, count: (prev ? prev.count : 0) + 1, ts };
  await chrome.storage.session.set({ [key]: active });
}

// Bumped by clearTab, so a probe that was in flight does not write into the next page.
const tabGens = new Map();
const tabGen = (tabId) => tabGens.get(tabId) || 0;

function clearTab(tabId) {
  tabGens.set(tabId, tabGen(tabId) + 1);
  return withTab(tabId, () =>
    chrome.storage.session.remove([
      capKey(tabId),
      actKey(tabId),
      hubKey(tabId),
      candKey(tabId),
      segsKey(tabId),
      pageKey(tabId),
      srcKey(tabId),
      topKey(tabId),
      probeKey(tabId),
      varKey(tabId),
      jobsKey(tabId),
    ])
  );
}

// The top frame's URL for the yt-dlp page source (4.1). Only http(s) URLs are kept.
function setTopURL(tabId, url) {
  return withTab(tabId, () =>
    httpURL(url) && url.length <= MAX_URL_LENGTH
      ? chrome.storage.session.set({ [topKey(tabId)]: url })
      : chrome.storage.session.remove(topKey(tabId))
  );
}

// ---------------------------------------------------------------------------
// Media capture: listeners (registered synchronously at top level)
// ---------------------------------------------------------------------------

function onSendHeaders(details) {
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
}

// Safari rejects the "extraHeaders" option (and never exposes Cookie): register without it.
try {
  chrome.webRequest.onSendHeaders.addListener(onSendHeaders, { urls: ["<all_urls>"] }, [
    "requestHeaders",
    "extraHeaders",
  ]);
} catch {
  chrome.webRequest.onSendHeaders.addListener(onSendHeaders, { urls: ["<all_urls>"] }, ["requestHeaders"]);
}

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
    // isMaster: from an earlier probe of this URL (addEntry), else set by the 4.2 probe.
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
  // inc:<tabId> belongs to the tab, not the page: it survives navigation (clearTab).
  withTab(tabId, () => chrome.storage.session.remove(incKey(tabId))).catch(logError);
});

// clearTab, setTopURL and restoreSegments share the tab queue, so the new URL lands
// after the clear and the page's saved segments are read for that URL.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  clearTab(details.tabId).catch(logError);
  setTopURL(details.tabId, details.url).catch(logError);
  restoreSegments(details.tabId).catch(logError);
});

// ---------------------------------------------------------------------------
// Hub + frame routing (3.3)
//
// Message protocol. The agent, the overlay and the player button follow it;
// change it here first.
//
// Content -> hub: chrome.runtime.sendMessage({type, ...}). The hub takes the tab
// and frame ONLY from sender.tab.id / sender.frameId, never from the body. It
// ignores other extensions (sender.id), senders without a tab, and types it does
// not own (no sendResponse, so later onMessage listeners still get them). A
// malformed hub message gets {ok: false, error: "bad-message"}. Every hub reply
// has `ok`; failures add `error`.
//
// Selected frame. The overlay lives in the frame that holds the selected video
// (hub:<tabId>.selected.frameId), which may be a cross-origin (even ad) iframe:
// its message bodies are untrusted and the hub only takes menu choices from them
// (an output mode, an incognito flag, the full-clip flag, indexes into the hub's
// own lists), never a URL, headers, a title, segment times or a duration. The
// types marked [selected] below are accepted only from that frame (else {ok:
// false, error: "not-selected-frame"}); their replies are summaries (no URLs, no
// header values, no captures). Two exceptions: while nothing is selected, a frame
// may `select` one of its own videos (frameId = its sender.frameId), so it can
// claim the overlay; and `openOverlay` (the player button) is accepted from any
// frame, for its own videos only.
//
//   Agent (every frame, owns that frame's <video> elements):
//   candidates {videos: [{videoKey, area, duration, live, paused, excluded, score,
//              currentSrc?, videoId?}]}
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
//              else omitted. videoId: digits only (1-25), Facebook's
//              data-video-id of the video's container, else omitted. width,
//              height (optional): the video's intrinsic size, integers
//              1...100000, kept only as a pair (labels in `view`). At most 20
//              videos (the top scores when a frame has more). Agents re-send
//              only when a field the hub uses changes (the score in coarse
//              buckets, so scrolling rarely re-sends), and
//              send [] on pagehide (a removed iframe takes its videos with it).
//              -> {ok}. The hub re-runs the auto-pick (below).
//   key        {action: "markStart" | "markEnd"} from any frame (3.6 keyboard:
//              `[` / `]`) or from the overlay's buttons. The hub asks the
//              selected agent for getTime. markStart stores pendingStart
//              (replacing an older one) and sets selectedBy "user", so an auto
//              re-pick cannot drop the start. markEnd needs a pendingStart
//              ("no-start"), a time after it ("end-not-after-start") and fewer
//              than MAX_SEGMENTS segments ("too-many-segments"); on those errors
//              the start is kept so the user can seek on and mark again. On
//              success it appends {start, end} to segs:<tabId> (see Segments) and
//              clears pendingStart.
//              -> {ok, action, time, frameId, videoKey} (markEnd adds start and
//              end = time), also relayed to the selected video's frame as
//              `mark`. Failures ("no-selection", "selection-changed", agent
//              errors and the three above) -> {ok: false, error}, also relayed
//              there as `markError`.
//
//   Overlay (the selected video's frame), all aimed at the selected video, so
//   they carry no target:
//   seek {time} | play | pause [selected] -> the agent's reply ({ok} or {ok:
//              false, error}). An agent that cannot be reached
//              ("agent-unreachable": its frame was removed without a navigation
//              event) loses its candidates, which re-runs the auto-pick.
//   getTime [selected]          -> {ok, currentTime, duration, paused}
//   select {frameId, videoKey} [selected; with nothing selected, also from the
//              frame frameId itself] must match a reported candidate ->
//              {ok, state}. Sets selectedBy "user". Changing the video clears
//              pendingStart (the overlay moves to the new video's frame).
//   setPanelOpen {open: boolean} [selected] -> {ok, state} (the overlay's
//              close button); sends state to "all" like the toggle. panelOpen
//              stays false while nothing is selected.
//   getState   any frame -> {ok, state, ui}, plus `segments` (segs:<tabId>, []
//              if none) only in the selected video's frame. ui: the app's
//              switches {fullClipButton, playerButton} from storage.local `ui`
//              (both true when nothing is stored; then it also pings the app,
//              not awaited, so the pong's `ui` broadcast follows once the app
//              is reachable; onInstalled pings too). Agents send it once at load
//              (and after a back/forward cache restore) for state.panelOpen and
//              ui (a frame that loads after the overlay opened missed the
//              `state` broadcast).
//   openOverlay {videoKey} any frame, NOT [selected] (the player button):
//              frameId is always the sender's, never the body's. videoKey must
//              be one of that frame's candidates with excluded null (else {ok:
//              false, error: "no-video"}). Selects it like `select` (selectedBy
//              "user"; its errors pass through), opens the panel like
//              setPanelOpen {open: true} (state to "all"), then sends
//              toggleOverlay {open: true} to that frame. -> {ok, state}.
//
//   Segments. The hub owns the tab's segments: segs:<tabId> in storage.session,
//   a list sorted by start (then end) of at most MAX_SEGMENTS {start, end,
//   done?: true} (finite, >= 0, end > start), written only by markEnd,
//   removeSegment, clearSegments, the page load below and the status handler
//   (Downloaded segments); the pending start is hub:<tabId>.pendingStart. done
//   is set only by that status handler: markEnd creates segments without it,
//   and removing or clearing a segment drops its flag with it. After every
//   change the list is relayed to the selected video's frame as `segments` and
//   saved (Segment persistence).
//   removeSegment {index} [selected]: index into segs:<tabId> -> {ok, segments},
//              or {ok: false, error: "unknown-segment"} when out of range.
//   clearSegments [selected] -> {ok, segments: []}.
//
//   Segment persistence. The page key is `seg:` + the top frame's http(s) URL
//   without its hash, always taken from top:<tabId> (webNavigation), never from a
//   sender or a body. On a top-frame commit (after the tab is cleared) and on a
//   same-document page change (below) the hub loads seg:<key> from storage.local
//   into segs:<tabId> (an invalid entry loads as []) and records the key in
//   page:<tabId>. Every change of segs:<tabId> writes {segments, ts} to the
//   current key (an empty list removes the entry; the MAX_PAGES most recent
//   seg:* entries are kept) - but only once persistence is allowed: nothing is
//   written to storage.local before a pong of this worker's life (the hub pings
//   the app first when it has had none; a pong without settings counts as
//   incognitoDefault false), and nothing for a tab that is incognito (below).
//   That first pong saves every tab's non-empty segs:<tabId> marked before it
//   (each tab's incognito state applies). Segments marked while persistence is
//   not allowed stay in storage.session only. The load skips storage.local for a
//   tab known to be incognito (segs:<tabId> starts as []); before the first pong
//   a tab without an inc:<tabId> choice loads (reading leaves no trace).
//
//   Downloaded segments. When a status reply (Progress + cancel) shows a job
//   "done" whose jobt entry has a page and no applied, the hub marks the entry
//   applied (so it is applied once) and sets done: true on the segments whose
//   start and end both equal one of page.ranges: in seg:<page.key>
//   (storage.local) only when that record exists (never creates one), and in
//   segs:<tabId> of every tab whose page:<tabId>.key is page.key; those tabs'
//   selected frames get `segments`. No pong gate: the job was judged not
//   incognito at enqueue and only an existing record changes. Failed and
//   cancelled jobs flag nothing; full-clip and incognito jobs carry no page, so
//   they never flag. `view` also asks the app when this page has a pending
//   entry, so a page reloaded or reopened before its job finished is flagged on
//   its next view. Known limit: "done" is learned only from a status call
//   (`jobs` / `view`) made while the jobt entry exists (storage.session, lost
//   when the browser quits).
//
//   Incognito. A tab is incognito when it belongs to a browser private window
//   (sender.tab.incognito, or chrome.tabs.get(tabId).incognito where there is no
//   sender; a tab that cannot be read counts as private; this includes Chrome's
//   shared "spanning" storage) - forced on, cannot be changed - else when
//   inc:<tabId> (storage.session, the overlay's choice; kept across navigation,
//   removed with the tab) is true, else when the app's settings.incognitoDefault
//   is true. An incognito tab neither loads nor writes seg: entries; its jobs go
//   into jobs:<tabId> as {jobId, ts} (no title) and never into jobt, so its job
//   ids live only in storage.session.
//   setIncognito {on: boolean} [selected] -> {ok, incognito: {on, forced:
//              false}}: stores inc:<tabId>. on: true also deletes the page's
//              seg:<key> entry (key from top:<tabId>); on: false saves the
//              current segments when persistence is allowed. In a private
//              window -> {ok: false, error: "incognito-forced", incognito: {on:
//              true, forced: true}}.
//
//   Source correlation (4.1). Content scripts only ever get a source summary
//   {kind: "hls" | "mp4" | "page", host, file (last path component, no query),
//   frameId, via: "currentSrc" | "capture" | "page" | "user"}, never the URL's
//   query or header values. The full Source (URL + captured headers) stays in
//   this worker: resolveSource(tabId) builds it for the job (4.3).
//   getSource [selected] -> {ok, source: summary | null} (null: nothing
//              captured and no http(s) top URL). For an hls source the summary
//              adds the 4.2 variant fields (below). Also starts the probe when
//              one is due and the overlay is open.
//   chooseSource {index} [selected]: index into the source list: the tab's hls
//              and mp4 captures (cap:<tabId>) sorted by frameId, then URL (a
//              re-fetch moves an entry to the end of cap:<tabId>, so that order
//              is not used). -> {ok, source: summary}, or {ok: false, error:
//              "unknown-source"} when out of range. The choice (src:<tabId>)
//              overrides the auto order until the selected video or the page
//              changes.
//   Order (first match wins; `selected` is hub:<tabId>.selected):
//     1. the user's choice (via "user");
//     2. the selected candidate's currentSrc (http(s) only, via "currentSrc"):
//        kind and headers from the capture with the same URL, else kind from
//        the path (.m3u8 -> hls, otherwise mp4) and no headers;
//     3. in the selected video's frame, the newest hls capture with isMaster,
//        then the newest hls capture (isMaster is unknown until a probe), then
//        the newest mp4 (via "capture");
//     4. tab-wide, when that frame has nothing (or nothing is selected): frames
//        with active .ts/.m4s chunks (act:<tabId>) first, then hls before mp4,
//        then a probed master (4.2), then the newest (via "capture", with the
//        capture's own frameId; chooseSource picks another one);
//     5. the page URL for yt-dlp, from top:<tabId> (via "page"); for a Facebook
//        top URL and a selected frame-0 candidate with videoId, https://<top
//        host>/watch/?v=<videoId> instead. A page source {type: "page", url}
//        has no headers (yt-dlp fetches the page itself), no probe and no
//        variants.
//
//   HLS variant picker (4.2). Only this worker talks to the app:
//   chrome.runtime.sendNativeMessage(NATIVE_HOST, {type: "probe", source:
//   {type: "media", url, kind: "hls", headers}}) -> {type: "variants", variants:
//   [{url, bandwidth, resolution?: {width, height} | null, audioGroup?}]} ([] for
//   a media playlist) or {type: "error", code, message}. getSource and
//   chooseSource start a probe run while the overlay is open (one per tab at a
//   time, in the background):
//   it probes the resolved hls source when its URL has no cached result (a
//   failure is retried after PROBE_RETRY_MS, a success is kept until the tab is
//   cleared). When that source came from the capture order and is a media
//   playlist (players fetch the variant playlists after the master), it then
//   probes the same frame's other hls captures with unknown isMaster, oldest
//   first, until one is a master; at most MAX_PROBES_PER_RUN probes, stopping at
//   the first failure. Each result sets isMaster on the captures with that URL
//   (variants non-empty), so the order above prefers the master. A run that
//   stored anything sends `sourceChanged` to the selected video's frame.
//   Summary fields for an hls source (numbers only, never variant URLs):
//     probe {state: "pending"} (not probed yet) | {state: "error", message}
//       (message: "SegDown app not reachable: install browser integration" when
//       the native call fails, else the app's message);
//     variants [{width, height (null when the playlist has no RESOLUTION),
//       bandwidth}], highest bandwidth first (ties: playlist order, so index 0
//       is the variant the app picks by default), and variant: the chosen index.
//   chooseVariant {index} [selected]: index into the current source's variants.
//              -> {ok, source: summary}, or {ok: false, error: "unknown-variant"}
//              when out of range. Index 0 removes the choice. The choice
//              (var:<tabId>) holds for that source and selected video until
//              either changes or the page changes.
//   resolveSource adds variantURL only for a non-default choice: without it the
//   app fetches the master itself and also takes the variant's separate audio
//   rendition; with it the app uses that playlist as is (a separate audio
//   rendition is not added). audioURL is never set.
//
//   deps [selected] -> {ok, missing: [tool], appError?}: the tools the app
//              reports missing, each one of "yt-dlp" | "ffmpeg" | "ffprobe" |
//              "deno" (others dropped). The hub asks the app
//              chrome.runtime.sendNativeMessage(NATIVE_HOST, {type: "ping"}) ->
//              {type: "pong", version, missing: [string], protocol?, settings?:
//              {mode, incognitoDefault, maxDuration?, fullClipButton?,
//              playerButton?}}, at most once per DEPS_TTL_MS (10 s; one cached
//              answer for every tab, also for the settings; concurrent callers
//              share one request). protocol: an integer >= 1, absent -> 1.
//              settings are checked field by field: mode "separate" | "merged"
//              (else "separate"), incognitoDefault (true only when true, so an
//              app without settings gives false), maxDuration (seconds, finite >
//              0, else no limit), fullClipButton and playerButton (false only
//              when false, so absent -> true). Every pong sets the persistence
//              gate to settings.incognitoDefault (Segment persistence) and keeps
//              storage.local `ui` equal to the two switches (written, and sent
//              as `ui` to "all" in every tab (below), only when they differ
//              from the stored value). A ping without a pong leaves `ui` as it
//              is (never pinged: both true). Any other reply or a failed call
//              -> missing [] and appError (APP_UNREACHABLE when the call fails),
//              cached the same way. appError blocks nothing here; Download
//              pings again when the cached answer is a failure and refuses
//              while the app still does not answer (below).
//
//   Send the job (4.3).
//   download {mode?: "separate" | "merged", incognito?: boolean, full?: boolean}
//              [selected]: the overlay's Download button (full: true for its
//              Full clip button). Every other field is ignored. The hub builds
//              the rest from its own state: segments from segs:<tabId> ([] ->
//              {ok: false, error: "no-segments"}; not read for full); then the
//              app's pong (deps; still failing -> the app-unreachable /
//              app-error replies below); the effective incognito = the tab is
//              incognito (Incognito) || body incognito (the body can turn it
//              on, never off), refused with {ok: false, error: "app-outdated",
//              message: "Update the SegDown app to download incognito"} when the
//              pong's protocol < 2; the source from resolveSource(tabId) (with
//              captured headers and the chooseSource / chooseVariant choices;
//              null -> {ok: false, error: "no-source"}): when it is media, the user
//              pinned neither the source (chooseSource) nor a non-default
//              variant (chooseVariant), protocol >= 2 and top:<tabId> holds an
//              http(s) URL, the job gets source = {type: "page", url: page URL}
//              and fallback = that media (the app tries yt-dlp first); otherwise
//              source = the resolved source and no fallback. mediaDuration: the
//              selected candidate's duration when finite > 0, else omitted.
//              pageURL: the top URL (top:<tabId>) when it is http(s), else
//              omitted (the window's card opens it; older apps ignore it); for
//              a Facebook top URL and a selected frame-0 candidate with videoId,
//              https://<top host>/watch/?v=<videoId> instead (page source too).
//              full: true ignores the marked segments (segs:<tabId> is neither
//              read nor written) and sends one segment {start: 0, end: that
//              duration}; without one -> {ok: false, error: "no-duration"} (live
//              or unknown), over settings.maxDuration -> {ok: false, error:
//              "over-limit"} (both checked after the source).
//              mode: the body's, else settings.mode ("separate" without
//              settings). The title comes from the tab (sender.tab.title, else
//              chrome.tabs.get), never from the body or the frame's document:
//              control characters (U+0000-U+001F, U+007F-U+009F) become spaces,
//              trimmed, the first MAX_TITLE_CHARS code points kept (the app
//              counts characters, which are never more than code points, and
//              sanitizes it again). precision is always "precise" (required on
//              the wire; the app replaces it with its own setting). Apart from
//              a full clip's over-limit, the hub refuses neither a missing tool
//              nor a total over maxDuration (the overlay disables Download and
//              Full clip from `view`; the app checks both).
//              Then:
//              chrome.runtime.sendNativeMessage(NATIVE_HOST, {type: "enqueue", job:
//              {source, title, segments: [{start, end}] (never done), mode,
//              precision, fallback?, mediaDuration?, pageURL?, incognito?: true}}) ->
//                {type: "enqueued", id} -> {ok, jobId}; {jobId, title, ts} is
//                  appended to jobs:<tabId> (for 4.4; {jobId, ts} for an
//                  incognito job);
//                {type: "error", code, message} -> {ok: false, error: "app-error",
//                  code, message} (the app's message, e.g. a validation error);
//                the native call fails -> {ok: false, error: "app-unreachable",
//                  message: "SegDown app not reachable: install browser integration"};
//                any other reply -> {ok: false, error: "app-error", code:
//                  "internal", message}.
//              The reply never carries the source, its URL or headers. The
//              overlay disables the button while a call is in flight; the hub
//              does not dedupe (two clicks are two jobs). The id and title of a
//              job that is not incognito also go into jobt (below), which
//              survives the tab's navigation; a job that is not a full clip
//              adds page: {key, ranges} (key: the page key of top:<tabId>, read
//              with segs:<tabId> at the start of the download, never from the
//              body; ranges: the job's segments) for Downloaded segments.
//
//   Progress + cancel (4.4).
//   jobs [selected] -> {ok, jobs: [job], appError?}: this tab's jobs
//              (jobs:<tabId>), newest first. job = {id, title, state: "queued" |
//              "running" | "done" | "failed" | "cancelled" | "unknown",
//              segmentIndex (0-based, < segmentCount), segmentCount, fraction
//              (0...1, the whole job), message (string | null, the app's text,
//              e.g. "Media link expired or forbidden (HTTP 403/410). Play the
//              video again and retry."), outputs (file names only, never
//              folders), bytes (integer >= 0 downloaded so far, null when the
//              app does not say), fallbackUsed (true once the job switched to
//              its media fallback)}. title: the stored one, else "Job " + the
//              id's first 8 characters (incognito jobs store none). "unknown":
//              the app's status does not list the id (the app restarted or
//              dropped it). An empty jobs:<tabId> answers []
//              without asking the app. Else the hub asks the app {type:
//              "status"} (all jobs; concurrent callers share one request) ->
//              {type: "status", jobs: [JobStatus]}; every field is checked and
//              copied (fraction clamped, message capped at MAX_MESSAGE_CHARS,
//              outputs reduced to their last path component). When that fails,
//              appError carries the reason and the jobs keep the last status
//              this worker saw (or "unknown").
//   cancel {id} [selected]: id: [A-Za-z0-9-]{1,64}, and one of this tab's
//              jobs:<tabId> ids (else {ok: false, error: "unknown-job"}).
//              chrome.runtime.sendNativeMessage(NATIVE_HOST, {type: "cancel", id})
//                {type: "cancelled", id} -> {ok};
//                {type: "error", code, message} -> {ok: false, error: "app-error",
//                  code, message};
//                the native call fails -> {ok: false, error: "app-unreachable",
//                  message: APP_UNREACHABLE}; any other reply -> app-error
//                  "internal".
//   Polling: the overlay asks `jobs` every JOBS_POLL_MS (1 s) while a listed job
//   is queued or running, plus once when it opens and after a Download or
//   Cancel. The hub sends `status` over ONE
//   chrome.runtime.connectNative(NATIVE_HOST) port (the host relays every frame
//   as its own request and answers in order, so replies resolve a FIFO of
//   pending requests): opened on the first status, reused, closed after
//   PORT_IDLE_MS without a request. A request without an answer after
//   STATUS_TIMEOUT_MS closes the port (a late reply would resolve the wrong
//   request) and fails every pending one; so does onDisconnect. After either,
//   the next status goes through sendNativeMessage and the one after reopens
//   the port. enqueue, cancel, probe and ping always use sendNativeMessage. Jobs run
//   in the app: closing the port never affects them. Safari never opens the port:
//   every status there is its own sendNativeMessage (a short appex call).
//
//   Overlay view (5.2).
//   view [selected] -> everything the overlay draws, summaries only (no URLs,
//              headers or captures): {ok,
//                segments (segs:<tabId>), pendingStart (number | null),
//                duration (the selected video's, null when unknown or live),
//                source (getSource's summary of the resolved source, or null;
//                  hls variants also carry label "WxH · N.N Mbps"),
//                pageFirst (Download sends the page with this source as its
//                  fallback, see Send the job),
//                sources [{kind, host, file}] (chooseSource's list, same order)
//                  and sourceIndex (the resolved source in it, or null),
//                videos [{frameId, videoKey, label}] (the candidates that are
//                  not excluded, plus the selected one, in mergeCandidates
//                  order; label "WxH · h:mm:ss", "Video · ..." without a size,
//                  "live" / "unknown length" without a duration) and videoIndex
//                  (the selected one, or null), for `select`,
//                incognito {on, forced} (Incognito; before the first pong the
//                  unknown default counts as off),
//                mode (settings.mode, "separate" without settings),
//                fullClip (settings.fullClipButton: show Full clip; true
//                  without settings),
//                overLimit (the segments' total duration > settings.maxDuration),
//                maxDuration (seconds, or null = no limit; always present),
//                depsProblem (only when Download must be disabled: ffmpeg
//                  missing, or yt-dlp missing for a page source without a
//                  fallback; deno never blocks),
//                appError (the ping failed),
//                job (this tab's newest job from `jobs`: {id, state,
//                  segmentIndex, segmentCount, fraction, bytes, message,
//                  fallbackUsed}, or null)}.
//              Uses the deps cache and, when the tab has jobs or else when jobt
//              holds an entry with page.key = page:<tabId>.key and no applied,
//              one status request (a failure is ignored), made before segments
//              are read so they carry its Downloaded segments flags; starts a
//              probe run like getSource.
//
// Hub -> content: chrome.tabs.sendMessage(tabId, msg, {frameId}). agent.js and
// the overlay share each frame, so every message names its receiver in `to`;
// each listener ignores the others.
//   to "agent" (the video's frame):
//     seek {videoKey, time} | play {videoKey} | pause {videoKey} -> {ok}
//     getTime {videoKey} -> {ok, currentTime, duration (null if unknown), paused}
//     select {videoKey | null}: the frame's selected video (null: none there)
//   to "overlay" (the selected video's frame):
//     segments {segments: [{start, end, done?}]}: after every change of segs:<tabId>
//     mark {action, time, frameId, videoKey, start?, end?} | markError {action, error}
//     toggleOverlay {open}: the toggle below or `openOverlay`; open = the new
//     panelOpen.
//     sourceChanged {}: a probe run stored results; the overlay asks `view` again.
//   to "all" (every frame, no frameId option):
//     state {state} after the selection, selectedBy or pendingStart changes.
//     Also sent after panelOpen changes: agents listen for `[` / `]` only while
//     the overlay is open.
//     ui {ui: {fullClipButton, playerButton}} to every tab (chrome.tabs.query)
//     when a pong changed the stored switches (storage.local `ui`).
//
// Overlay toggle (3.5): the "toggle-panel" command and the toolbar button
// (chrome.action.onClicked; fires once the manifest has no default_popup, 5.4)
// flip panelOpen for that tab, send state to "all", then send toggleOverlay to
// the selected video's frame (a frame that gets the selection later reads
// state.panelOpen). With nothing selected, panelOpen stays false and the button
// shows a "none" badge for NO_VIDEO_BADGE_MS. The selection becoming null also
// sets panelOpen false. Top-frame navigation clears hub:<tabId>, so the overlay
// is closed again on the next page.
//
// Same-document URL changes (webNavigation.onHistoryStateUpdated, frame 0) update
// top:<tabId>. When the URL, without its hash, differs from the key in
// page:<tabId>, the hub also clears pendingStart and the source and variant
// choices src:<tabId> / var:<tabId> (captures and probe results stay; the next
// video's requests add to them), loads the new page's segments (Segment
// persistence), relays them to the selected video's frame and sends `state` to
// "all". The selection stays until the agents report other videos.
//
// Main-video auto-pick (3.4): whenever any frame's candidates change and
// selectedBy is "auto", the hub selects the top score across all frames (ties:
// larger area, then lower frameId / list order). It skips excluded candidates
// and, when a non-excluded candidate lasts >= 30 s, non-excluded ones known to be
// shorter. Unknown durations qualify with score 0. Nothing qualifies -> null
// (which closes the overlay).
// A user selection (select, or a marked start) sticks until its video
// disappears; then selectedBy goes back to "auto". An auto switch clears pendingStart and sends the agents `select`.
//
// Storage (chrome.storage.session, cleared with the capture keys):
//   hub:<tabId>  -> {selected: {frameId, videoKey} | null, selectedBy: "auto" | "user",
//                    panelOpen, pendingStart}   (= `state` above; panelOpen = overlay open)
//   cand:<tabId> -> {<frameId>: [candidate, ...]}
//   segs:<tabId> -> [{start, end, done?}]   (the tab's segments, owned by the hub)
//   page:<tabId> -> {key: "seg:<url>"}   (the page key the segments were loaded for)
//   src:<tabId>  -> {url, selected}   (chooseSource: the entry's URL and the
//                    selection it was made for; never sent to content scripts)
//   probe:<tabId> -> {<playlist url>: {ts, variants: [{url, bandwidth, width,
//                    height, audio (has an AUDIO group)}]} | {ts, error: {code,
//                    message}}}   (4.2 probe results, no headers; at most
//                    MAX_PROBE_CACHE URLs, oldest ts dropped)
//   var:<tabId>  -> {source, url, selected}   (chooseVariant: the master's URL, the
//                    chosen variant's URL, the selection; never sent to content scripts)
//   jobs:<tabId> -> [{jobId, title?, ts}]   (4.3 enqueued jobs, oldest first, at most
//                    MAX_JOBS_PER_TAB; title as sent to the app, absent for incognito jobs)
//   jobt         -> {<jobId>: {title, ts, page?: {key, ranges}, applied?}}   (4.4:
//                    every job this extension enqueued that is not incognito; at most
//                    MAX_KNOWN_JOBS, oldest ts dropped; not cleared with a tab; page
//                    and applied: Downloaded segments)
//   inc:<tabId>  -> boolean   (setIncognito: the tab's incognito choice; not cleared
//                    on navigation, removed with the tab)
// chrome.storage.local (persistent; only this worker reads or writes it, and its
// access level is set to trusted contexts where the browser supports that):
//   seg:<url>    -> {segments (with done?), ts}   (at most 200, newest ts kept; entries saved by
//                    older versions also carry mode and precision, ignored)
//   ui           -> {fullClipButton, playerButton}   (the app's switches from the
//                    last pong; absent -> both true; sent to content scripts only
//                    through getState and the `ui` broadcast)
// ---------------------------------------------------------------------------

const MAX_CANDIDATES_PER_FRAME = 20;
const MAX_URL_LENGTH = 8192;
const VIDEO_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MARK_ACTIONS = new Set(["markStart", "markEnd"]);
const EXCLUSIONS = new Set(["small", "ad", "live"]);
const MIN_MAIN_DURATION = 30; // seconds; shorter videos lose to a longer candidate
const MAX_SEGMENTS = 100; // SegDownCore Validation
const MAX_PAGES = 200; // seg:* entries kept in storage.local, most recent ts first
const NO_VIDEO_BADGE_MS = 2000; // the toolbar's "none" badge after a toggle with nothing selected
const MODES = new Set(["separate", "merged"]);
const NATIVE_HOST = "com.math2it.segdown";
const APP_UNREACHABLE = "SegDown app not reachable: install browser integration";
const PROBE_RETRY_MS = 30 * 1000; // a failed probe of a URL is not repeated sooner
const MAX_PROBES_PER_RUN = 6;
const MAX_PROBE_CACHE = 50; // probed URLs kept per tab
const MAX_VARIANTS = 100; // variants kept per master
const MAX_MESSAGE_CHARS = 300;
const MAX_TITLE_CHARS = 300; // Validation.maxTitleLength
const MAX_JOBS_PER_TAB = 20;
const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/; // the app's ids are UUIDs
const JOB_STATES = new Set(["queued", "running", "done", "failed", "cancelled"]);
const MAX_KNOWN_JOBS = 100; // jobt entries
const MAX_OUTPUTS = 100; // output names per job
const PORT_IDLE_MS = 5 * 1000;
const STATUS_TIMEOUT_MS = 20 * 1000;
const TITLES_KEY = "jobt";
const UI_KEY = "ui"; // storage.local: the app's switches from the last pong
const DEPS_TTL_MS = 10 * 1000; // ping answers (missing tools, settings) are reused this long
const TOOLS = new Set(["yt-dlp", "ffmpeg", "ffprobe", "deno"]); // SegDownCore Tool raw values
const INCOGNITO_NEEDS_UPDATE = "Update the SegDown app to download incognito";
const MAX_VIDEO_SIDE = 100000; // candidate width/height in px

const isFiniteNum = (n) => typeof n === "number" && Number.isFinite(n);
const isTime = (n) => isFiniteNum(n) && n >= 0;
const isDuration = (n) => n === null || isTime(n);
const isVideoKey = (k) => typeof k === "string" && VIDEO_KEY_RE.test(k);
const isObject = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const isJobId = (id) => typeof id === "string" && JOB_ID_RE.test(id);
const isIndex = (n, max) => Number.isInteger(n) && n >= 0 && n < max;

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
  if (v.videoId !== undefined) {
    if (typeof v.videoId !== "string") return null;
    if (/^\d{1,25}$/.test(v.videoId)) out.videoId = v.videoId;
  }
  const isSide = (n) => Number.isInteger(n) && n > 0 && n <= MAX_VIDEO_SIDE;
  if (isSide(v.width) && isSide(v.height)) [out.width, out.height] = [v.width, v.height];
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
  ["key", (m) => (MARK_ACTIONS.has(m.action) ? { action: m.action } : null)],
  ["removeSegment", (m) => (isIndex(m.index, MAX_SEGMENTS) ? { index: m.index } : null)],
  ["clearSegments", () => ({})],
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
  ["openOverlay", (m) => (isVideoKey(m.videoKey) ? { videoKey: m.videoKey } : null)],
  ["getState", () => ({})],
  ["setPanelOpen", (m) => (typeof m.open === "boolean" ? { open: m.open } : null)],
  ["getSource", () => ({})],
  ["chooseSource", (m) => (isIndex(m.index, MAX_ENTRIES_PER_TAB) ? { index: m.index } : null)],
  ["chooseVariant", (m) => (isIndex(m.index, MAX_VARIANTS) ? { index: m.index } : null)],
  [
    "download",
    (m) =>
      (m.mode === undefined || MODES.has(m.mode)) &&
      (m.incognito === undefined || typeof m.incognito === "boolean") &&
      (m.full === undefined || typeof m.full === "boolean")
        ? { mode: m.mode === undefined ? null : m.mode, incognito: m.incognito === true, ...(m.full === true ? { full: true } : {}) }
        : null,
  ],
  ["jobs", () => ({})],
  ["cancel", (m) => (isJobId(m.id) ? { id: m.id } : null)],
  ["deps", () => ({})],
  ["setIncognito", (m) => (typeof m.on === "boolean" ? { on: m.on } : null)],
  ["view", () => ({})],
]);

// Accepted only from the frame that holds the selected video (see the protocol).
const SELECTED_FRAME_TYPES = new Set([
  "removeSegment",
  "clearSegments",
  "seek",
  "getTime",
  "play",
  "pause",
  "select",
  "setPanelOpen",
  "getSource",
  "chooseSource",
  "chooseVariant",
  "download",
  "jobs",
  "cancel",
  "deps",
  "setIncognito",
  "view",
]);

// Control characters become spaces, then at most MAX_TITLE_CHARS code points (never splits
// a surrogate pair).
function cleanTitle(title) {
  return Array.from(title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim())
    .slice(0, MAX_TITLE_CHARS)
    .join("");
}

// segs:<tabId> order: by start, then end.
const bySegment = (a, b) => a.start - b.start || a.end - b.end;

function cleanSegments(list) {
  if (!Array.isArray(list) || list.length > MAX_SEGMENTS) return null;
  const out = [];
  for (const s of list) {
    if (!isObject(s) || !isTime(s.start) || !isTime(s.end) || !(s.end > s.start)) return null;
    out.push(s.done === true ? { start: s.start, end: s.end, done: true } : { start: s.start, end: s.end });
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
      if (!hub.selected) hub.panelOpen = false; // no video, no overlay (nor `[` / `]` capture)
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

const notifyOverlay = (tabId, frameId, msg) => notify(tabId, { to: "overlay", ...msg }, frameId);
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

function announceCandidates(tabId, { changed, hub, prev, stateChanged }) {
  if (!changed || !stateChanged) return;
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

// True when frameId holds the tab's selected video (the overlay's frame). With
// nothing selected, a frame may only `select` one of its own videos.
async function isSelectedFrame(tabId, frameId, type, body) {
  const { selected } = await withTab(tabId, () => readHub(tabId));
  if (selected) return selected.frameId === frameId;
  return type === "select" && body.frameId === frameId;
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

// Keys come from any frame, so a failure is also relayed to the selected video's
// frame (the frame that sent the key may have no UI to show it).
function keyFailed(tabId, selected, action, error) {
  if (selected) notifyOverlay(tabId, selected.frameId, { type: "markError", action, error });
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
    let segments = null;
    if (action === "markStart") {
      h.pendingStart = time;
      h.selectedBy = "user"; // an auto re-pick would drop the start
    } else {
      if (start === null) return { error: "no-start" };
      if (time <= start) return { error: "end-not-after-start" }; // keep the start
      segments = await readSegments(tabId);
      if (segments.length >= MAX_SEGMENTS) return { error: "too-many-segments" }; // keep the start
      segments = [...segments, { start, end: time }].sort(bySegment);
      await chrome.storage.session.set({ [segsKey(tabId)]: segments });
      h.pendingStart = null;
    }
    await writeHub(tabId, h);
    return { hub: h, start, segments };
  });
  if (result.error) return keyFailed(tabId, selected, action, result.error);
  const { hub, segments } = result;
  const mark = { action, time, ...selected };
  if (action === "markEnd") Object.assign(mark, { start: result.start, end: time });
  notifyOverlay(tabId, selected.frameId, { type: "mark", ...mark });
  if (segments) segmentsUpdated(tabId, selected, segments);
  notifyAll(tabId, { type: "state", state: hub });
  hubLog(`${action} tab=${tabId} time=${time}`);
  return { ok: true, ...mark };
}

// open: true/false sets panelOpen, null flips it; it stays false with nothing
// selected. Sends the new state to every frame.
async function setPanelOpen(tabId, open) {
  const hub = await withTab(tabId, async () => {
    const h = await readHub(tabId);
    h.panelOpen = Boolean(h.selected) && (open === null ? !h.panelOpen : open);
    await writeHub(tabId, h);
    return h;
  });
  notifyAll(tabId, { type: "state", state: hub });
  hubLog(`panelOpen tab=${tabId} ${hub.panelOpen}`);
  return { ok: true, state: hub };
}

// Player button: the sender frame (never the message) selects one of its own
// non-excluded videos and opens the overlay on it. Not selected-frame gated.
async function onOpenOverlay(tabId, frameId, { videoKey }) {
  const cands = await withTab(tabId, () => readCands(tabId));
  if (!(cands[frameId] || []).some((v) => v.videoKey === videoKey && v.excluded === null)) {
    return { ok: false, error: "no-video" };
  }
  const selected = await onSelect(tabId, { frameId, videoKey });
  if (!selected.ok) return selected;
  const { state } = await setPanelOpen(tabId, true);
  notifyOverlay(tabId, frameId, { type: "toggleOverlay", open: true });
  return { ok: true, state };
}

// Only the selected video's frame gets segments (it holds the overlay).
async function onGetState(tabId, frameId) {
  const { hub, segments } = await withTab(tabId, async () => ({
    hub: await readHub(tabId),
    segments: await readSegments(tabId),
  }));
  const reply = { ok: true, state: hub, ui: await readUI() };
  if (hub.selected && hub.selected.frameId === frameId) reply.segments = segments;
  // No pong yet (e.g. the app's integration was installed after this extension):
  // ask the app in the background; its pong broadcasts the switches.
  if (!(await hasStoredUI())) fetchDeps().catch(hubWarn);
  return reply;
}

// --- segments (hub-owned; rules under "Segments" in the protocol) ---

// After every change of segs:<tabId>: relay the list to the selected video's frame
// and save it for the page.
function segmentsUpdated(tabId, selected, segments) {
  if (selected) notifyOverlay(tabId, selected.frameId, { type: "segments", segments });
  persistSegments(tabId).catch(hubWarn);
}

async function onRemoveSegment(tabId, { index }) {
  const result = await withTab(tabId, async () => {
    const segments = await readSegments(tabId);
    if (index >= segments.length) return null;
    segments.splice(index, 1);
    await chrome.storage.session.set({ [segsKey(tabId)]: segments });
    return { segments, selected: (await readHub(tabId)).selected };
  });
  if (!result) return { ok: false, error: "unknown-segment" };
  segmentsUpdated(tabId, result.selected, result.segments);
  return { ok: true, segments: result.segments };
}

async function onClearSegments(tabId) {
  const selected = await withTab(tabId, async () => {
    await chrome.storage.session.remove(segsKey(tabId));
    return (await readHub(tabId)).selected;
  });
  segmentsUpdated(tabId, selected, []);
  return { ok: true, segments: [] };
}

// --- segment persistence (rules under "Segment persistence" in the protocol) ---

// `seg:` + the http(s) URL without its hash, or null.
function pageKeyOf(url) {
  const u = typeof url === "string" ? httpURL(url) : null;
  return u ? `seg:${u.origin}${u.pathname}${u.search}` : null;
}

async function readPageRecord(tabId) {
  const key = pageKey(tabId);
  const rec = (await chrome.storage.session.get(key))[key];
  return isObject(rec) && typeof rec.key === "string" ? rec : null;
}

// The app's incognitoDefault from the last pong of this worker's life (false
// for an app without settings), null before the first pong: nothing is written
// to storage.local while it is null.
let incognitoDefault = null;

// A tab of a browser private window (incl. Chrome's shared "spanning" storage).
// A tab that is gone counts as private, so nothing is written for it.
async function isPrivateTab(tabId) {
  try {
    return (await chrome.tabs.get(tabId)).incognito === true;
  } catch {
    return true;
  }
}

// The tab's incognito state (see "Incognito" in the protocol): forced in a
// private window, else the inc:<tabId> choice, else the app's default.
// from.tabIncognito (the sender's tab) saves the chrome.tabs.get call.
// -> {on, forced, known}; known is false before the first pong when the tab has no choice.
async function tabIncognito(tabId, from) {
  const forced = from && typeof from.tabIncognito === "boolean" ? from.tabIncognito : await isPrivateTab(tabId);
  const stored = (await chrome.storage.session.get(incKey(tabId)))[incKey(tabId)];
  const choice = typeof stored === "boolean" ? stored : incognitoDefault;
  return { on: forced || choice === true, forced, known: forced || choice !== null };
}

// Call inside withTab: true when the tab's segments may be written to storage.local.
async function canPersist(tabId) {
  return incognitoDefault !== null && !(await tabIncognito(tabId)).on;
}

// Call inside withTab (top-frame commit, page change): loads the page's saved
// segments (keyed by top:<tabId>) into segs:<tabId> and records the key in
// page:<tabId>. A tab known to be incognito loads nothing (an unknown default
// loads: reading leaves no trace, and the worker forgets the default on restart).
async function loadSegments(tabId) {
  const top = (await chrome.storage.session.get(topKey(tabId)))[topKey(tabId)];
  const key = pageKeyOf(top);
  if (!key) {
    await chrome.storage.session.remove([pageKey(tabId), segsKey(tabId)]);
    return [];
  }
  const rec = (await tabIncognito(tabId)).on ? undefined : (await chrome.storage.local.get(key))[key];
  const segments = ((isObject(rec) && cleanSegments(rec.segments)) || []).sort(bySegment);
  await chrome.storage.session.set({ [pageKey(tabId)]: { key }, [segsKey(tabId)]: segments });
  return segments;
}

const restoreSegments = (tabId) => withTab(tabId, () => loadSegments(tabId));

// Writes the tab's current segs:<tabId> to seg:<top URL> (an empty list removes
// the entry). Asks the app for its settings first when this worker has none yet.
async function persistSegments(tabId) {
  if (incognitoDefault === null) await fetchDeps();
  if (incognitoDefault === null) return;
  const pruneNeeded = await withTab(tabId, async () => {
    if (!(await canPersist(tabId))) return false;
    const top = (await chrome.storage.session.get(topKey(tabId)))[topKey(tabId)];
    const key = pageKeyOf(top);
    if (!key) return false;
    const segments = await readSegments(tabId);
    if (!segments.length) {
      await chrome.storage.local.remove(key);
      return false;
    }
    await chrome.storage.local.set({ [key]: { segments, ts: Date.now() } });
    return true;
  });
  if (pruneNeeded) await prunePages();
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

// The first pong of the worker's life opened the gate: saves the tabs' segments
// that were marked before it (persistSegments applies each tab's incognito state).
async function persistHeldSegments() {
  const all = await chrome.storage.session.get(null);
  for (const k of Object.keys(all)) {
    const tabId = Number(k.slice(5));
    if (k.startsWith("segs:") && Number.isInteger(tabId) && Array.isArray(all[k]) && all[k].length) {
      await persistSegments(tabId);
    }
  }
}

// setIncognito {on} (see "Incognito" in the protocol). Turning it on deletes the
// page's seg: entry; turning it off saves the current segments (when allowed).
async function onSetIncognito(tabId, from, { on }) {
  if (from.tabIncognito === true) return { ok: false, error: "incognito-forced", incognito: { on: true, forced: true } };
  await withTab(tabId, async () => {
    await chrome.storage.session.set({ [incKey(tabId)]: on });
    if (!on) return;
    const key = pageKeyOf((await chrome.storage.session.get(topKey(tabId)))[topKey(tabId)]);
    if (key) await chrome.storage.local.remove(key);
  });
  if (!on) persistSegments(tabId).catch(hubWarn);
  hubLog(`setIncognito tab=${tabId} ${on}`);
  return { ok: true, incognito: { on, forced: false } };
}

// pushState / replaceState in the top frame (see the protocol). A URL that keys
// the page already loaded (same URL, or only the hash changed) is not a change.
// Runs after setTopURL in the tab queue, so loadSegments reads the new URL.
async function onPageChanged(tabId, url) {
  const key = pageKeyOf(url);
  const result = await withTab(tabId, async () => {
    const rec = await readPageRecord(tabId);
    if (rec && rec.key === key) return null;
    const h = await readHub(tabId);
    h.pendingStart = null; // a start belongs to the page it was marked on
    await writeHub(tabId, h);
    await chrome.storage.session.remove([srcKey(tabId), varKey(tabId)]);
    return { hub: h, segments: await loadSegments(tabId) };
  });
  if (!result) return;
  const { hub, segments } = result;
  if (hub.selected) notifyOverlay(tabId, hub.selected.frameId, { type: "segments", segments });
  notifyAll(tabId, { type: "state", state: hub });
  hubLog(`pageChanged tab=${tabId}`);
}

// --- source correlation (4.1; rules under "Source correlation" in the protocol) ---

const isMediaEntry = (e) => isObject(e) && (e.kind === "hls" || e.kind === "mp4") && typeof e.url === "string";

// Only allowlisted headers, copied (the entry came from pickHeaders already).
function entrySource(e, via) {
  const headers = {};
  for (const name of ALLOWED_HEADERS) if (isObject(e.headers) && typeof e.headers[name] === "string") headers[name] = e.headers[name];
  return { source: { type: "media", url: e.url, kind: e.kind, headers }, frameId: e.frameId, via };
}

// Pure: the selected Facebook video's own page (frame 0, with videoId), else topURL.
function videoPageURL(topURL, selected, cand) {
  const u = topURL ? httpURL(topURL) : null;
  if (!u || !(selected && selected.frameId === 0) || !(cand && cand.videoId)) return topURL;
  if (u.hostname !== "facebook.com" && !u.hostname.endsWith(".facebook.com")) return topURL;
  return `${u.origin}/watch/?v=${cand.videoId}`;
}

// Pure: {source, frameId, via} or null. `media` holds hls/mp4 entries, oldest first.
function pickSource({ selected, currentSrc, choice, media, active, topURL }) {
  if (choice) {
    const e = media.findLast((x) => x.url === choice.url);
    if (e) return entrySource(e, "user");
  }
  if (selected && currentSrc) {
    const e = media.findLast((x) => x.url === currentSrc);
    if (e) return entrySource(e, "currentSrc");
    const kind = httpURL(currentSrc).pathname.toLowerCase().endsWith(".m3u8") ? "hls" : "mp4";
    return { source: { type: "media", url: currentSrc, kind, headers: {} }, frameId: selected.frameId, via: "currentSrc" };
  }
  if (selected) {
    const own = media.filter((e) => e.frameId === selected.frameId);
    const e =
      own.findLast((x) => x.kind === "hls" && x.isMaster === true) ||
      own.findLast((x) => x.kind === "hls") ||
      own.findLast((x) => x.kind === "mp4");
    if (e) return entrySource(e, "capture");
  }
  let best = null;
  let bestTier = -1;
  for (const e of media) {
    const tier = (isObject(active[e.frameId]) ? 4 : 0) + (e.kind === "hls" ? 2 : 0) + (e.isMaster === true ? 1 : 0);
    if (tier >= bestTier) [best, bestTier] = [e, tier]; // >=: the newest wins a tie
  }
  if (best) return entrySource(best, "capture");
  return topURL ? { source: { type: "page", url: topURL }, frameId: 0, via: "page" } : null;
}

// Reads everything in one tab-queue turn. A choice made for another video (or
// none) is dropped here, so it cannot come back when that video is re-selected.
function correlate(tabId) {
  return withTab(tabId, async () => {
    const keys = [capKey(tabId), actKey(tabId), candKey(tabId), srcKey(tabId), topKey(tabId)];
    const got = await chrome.storage.session.get(keys);
    const hub = await readHub(tabId);
    const sel = hub.selected;
    const cand = sel ? ((got[candKey(tabId)] || {})[sel.frameId] || []).find((v) => v.videoKey === sel.videoKey) : null;
    let choice = isObject(got[srcKey(tabId)]) ? got[srcKey(tabId)] : null;
    if (choice && !sameSelection(choice.selected || null, sel)) {
      await chrome.storage.session.remove(srcKey(tabId));
      choice = null;
    }
    const top = got[topKey(tabId)];
    const topURL = typeof top === "string" && httpURL(top) ? top : null;
    const pageURL = videoPageURL(topURL, sel, cand);
    const r = pickSource({
      selected: sel,
      currentSrc: cand && cand.currentSrc ? cand.currentSrc : null,
      choice,
      media: (got[capKey(tabId)] || []).filter(isMediaEntry),
      active: isObject(got[actKey(tabId)]) ? got[actKey(tabId)] : {},
      topURL: pageURL,
    });
    // For the job (5.2): the page URL (page-first) and the selected video's duration.
    if (r) Object.assign(r, { pageURL, duration: cand && isFiniteNum(cand.duration) && cand.duration > 0 ? cand.duration : null });
    return r;
  });
}

// For the job builder (4.3): {source, frameId, via, pageURL, duration} with the
// full Source (captured headers), or null. Service-worker only; never send it to
// a content script. Reads the probe cache only (no native call); variantURL only
// for a non-default choice.
async function resolveSource(tabId) {
  const r = await correlate(tabId);
  if (!r) return null;
  if (isHLS(r)) {
    const { list, choice } = await readVariants(tabId, r.source.url);
    const i = choice ? list.findIndex((v) => v.url === choice.url) : -1;
    if (i > 0) r.source.variantURL = list[i].url;
  }
  return r;
}

// The job's sources (see "Send the job"): page first with the resolved media as
// its fallback when the media was not pinned by the user (chooseSource, a
// non-default chooseVariant) and the app speaks protocol 2; else the resolved
// source alone. -> {r, source, fallback (null when none)} or null.
async function planSource(tabId, protocol) {
  const r = await resolveSource(tabId);
  if (!r) return null;
  const pinned = r.via === "user" || Boolean(r.source.variantURL);
  if (r.source.type === "media" && !pinned && protocol >= 2 && r.pageURL) {
    return { r, source: { type: "page", url: r.pageURL }, fallback: r.source };
  }
  return { r, source: r.source, fallback: null };
}

// Explicit field map: no query, no headers (see the protocol).
function summarizeSource(r) {
  if (!r) return null;
  const u = new URL(r.source.url);
  const parts = u.pathname.split("/").filter(Boolean);
  return {
    kind: r.source.type === "page" ? "page" : r.source.kind,
    host: u.host,
    file: parts.length ? parts[parts.length - 1].slice(0, 200) : "",
    frameId: r.frameId,
    via: r.via,
  };
}

async function onGetSource(tabId) {
  return { ok: true, source: await describeSource(tabId, await correlate(tabId)) };
}

// The source list chooseSource indexes: the tab's hls/mp4 captures sorted by
// frameId, then URL. Stable while no capture is added or dropped (a re-fetch moves
// an entry to the end of cap:<tabId>, so that order would shift under the menu).
function sourceList(entries) {
  return entries
    .filter(isMediaEntry)
    .sort((a, b) => a.frameId - b.frameId || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

async function onChooseSource(tabId, { index }) {
  const chosen = await withTab(tabId, async () => {
    const key = capKey(tabId);
    const entries = (await chrome.storage.session.get({ [key]: [] }))[key];
    const e = sourceList(Array.isArray(entries) ? entries : [])[index];
    if (!e) return null;
    const { selected } = await readHub(tabId);
    await chrome.storage.session.set({ [srcKey(tabId)]: { url: e.url, selected } });
    return e;
  });
  if (!chosen) return { ok: false, error: "unknown-source" };
  hubLog(`chooseSource tab=${tabId} frame=${chosen.frameId} kind=${chosen.kind}`);
  return { ok: true, source: await describeSource(tabId, await correlate(tabId)) };
}

// --- app settings and dependencies (ping) ---

// pong.settings, checked; an app without settings (protocol 1) gets the defaults.
function cleanSettings(s) {
  const o = isObject(s) ? s : {};
  return {
    mode: MODES.has(o.mode) ? o.mode : "separate",
    incognitoDefault: o.incognitoDefault === true,
    maxDuration: isFiniteNum(o.maxDuration) && o.maxDuration > 0 ? o.maxDuration : null,
    fullClipButton: o.fullClipButton !== false,
    playerButton: o.playerButton !== false,
  };
}

// storage.local ui, checked; never pinged (nothing stored) -> both switches on.
async function readUI() {
  const u = (await chrome.storage.local.get(UI_KEY))[UI_KEY];
  return isObject(u) && typeof u.fullClipButton === "boolean" && typeof u.playerButton === "boolean"
    ? { fullClipButton: u.fullClipButton, playerButton: u.playerButton }
    : { fullClipButton: true, playerButton: true };
}

// True once a pong has stored the switches (never cleared).
async function hasStoredUI() {
  return (await chrome.storage.local.get(UI_KEY))[UI_KEY] !== undefined;
}

// After a pong: saves the switches when they changed (or were never stored) and
// sends them to every tab.
async function updateUI(settings) {
  const ui = { fullClipButton: settings.fullClipButton, playerButton: settings.playerButton };
  const stored = await hasStoredUI();
  const prev = await readUI();
  if (stored && prev.fullClipButton === ui.fullClipButton && prev.playerButton === ui.playerButton) return;
  await chrome.storage.local.set({ [UI_KEY]: ui });
  for (const tab of await chrome.tabs.query({})) {
    if (Number.isInteger(tab.id) && tab.id >= 0) notifyAll(tab.id, { type: "ui", ui });
  }
}

// -> {missing: [tool], protocol, settings} or {missing: [], appError}. Never
// throws. Every pong sets the persistence gate (incognitoDefault) and the
// storage.local ui switches (updateUI).
async function pingNative() {
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "ping" });
  } catch {
    return { missing: [], appError: APP_UNREACHABLE };
  }
  if (isObject(reply) && reply.type === "pong" && Array.isArray(reply.missing)) {
    const settings = cleanSettings(reply.settings);
    const protocol = Number.isInteger(reply.protocol) && reply.protocol >= 1 ? reply.protocol : 1;
    const opened = incognitoDefault === null;
    incognitoDefault = settings.incognitoDefault;
    if (opened) persistHeldSegments().catch(hubWarn);
    updateUI(settings).catch(hubWarn);
    const missing = [...new Set(reply.missing.filter((t) => typeof t === "string" && TOOLS.has(t)))];
    return { missing, protocol, settings };
  }
  return { missing: [], appError: "Unexpected reply from the SegDown app." };
}

const depsCache = { ts: 0, result: null, run: null };

// retryError: a cached failure is not reused (Download asks the app again).
function fetchDeps(retryError = false) {
  const cached = depsCache.result && Date.now() - depsCache.ts < DEPS_TTL_MS;
  if (cached && !(retryError && depsCache.result.appError)) return Promise.resolve(depsCache.result);
  if (!depsCache.run) {
    depsCache.run = pingNative()
      .then((result) => {
        Object.assign(depsCache, { ts: Date.now(), result });
        hubLog(`ping missing=[${result.missing.join(", ")}]${result.appError ? " (app error)" : ""}`);
        return result;
      })
      .finally(() => {
        depsCache.run = null;
      });
  }
  return depsCache.run;
}

async function onDeps() {
  const { missing, appError } = await fetchDeps();
  const reply = { ok: true, missing: [...missing] };
  if (appError) reply.appError = appError;
  return reply;
}

// --- HLS variant picker (4.2; rules under "HLS variant picker" in the protocol) ---

const isHLS = (r) => Boolean(r && r.source.type === "media" && r.source.kind === "hls");

// Highest bandwidth first; sort is stable, so equal bandwidths keep playlist
// order and index 0 is the variant HLSPlaylist.pickVariant() takes by default.
const sortVariants = (variants) => [...variants].sort((a, b) => b.bandwidth - a.bandwidth);

// One probe result, kept or null (the app is trusted, the playlist it parsed is not).
function cleanVariant(v) {
  if (!isObject(v) || typeof v.url !== "string" || v.url.length > MAX_URL_LENGTH || !httpURL(v.url)) return null;
  if (!Number.isInteger(v.bandwidth) || v.bandwidth < 0) return null;
  let width = null;
  let height = null;
  if (v.resolution !== undefined && v.resolution !== null) {
    const r = v.resolution;
    if (!isObject(r) || !Number.isInteger(r.width) || !Number.isInteger(r.height) || r.width <= 0 || r.height <= 0) return null;
    [width, height] = [r.width, r.height];
  }
  const audio = typeof v.audioGroup === "string" && v.audioGroup.length > 0;
  return { url: v.url, bandwidth: v.bandwidth, width, height, audio };
}

// -> {variants} or {error: {code, message}}. Never throws.
async function probeNative(source) {
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "probe", source });
  } catch {
    // Host manifest missing, host not allowed for this extension, or it crashed.
    return { error: { code: "unreachable", message: APP_UNREACHABLE } };
  }
  if (isObject(reply) && reply.type === "variants" && Array.isArray(reply.variants)) {
    return { variants: reply.variants.slice(0, MAX_VARIANTS).map(cleanVariant).filter(Boolean) };
  }
  if (isObject(reply) && reply.type === "error" && typeof reply.code === "string") {
    const text = typeof reply.message === "string" ? reply.message.slice(0, MAX_MESSAGE_CHARS) : "";
    return { error: { code: reply.code.slice(0, 32), message: text || "SegDown could not read the playlist." } };
  }
  return { error: { code: "internal", message: "Unexpected reply from the SegDown app." } };
}

// A cached result that makes a new probe unnecessary.
const isFresh = (rec, now) => isObject(rec) && (Array.isArray(rec.variants) || now - rec.ts < PROBE_RETRY_MS);

// The next Source to probe for resolved source r, or null (rules in the protocol).
function nextProbe(tabId, r) {
  return withTab(tabId, async () => {
    const got = await chrome.storage.session.get({ [probeKey(tabId)]: {}, [capKey(tabId)]: [] });
    const cache = got[probeKey(tabId)];
    const now = Date.now();
    const rec = cache[r.source.url];
    if (!isFresh(rec, now)) return r.source;
    if (r.via !== "capture" || !Array.isArray(rec.variants) || rec.variants.length) return null;
    const next = got[capKey(tabId)].find(
      (e) => isMediaEntry(e) && e.kind === "hls" && e.frameId === r.frameId && e.isMaster === undefined && !isFresh(cache[e.url], now)
    );
    return next ? entrySource(next, "capture").source : null;
  });
}

// Writes one result and sets isMaster on the captures with that URL.
function storeProbe(tabId, gen, url, result) {
  return withTab(tabId, async () => {
    if (tabGen(tabId) !== gen) return false; // the tab was cleared meanwhile
    const got = await chrome.storage.session.get({ [probeKey(tabId)]: {}, [capKey(tabId)]: [] });
    const cache = got[probeKey(tabId)];
    delete cache[url]; // re-inserted last
    cache[url] = { ts: Date.now(), ...result };
    const urls = Object.keys(cache).sort((a, b) => cache[a].ts - cache[b].ts);
    for (const old of urls.slice(0, Math.max(0, urls.length - MAX_PROBE_CACHE))) delete cache[old];
    const entries = got[capKey(tabId)];
    if (result.variants) for (const e of entries) if (isObject(e) && e.url === url) e.isMaster = result.variants.length > 0;
    await chrome.storage.session.set({ [probeKey(tabId)]: cache, [capKey(tabId)]: entries });
    return true;
  });
}

async function runProbes(tabId) {
  const gen = tabGen(tabId);
  let stored = false;
  for (let n = 0; n < MAX_PROBES_PER_RUN; n++) {
    const r = await correlate(tabId);
    if (!isHLS(r)) break;
    const source = await nextProbe(tabId, r);
    if (!source) break;
    const result = await probeNative({ type: "media", url: source.url, kind: "hls", headers: source.headers });
    if (!(await storeProbe(tabId, gen, source.url, result))) return;
    stored = true;
    hubLog(`probe tab=${tabId} ${result.error ? `error=${result.error.code}` : `variants=${result.variants.length}`}`);
    if (result.error) break;
  }
  if (!stored) return;
  const { selected } = await withTab(tabId, () => readHub(tabId));
  if (selected) notifyOverlay(tabId, selected.frameId, { type: "sourceChanged" });
}

// One run per tab at a time; later calls share it.
const probeRuns = new Map();

function startProbes(tabId) {
  if (probeRuns.has(tabId)) return probeRuns.get(tabId);
  const run = runProbes(tabId)
    .catch(hubWarn)
    .finally(() => probeRuns.delete(tabId));
  probeRuns.set(tabId, run);
  return run;
}

// The cached result for url and the variant choice that still applies to it
// (a choice for another source, video or a vanished variant is dropped here).
function readVariants(tabId, url) {
  return withTab(tabId, async () => {
    const got = await chrome.storage.session.get([probeKey(tabId), varKey(tabId)]);
    const rec = isObject(got[probeKey(tabId)]) ? got[probeKey(tabId)][url] : undefined;
    const list = isObject(rec) && Array.isArray(rec.variants) ? sortVariants(rec.variants) : [];
    let choice = isObject(got[varKey(tabId)]) ? got[varKey(tabId)] : null;
    if (choice) {
      const { selected } = await readHub(tabId);
      if (choice.source !== url || !sameSelection(choice.selected || null, selected) || !list.some((v) => v.url === choice.url)) {
        await chrome.storage.session.remove(varKey(tabId));
        choice = null;
      }
    }
    return { rec: isObject(rec) ? rec : null, list, choice };
  });
}

// summarizeSource plus the variant fields for an hls source; starts a probe run
// only while the panel is open (a probe spawns the native host).
async function describeSource(tabId, r) {
  const summary = summarizeSource(r);
  if (!isHLS(r)) return summary;
  const { panelOpen } = await withTab(tabId, () => readHub(tabId));
  if (panelOpen) startProbes(tabId);
  const { rec, list, choice } = await readVariants(tabId, r.source.url);
  if (!rec) summary.probe = { state: "pending" };
  else if (rec.error) summary.probe = { state: "error", message: String(rec.error.message) };
  else if (list.length) {
    summary.variants = list.map((v) => ({ width: v.width, height: v.height, bandwidth: v.bandwidth }));
    const i = choice ? list.findIndex((v) => v.url === choice.url) : -1;
    summary.variant = Math.max(0, i);
  }
  return summary;
}

async function onChooseVariant(tabId, { index }) {
  const r = await correlate(tabId);
  if (!isHLS(r)) return { ok: false, error: "unknown-variant" };
  const { list } = await readVariants(tabId, r.source.url);
  if (index >= list.length) return { ok: false, error: "unknown-variant" };
  await withTab(tabId, async () => {
    if (index === 0) return chrome.storage.session.remove(varKey(tabId));
    const { selected } = await readHub(tabId);
    return chrome.storage.session.set({ [varKey(tabId)]: { source: r.source.url, url: list[index].url, selected } });
  });
  hubLog(`chooseVariant tab=${tabId} index=${index}`);
  return { ok: true, source: await describeSource(tabId, await correlate(tabId)) };
}

// --- send the job (4.3; rules under "Send the job" in the protocol) ---

// The app's reply mapped to the frame's (never the job or its source).
async function enqueueNative(job) {
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "enqueue", job });
  } catch {
    return { ok: false, error: "app-unreachable", message: APP_UNREACHABLE };
  }
  if (isObject(reply) && reply.type === "enqueued" && typeof reply.id === "string" && reply.id) {
    return { ok: true, jobId: reply.id.slice(0, 64) };
  }
  if (isObject(reply) && reply.type === "error" && typeof reply.code === "string") {
    const text = typeof reply.message === "string" ? reply.message.slice(0, MAX_MESSAGE_CHARS) : "";
    return { ok: false, error: "app-error", code: reply.code.slice(0, 32), message: text || "SegDown refused the job." };
  }
  return { ok: false, error: "app-error", code: "internal", message: "Unexpected reply from the SegDown app." };
}

// The tab's title (never the message body or the sending frame's document).
async function tabTitle(tabId, from) {
  let title = typeof from.tabTitle === "string" ? from.tabTitle : "";
  if (!title) {
    try {
      const tab = await chrome.tabs.get(tabId);
      title = typeof tab.title === "string" ? tab.title : "";
    } catch {
      // the tab is gone
    }
  }
  return cleanTitle(title);
}

// A failed ping as a Download reply.
function appFailure(appError) {
  return appError === APP_UNREACHABLE
    ? { ok: false, error: "app-unreachable", message: APP_UNREACHABLE }
    : { ok: false, error: "app-error", code: "internal", message: appError };
}

async function onDownload(tabId, from, body) {
  // A full clip never reads segs:<tabId>: its one segment comes from the plan below.
  // The page key is read with the segments, so a later navigation cannot relink them.
  let { segments, pageId } = body.full
    ? { segments: null, pageId: null }
    : await withTab(tabId, async () => ({
        segments: await readSegments(tabId),
        pageId: pageKeyOf((await chrome.storage.session.get(topKey(tabId)))[topKey(tabId)]),
      }));
  if (segments && !segments.length) return { ok: false, error: "no-segments" };
  // Settings, protocol and the incognito default come from a pong: without one
  // the job cannot follow the user's incognito choice.
  const app = await fetchDeps(true);
  if (app.appError) return appFailure(app.appError);
  const incognito = (await withTab(tabId, () => tabIncognito(tabId, from))).on || body.incognito;
  if (incognito && app.protocol < 2) return { ok: false, error: "app-outdated", message: INCOGNITO_NEEDS_UPDATE };
  const plan = await planSource(tabId, app.protocol); // own withTab turns; never nest
  if (!plan) return { ok: false, error: "no-source" };
  if (body.full) {
    // The end is the hub's own duration of the selected video, never the message's.
    const d = plan.r.duration;
    if (!isFiniteNum(d) || !(d > 0)) return { ok: false, error: "no-duration" };
    if (app.settings.maxDuration !== null && d > app.settings.maxDuration) return { ok: false, error: "over-limit" };
    segments = [{ start: 0, end: d }];
  }
  const title = await tabTitle(tabId, from);
  const mode = body.mode || app.settings.mode;
  // precision is required on the wire, but the app replaces it with its own setting.
  const job = { source: plan.source, title, segments: segments.map(({ start, end }) => ({ start, end })), mode, precision: "precise" };
  if (plan.fallback) job.fallback = plan.fallback;
  if (plan.r.duration !== null) job.mediaDuration = plan.r.duration;
  if (plan.r.pageURL) job.pageURL = plan.r.pageURL;
  if (incognito) job.incognito = true;
  const result = await enqueueNative(job);
  const kind = (s) => (s.type === "page" ? "page" : s.kind);
  hubLog(`download tab=${tabId} kind=${kind(plan.source)}${plan.fallback ? `+${kind(plan.fallback)}` : ""} segments=${segments.length} ${result.ok ? "enqueued" : `error=${result.code || result.error}`}`);
  if (result.ok) {
    // Incognito jobs: id and timestamp only, nothing in jobt.
    const entry = incognito ? { jobId: result.jobId, ts: Date.now() } : { jobId: result.jobId, title, ts: Date.now() };
    await withTab(tabId, async () => {
      const key = jobsKey(tabId);
      const jobs = (await chrome.storage.session.get({ [key]: [] }))[key];
      const list = Array.isArray(jobs) ? jobs : [];
      list.push(entry);
      await chrome.storage.session.set({ [key]: list.slice(-MAX_JOBS_PER_TAB) });
    });
    if (!incognito) await rememberJob(result.jobId, title, pageId ? { key: pageId, ranges: job.segments } : null);
  }
  return result;
}

// --- progress + cancel (4.4; rules under "Progress + cancel" in the protocol) ---

// jobt is shared by every tab, so it has its own queue.
const TITLES_QUEUE = "jobt";

// page: {key, ranges} of the segments the job carries, flagged once it is done.
function rememberJob(jobId, title, page) {
  return withTab(TITLES_QUEUE, async () => {
    const got = (await chrome.storage.session.get(TITLES_KEY))[TITLES_KEY];
    const titles = isObject(got) ? got : {};
    titles[jobId] = page ? { title, ts: Date.now(), page } : { title, ts: Date.now() };
    const ids = Object.keys(titles).sort((a, b) => titles[a].ts - titles[b].ts);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_KNOWN_JOBS))) delete titles[old];
    await chrome.storage.session.set({ [TITLES_KEY]: titles });
  });
}

// Sets done on the segments matching a range exactly; true when one changed.
function markDone(segments, ranges) {
  let changed = false;
  for (const s of segments) {
    if (s.done !== true && ranges.some((r) => isObject(r) && r.start === s.start && r.end === s.end)) {
      s.done = true;
      changed = true;
    }
  }
  return changed;
}

// Flags an existing seg:<key> record; never creates one.
async function markRecordDone(key, ranges) {
  const rec = (await chrome.storage.local.get(key))[key];
  const segments = isObject(rec) && cleanSegments(rec.segments);
  if (!segments || !markDone(segments, ranges)) return;
  await chrome.storage.local.set({ [key]: { ...rec, segments, ts: Date.now() } });
}

// After a status reply: flags the segments of every jobt page whose job is done,
// once (applied). Writes nothing when no entry is pending (runs on every poll).
async function applyDownloaded(jobs) {
  const doneIds = new Set(jobs.filter((j) => j.state === "done").map((j) => j.id));
  const pages = await withTab(TITLES_QUEUE, async () => {
    const titles = (await chrome.storage.session.get(TITLES_KEY))[TITLES_KEY];
    if (!isObject(titles)) return [];
    const ids = Object.keys(titles).filter((id) => {
      const t = titles[id];
      return isObject(t) && !t.applied && doneIds.has(id) && isObject(t.page) && typeof t.page.key === "string" && Array.isArray(t.page.ranges);
    });
    if (!ids.length) return [];
    // Marked before the writes below: a storage error there loses these flags (accepted).
    for (const id of ids) titles[id].applied = true;
    await chrome.storage.session.set({ [TITLES_KEY]: titles });
    return ids.map((id) => titles[id].page);
  });
  if (!pages.length) return;
  const byKey = new Map();
  for (const { key, ranges } of pages) byKey.set(key, [...(byKey.get(key) || []), ...ranges]);
  const session = await chrome.storage.session.get(null);
  for (const [key, ranges] of byKey) {
    const tabIds = Object.keys(session)
      .filter((k) => k.startsWith("page:") && isObject(session[k]) && session[k].key === key)
      .map((k) => Number(k.slice(5)))
      .filter(Number.isInteger);
    if (!tabIds.length) await markRecordDone(key, ranges);
    for (const tabId of tabIds) {
      const result = await withTab(tabId, async () => {
        // In the tab's turn: persistSegments writes seg:<key> in it too.
        await markRecordDone(key, ranges);
        const rec = await readPageRecord(tabId);
        if (!rec || rec.key !== key) return null;
        const segments = await readSegments(tabId);
        if (!markDone(segments, ranges)) return null;
        await chrome.storage.session.set({ [segsKey(tabId)]: segments });
        return { segments, selected: (await readHub(tabId)).selected };
      });
      if (result) segmentsUpdated(tabId, result.selected, result.segments);
    }
  }
  hubLog(`downloaded segments flagged pages=${byKey.size}`);
}

// True when jobt holds an unapplied entry for this tab's page (separate turns, never nested).
async function pageJobPending(tabId) {
  const rec = await withTab(tabId, () => readPageRecord(tabId));
  if (!rec) return false;
  return withTab(TITLES_QUEUE, async () => {
    const titles = (await chrome.storage.session.get(TITLES_KEY))[TITLES_KEY];
    return isObject(titles) && Object.values(titles).some((t) => isObject(t) && !t.applied && isObject(t.page) && t.page.key === rec.key && Array.isArray(t.page.ranges));
  });
}

function readTabJobs(tabId) {
  return withTab(tabId, async () => {
    const key = jobsKey(tabId);
    const list = (await chrome.storage.session.get({ [key]: [] }))[key];
    return Array.isArray(list) ? list.filter((j) => isObject(j) && isJobId(j.jobId)) : [];
  });
}

// "/Users/me/Downloads/SegDown/T/T - 01.mp4" -> "T - 01.mp4"
function baseName(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1].slice(0, 255) : "";
}

// One JobStatus from the app, copied field by field, or null.
function cleanJobStatus(s) {
  if (!isObject(s) || !isJobId(s.id) || !JOB_STATES.has(s.state)) return null;
  const count = Number.isInteger(s.segmentCount) && s.segmentCount >= 0 ? s.segmentCount : 0;
  const index = Number.isInteger(s.segmentIndex) && s.segmentIndex >= 0 ? Math.min(s.segmentIndex, Math.max(0, count - 1)) : 0;
  const outputs = Array.isArray(s.outputs) ? s.outputs.slice(0, MAX_OUTPUTS).filter((o) => typeof o === "string") : [];
  return {
    id: s.id,
    state: s.state,
    segmentIndex: index,
    segmentCount: count,
    fraction: isFiniteNum(s.fraction) ? Math.min(1, Math.max(0, s.fraction)) : 0,
    message: typeof s.message === "string" && s.message ? s.message.slice(0, MAX_MESSAGE_CHARS) : null,
    outputs: outputs.map(baseName).filter(Boolean),
    bytes: Number.isSafeInteger(s.bytes) && s.bytes >= 0 ? s.bytes : null,
    fallbackUsed: s.fallbackUsed === true,
  };
}

// The status port: one connectNative port, replies matched to requests in order.
const statusPort = { port: null, pending: [], idleTimer: null, fallbackNext: false };
// Safari (the only target with globalThis.browser) hands port messages to the appex but
// never routes its replies back to the port, so status always uses sendNativeMessage there.
const HAS_STATUS_PORT = typeof chrome.runtime.connectNative === "function" && typeof globalThis.browser === "undefined";

function openStatusPort() {
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  port.onMessage.addListener((msg) => {
    if (statusPort.port !== port) return;
    const head = statusPort.pending.shift();
    if (!head) return; // nothing asked: ignore
    clearTimeout(head.timer);
    head.resolve(msg);
    armPortIdle();
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // read, so Chrome does not report it as unchecked
    if (statusPort.port === port) closeStatusPort(true);
  });
  statusPort.port = port;
  hubLog("status port opened");
}

// failed: the next status goes through sendNativeMessage. Fails every pending request.
function closeStatusPort(failed) {
  const { port, pending } = statusPort;
  statusPort.port = null;
  statusPort.pending = [];
  clearTimeout(statusPort.idleTimer);
  statusPort.idleTimer = null;
  if (failed) statusPort.fallbackNext = true;
  try {
    if (port) port.disconnect();
  } catch {
    // already gone
  }
  for (const p of pending) {
    clearTimeout(p.timer);
    p.reject(new Error("status port closed"));
  }
  if (port) hubLog(`status port closed${failed ? " (failed)" : ""}`);
}

function armPortIdle() {
  clearTimeout(statusPort.idleTimer);
  statusPort.idleTimer = null;
  if (!statusPort.port || statusPort.pending.length) return;
  statusPort.idleTimer = setTimeout(() => {
    if (!statusPort.pending.length) closeStatusPort(false);
  }, PORT_IDLE_MS);
}

function portRequest(msg) {
  if (!statusPort.port) openStatusPort();
  const port = statusPort.port;
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      if (statusPort.port === port) closeStatusPort(true);
    }, STATUS_TIMEOUT_MS);
    statusPort.pending.push(entry);
    armPortIdle(); // pending: clears the idle timer
    try {
      port.postMessage(msg);
    } catch {
      closeStatusPort(true);
    }
  });
}

// The last good status, for appError replies.
let lastJobs = [];
let statusRun = null;

// -> {jobs: [clean JobStatus]} or {error: message}. Concurrent callers share one request.
function fetchStatus() {
  if (!statusRun) {
    statusRun = statusOnce().finally(() => {
      statusRun = null;
    });
  }
  return statusRun;
}

async function statusOnce() {
  const msg = { type: "status" };
  let reply;
  try {
    if (statusPort.fallbackNext || !HAS_STATUS_PORT) {
      statusPort.fallbackNext = false;
      reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, msg);
    } else {
      reply = await portRequest(msg);
    }
  } catch {
    return { error: APP_UNREACHABLE };
  }
  if (isObject(reply) && reply.type === "status" && Array.isArray(reply.jobs)) {
    lastJobs = reply.jobs.map(cleanJobStatus).filter(Boolean);
    await applyDownloaded(lastJobs).catch(hubWarn);
    return { jobs: lastJobs };
  }
  if (isObject(reply) && reply.type === "error" && typeof reply.message === "string" && reply.message) {
    return { error: reply.message.slice(0, MAX_MESSAGE_CHARS) };
  }
  return { error: "Unexpected reply from the SegDown app." };
}

async function onJobs(tabId) {
  const tabJobs = await readTabJobs(tabId);
  if (!tabJobs.length) return { ok: true, jobs: [] };
  const st = await fetchStatus();
  const list = st.jobs || lastJobs;
  const byId = new Map(list.map((j) => [j.id, j]));
  const unknown = (id) => ({ id, state: "unknown", segmentIndex: 0, segmentCount: 0, fraction: 0, message: null, outputs: [], bytes: null, fallbackUsed: false });
  const jobs = tabJobs
    .slice()
    .reverse()
    .map((j) => ({ ...(byId.get(j.jobId) || unknown(j.jobId)), title: typeof j.title === "string" && j.title ? j.title : `Job ${j.jobId.slice(0, 8)}` }));
  const reply = { ok: true, jobs };
  if (st.error) reply.appError = st.error;
  return reply;
}

async function cancelNative(id) {
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "cancel", id });
  } catch {
    return { ok: false, error: "app-unreachable", message: APP_UNREACHABLE };
  }
  if (isObject(reply) && reply.type === "cancelled") return { ok: true };
  if (isObject(reply) && reply.type === "error" && typeof reply.code === "string") {
    const text = typeof reply.message === "string" ? reply.message.slice(0, MAX_MESSAGE_CHARS) : "";
    return { ok: false, error: "app-error", code: reply.code.slice(0, 32), message: text || "SegDown could not cancel the job." };
  }
  return { ok: false, error: "app-error", code: "internal", message: "Unexpected reply from the SegDown app." };
}

// A frame may cancel its own tab's jobs only.
async function onCancel(tabId, { id }) {
  if (!(await readTabJobs(tabId)).some((j) => j.jobId === id)) return { ok: false, error: "unknown-job" };
  const result = await cancelNative(id);
  hubLog(`cancel tab=${tabId} ${result.ok ? "ok" : `error=${result.code || result.error}`}`);
  return result;
}

// --- overlay view (5.2; rules under "Overlay view" in the protocol) ---

// 3725 -> "1:02:05", 65 -> "1:05".
function formatTime(seconds) {
  const t = Math.floor(seconds);
  const pad = (n) => String(n).padStart(2, "0");
  const [h, m, s] = [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60];
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function videoLabel(c) {
  const size = c.width ? `${c.width}x${c.height}` : "Video";
  return `${size} · ${c.live ? "live" : c.duration === null ? "unknown length" : formatTime(c.duration)}`;
}

function variantLabel(v) {
  const rate = `${(v.bandwidth / 1e6).toFixed(1)} Mbps`;
  return v.width ? `${v.width}x${v.height} · ${rate}` : rate;
}

// The text that disables Download, or null: ffmpeg runs every job; yt-dlp is
// needed only for a page source without a fallback (with one, the app skips
// the page attempt when yt-dlp is missing). deno never blocks.
function depsProblem(missing, plan) {
  const need = plan && plan.source.type === "page" && !plan.fallback ? ["ffmpeg", "yt-dlp"] : ["ffmpeg"];
  const absent = need.filter((t) => missing.includes(t));
  if (!absent.length) return null;
  return `${absent.join(" and ")} ${absent.length > 1 ? "are" : "is"} not installed: see Dependencies in the SegDown app`;
}

async function onView(tabId, from) {
  const app = await fetchDeps();
  const settings = app.settings || cleanSettings(null);
  // Before the segments are read: its status call may flag downloaded ones.
  const newest = (await onJobs(tabId)).jobs[0];
  // No tab jobs (e.g. reloaded before the job finished): ask the app for this page's pending one.
  if (!newest && (await pageJobPending(tabId))) await fetchStatus();
  const { hub, segments, cands, entries, inc } = await withTab(tabId, async () => ({
    hub: await readHub(tabId),
    segments: await readSegments(tabId),
    cands: await readCands(tabId),
    entries: (await chrome.storage.session.get({ [capKey(tabId)]: [] }))[capKey(tabId)],
    inc: await tabIncognito(tabId, from),
  }));
  const plan = await planSource(tabId, app.appError ? null : app.protocol);
  const source = plan ? await describeSource(tabId, plan.r) : null;
  if (source && source.variants) source.variants = source.variants.map((v) => ({ ...v, label: variantLabel(v) }));
  const list = sourceList(Array.isArray(entries) ? entries : []);
  const sourceIndex = plan && plan.r.source.type === "media" ? list.findIndex((e) => e.url === plan.r.source.url) : -1;
  const pool = mergeCandidates(cands).filter((c) => c.excluded === null || sameSelection(c, hub.selected));
  const videoIndex = pool.findIndex((c) => sameSelection(c, hub.selected));
  const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const overLimit = settings.maxDuration !== null && total > settings.maxDuration;
  const reply = {
    ok: true,
    segments,
    pendingStart: hub.pendingStart,
    duration: videoIndex >= 0 ? pool[videoIndex].duration : null,
    source,
    pageFirst: Boolean(plan && plan.fallback),
    sources: list.map((e) => {
      const { kind, host, file } = summarizeSource(entrySource(e, "capture"));
      return { kind, host, file };
    }),
    sourceIndex: sourceIndex >= 0 ? sourceIndex : null,
    videos: pool.map((c) => ({ frameId: c.frameId, videoKey: c.videoKey, label: videoLabel(c) })),
    videoIndex: videoIndex >= 0 ? videoIndex : null,
    incognito: { on: inc.on, forced: inc.forced },
    mode: settings.mode,
    fullClip: settings.fullClipButton,
    overLimit,
    maxDuration: settings.maxDuration, // null = no limit
    job: newest
      ? (({ id, state, segmentIndex, segmentCount, fraction, bytes, message, fallbackUsed }) =>
          ({ id, state, segmentIndex, segmentCount, fraction, bytes, message, fallbackUsed }))(newest)
      : null,
  };
  const problem = depsProblem(app.missing, plan);
  if (problem) reply.depsProblem = problem;
  if (app.appError) reply.appError = app.appError;
  return reply;
}

// Single entry point for every hub message (the listener and the debug helper).
// tabId/frameId and from = {tabTitle, tabIncognito} come from the sender, never from msg.
function hubDispatch(tabId, frameId, msg, from = {}) {
  const body = HUB_VALIDATORS.has(msg.type) ? HUB_VALIDATORS.get(msg.type)(msg) : null;
  if (!body) return Promise.resolve({ ok: false, error: "bad-message" });
  if (!SELECTED_FRAME_TYPES.has(msg.type)) return route(tabId, frameId, msg.type, body, from);
  return isSelectedFrame(tabId, frameId, msg.type, body).then((ok) =>
    ok ? route(tabId, frameId, msg.type, body, from) : { ok: false, error: "not-selected-frame" }
  );
}

function route(tabId, frameId, type, body, from) {
  switch (type) {
    case "candidates":
      return onCandidates(tabId, frameId, body);
    case "key":
      return onKey(tabId, body);
    case "removeSegment":
      return onRemoveSegment(tabId, body);
    case "clearSegments":
      return onClearSegments(tabId);
    case "seek":
    case "getTime":
    case "play":
    case "pause":
      return toSelected(tabId, { type, ...body });
    case "select":
      return onSelect(tabId, body);
    case "openOverlay":
      return onOpenOverlay(tabId, frameId, body);
    case "getState":
      return onGetState(tabId, frameId);
    case "setPanelOpen":
      return setPanelOpen(tabId, body.open);
    case "getSource":
      return onGetSource(tabId);
    case "chooseSource":
      return onChooseSource(tabId, body);
    case "chooseVariant":
      return onChooseVariant(tabId, body);
    case "download":
      return onDownload(tabId, from, body);
    case "jobs":
      return onJobs(tabId);
    case "cancel":
      return onCancel(tabId, body);
    case "deps":
      return onDeps();
    case "setIncognito":
      return onSetIncognito(tabId, from, body);
    case "view":
      return onView(tabId, from);
    default:
      return Promise.resolve({ ok: false, error: "bad-message" });
  }
}

// --- listeners (registered synchronously at top level) ---

function replyAsync(promise, sendResponse) {
  promise.then(sendResponse, (err) => {
    hubWarn(err);
    sendResponse({ ok: false, error: "internal" });
  });
  return true; // async reply
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isObject(msg)) return undefined;
  if (!HUB_VALIDATORS.has(msg.type)) return undefined; // not a hub message
  const tabId = sender.tab && sender.tab.id;
  if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(sender.frameId) || sender.frameId < 0) {
    return undefined;
  }
  const from = { tabTitle: sender.tab.title, tabIncognito: sender.tab.incognito === true };
  return replyAsync(hubDispatch(tabId, sender.frameId, msg, from), sendResponse);
});

// The app's settings as soon as the extension is installed or updated, not only
// when the overlay first opens. Not on a browser update ("chrome_update"): the
// ping launches the app.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install" || reason === "update") fetchDeps().catch(hubWarn);
});

// A subframe that navigates takes its videos with it (top-frame navigation clears
// the whole tab in the capture section).
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId > 0) dropFrame(details.tabId, details.frameId);
});

// Safari has no onHistoryStateUpdated: SPA navigations there keep the old page key.
chrome.webNavigation.onHistoryStateUpdated?.addListener((details) => {
  if (details.frameId !== 0) return;
  setTopURL(details.tabId, details.url).catch(hubWarn);
  onPageChanged(details.tabId, details.url).catch(hubWarn);
});

// Content scripts never reach storage.local; only this worker reads and writes it.
// Not every browser supports an access level for storage.local; then this only logs.
try {
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(hubWarn);
} catch (err) {
  hubWarn(err);
}

// Overlay toggle: the toolbar button and the "toggle-panel" shortcut (see the protocol).
async function toggleOverlay(tabId) {
  const { state } = await setPanelOpen(tabId, null);
  if (state.selected) return notifyOverlay(tabId, state.selected.frameId, { type: "toggleOverlay", open: state.panelOpen });
  // No video to open the overlay on: a short badge says so.
  const badge = (text) => chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  badge("none");
  setTimeout(() => badge(""), NO_VIDEO_BADGE_MS);
}

function toggleOverlayIn(tab) {
  if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return;
  toggleOverlay(tab.id).catch(hubWarn);
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-panel") return;
  if (tab) return toggleOverlayIn(tab);
  chrome.tabs
    .query({ active: true, currentWindow: true })
    .then((tabs) => toggleOverlayIn(tabs[0]))
    .catch(hubWarn);
});

// Fires only without a default_popup in the manifest (removed in 5.4).
chrome.action.onClicked.addListener(toggleOverlayIn);

// --- debug (service-worker console only) ---

// segdownDebugSeek(tabId, seconds): seeks the selected video (the auto-picked
// main video unless the user chose one). Goes through hubDispatch as that video's frame.
async function segdownDebugSeek(tabId, time) {
  const { selected } = await withTab(tabId, () => readHub(tabId));
  return selected ? hubDispatch(tabId, selected.frameId, { type: "seek", time }) : { ok: false, error: "no-selection" };
}
