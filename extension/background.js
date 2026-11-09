// SegDown background service worker (classic script, no modules).
// Sections: config, media capture (3.2), hub + frame routing (3.3, auto-pick 3.4,
// overlay toggle 3.5, marking 3.6, hub-owned segments and their persistence,
// selected-frame gating, source correlation 4.1, HLS variant picker 4.2, page
// resolution picker, player introspection, send the job 4.3, progress + cancel
// 4.4, app settings, ignored sites, incognito and the overlay view 5.2, toolbar
// menu).

"use strict";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Logs one line per new capture (frameId, kind, header names; never values or URLs).
const DEBUG = true;

// Only the Firefox build (scripts/build-firefox-addon.sh) has a gecko block in its manifest.
const IS_FIREFOX = Boolean(chrome.runtime.getManifest().browser_specific_settings?.gecko);

// Same canonical names as SegDownCore Validation.allowedHeaders.
const ALLOWED_HEADERS = ["Referer", "Origin", "User-Agent", "Cookie"];
const MAX_HEADER_VALUE_BYTES = 8 * 1024; // Validation.maxHeaderValueBytes
const MAX_ENTRIES_PER_TAB = 50;
// Within the tab cap, so one frame (e.g. a page flooding fake .m3u8 requests)
// cannot evict another frame's playlist.
const MAX_ENTRIES_PER_FRAME = 20;
const PENDING_TTL_MS = 60 * 1000;
const MAX_PENDING = 500;
// After a page change, chunks within this window still belong to the previous video (in flight).
const STALE_GRACE_MS = 1000;
// Request types that never carry media we can download.
const IGNORED_TYPES = new Set(["script", "stylesheet", "image", "font"]);

const HLS_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
  "video/x-mpegurl",
  "video/mpegurl",
  "application/octet-stream-m3u8",
]);
const DASH_TYPES = new Set(["application/dash+xml", "video/vnd.mpeg.dash.mpd"]);
const MP4_TYPES = new Set(["video/mp4", "video/quicktime", "video/x-m4v"]);
// Progressive files other than mp4/mov (kind "file"): their codecs may not fit in mp4.
const FILE_TYPES = new Set(["video/webm", "video/x-matroska", "video/ogg", "video/3gpp"]);
const MP4_EXTS = [".mp4", ".mov", ".m4v"];
const FILE_EXTS = [".webm", ".mkv", ".ogv", ".3gp"];
// A "file" whose whole size is known and under this is a hover preview or a UI loop.
const MIN_FILE_BYTES = 32 * 1024;
const CHUNK_TYPES = new Set(["video/mp2t", "video/iso.segment"]);
// A small fetch/XHR response with one of these types may be a disguised playlist (e.g.
// master.html served as text/html): captured as kind "maybe" until the app's probe tells.
const MAYBE_HLS_TYPES = new Set(["text/html", "text/plain", "application/octet-stream", ""]);
const MAX_MAYBE_HLS_BYTES = 256 * 1024; // larger ones are segments, not playlists
// A numbered progressive file (.mp4, .webm, ...) whose whole file is smaller than this is a piece, not a video.
const MAX_PIECE_BYTES = 64 * 1024;
// Query params that pick a byte range of the same file (fbcdn bytestart/byteend): stripped so
// ranged fetches of one video collapse into one entry.
const RANGE_PARAMS = new Set(["bytestart", "byteend", "range", "rbuf"]);

// ---------------------------------------------------------------------------
// Media capture: pending request headers (memory only, short-lived)
// ---------------------------------------------------------------------------

// requestId -> {tabId, frameId, url, firstUrl, headers, ts, refetch?}. firstUrl: the URL of
// the chain's first hop (redirects re-fire onSendHeaders with the same requestId). refetch:
// the hub's own page re-fetch (refetching below), never captured. Map keeps insertion
// order, oldest first.
const pending = new Map();

// The hub's page re-fetches in flight (refetchPlaylist): refetchKey -> expiry ts. Their
// requests neither create nor move a capture, nor bump act:<tabId>.
const refetching = new Map();
const refetchKey = (tabId, frameId, url) => `${tabId} ${frameId} ${url}`;

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

// The URL without its RANGE_PARAMS; unchanged (same string) when it has none. Other params
// keep their exact encoding (signed CDN URLs).
function stripRangeParams(url) {
  const u = new URL(url);
  const pairs = u.search.slice(1).split("&");
  const kept = pairs.filter((p) => !RANGE_PARAMS.has(p.split("=")[0]));
  if (kept.length === pairs.length) return url;
  u.search = kept.join("&");
  return u.href;
}

function contentType(responseHeaders) {
  const h = (responseHeaders || []).find((x) => String(x.name).toLowerCase() === "content-type");
  return h && typeof h.value === "string" ? h.value.split(";")[0].trim().toLowerCase() : "";
}

// Content-Length in bytes, or null when missing or not a number.
function contentLength(responseHeaders) {
  const h = (responseHeaders || []).find((x) => String(x.name).toLowerCase() === "content-length");
  const n = h ? Number(h.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Whole file size in bytes: the N of a 206's Content-Range (bytes a-b/N), a 200's Content-Length,
// else null (also when N is * or unparseable).
function totalSize(responseHeaders, status) {
  if (status === 200) return contentLength(responseHeaders);
  if (status !== 206) return null;
  const h = (responseHeaders || []).find((x) => String(x.name).toLowerCase() === "content-range");
  const m = h && typeof h.value === "string" ? /\/\s*(\d+)\s*$/.exec(h.value) : null;
  return m ? Number(m[1]) : null;
}

// The lowercased extension (".webm") of the Content-Disposition filename, else "".
function dispositionExt(responseHeaders) {
  const h = (responseHeaders || []).find((x) => String(x.name).toLowerCase() === "content-disposition");
  const m = h && typeof h.value === "string" ? /filename\*?=(?:[\w-]+'[^']*')?"?([^";]*)"?/i.exec(h.value) : null;
  const ext = m ? /\.[a-z0-9]{2,5}$/.exec(m[1].trim().toLowerCase()) : null;
  return ext ? ext[0] : "";
}

// Returns "hls" | "dash" | "mp4" | "file" | "chunk" | "maybe" | null ("dash": an MPD
// manifest; "file": a progressive file other than mp4/mov, e.g. WebM). The path first
// drops one trailing numeric suffix after a real extension (clip.mp4.3 -> clip.mp4).
// First match wins:
//   1. a .m3u8 path -> hls, a .mpd path -> dash, whatever the type (the path names a
//      playlist or manifest even when it is served as video/mp2t or video/mp4);
//   2. a .ts/.m4s path or a CHUNK_TYPES type -> chunk (fMP4 segments are often served
//      as video/mp4);
//   3. a would-be progressive file (an mp4 or file type or extension, any other video/*)
//      -> chunk when it is an init segment (init.mp4, seg_init-1.webm, ...) or a numbered
//      piece (seg-12.mp4) whose total (whole file, from Content-Range for a 206) is under
//      MAX_PIECE_BYTES; never a Range's own length, so a big progressive file stays one;
//   4. HLS_TYPES -> hls; 5. DASH_TYPES -> dash;
//   6. an mp4 type or extension -> mp4, with no size floor (a short real clip must stay);
//   7. a file type or extension, or any other video/* -> file, except when the total is
//      known and under MIN_FILE_BYTES (hover previews, UI loops) -> null;
//   8. application/octet-stream whose Content-Disposition filename (dispExt) has an mp4
//      or file extension -> that kind (the floor of 7 applies to file);
//   9. "maybe": a fetch/XHR response that could be a playlist under another name (a GET
//      with a body: MAYBE_HLS_TYPES, at most MAX_MAYBE_HLS_BYTES; never a 204 or an
//      empty body).
// (addEntry also turns a numbered .webm of a frame that has a dash capture into a chunk.)
function classify(pathname, ctype, type, length, method, status, total, dispExt = "") {
  const path = pathname.toLowerCase().replace(/(\.[a-z0-9]{2,5})\.\d{1,3}$/, "$1");
  const hasExt = (exts) => exts.some((x) => path.endsWith(x));
  if (path.endsWith(".m3u8")) return "hls";
  if (path.endsWith(".mpd")) return "dash";
  if (path.endsWith(".ts") || path.endsWith(".m4s") || CHUNK_TYPES.has(ctype)) return "chunk";
  const isMp4 = MP4_TYPES.has(ctype) || hasExt(MP4_EXTS);
  const otherVideo = ctype.startsWith("video/") && !HLS_TYPES.has(ctype) && !DASH_TYPES.has(ctype);
  const isFile = FILE_TYPES.has(ctype) || hasExt(FILE_EXTS) || otherVideo;
  if (
    (isMp4 || isFile) &&
    (/(?:^|[-_.\/])init(?:[-_.][\w-]*)?\.(?:mp4|m4v|m4a|mov|webm|mkv|ogv|3gp)$/i.test(path) ||
      (total !== null && total < MAX_PIECE_BYTES && /\d\.(?:mp4|m4v|m4a|mov|webm|mkv|ogv|3gp)$/i.test(path)))
  ) {
    return "chunk";
  }
  if (HLS_TYPES.has(ctype)) return "hls";
  if (DASH_TYPES.has(ctype)) return "dash";
  if (isMp4) return "mp4";
  const fileKind = total !== null && total < MIN_FILE_BYTES ? null : "file";
  if (isFile) return fileKind;
  if (ctype === "application/octet-stream" && MP4_EXTS.includes(dispExt)) return "mp4";
  if (ctype === "application/octet-stream" && FILE_EXTS.includes(dispExt)) return fileKind;
  if (
    type === "xmlhttprequest" &&
    method === "GET" &&
    status !== 204 &&
    MAYBE_HLS_TYPES.has(ctype) &&
    (length === null || (length > 0 && length <= MAX_MAYBE_HLS_BYTES))
  ) {
    return "maybe";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Media capture: per-tab store in chrome.storage.session
// Keys: cap:<tabId> -> [{url, alias?, frameId, kind, isMaster?, headers, ts, sw?, staleAt?}] (oldest
//                      first; kind "hls" | "dash" | "mp4" | "file" | "maybe"; alias: the pre-redirect
//                      URL of a redirected request, kept when a later capture of the same url
//                      carries none; sw: requested by the page's service worker (tabId -1), bound
//                      to the one tab on its origin as frame 0; staleAt: the time of the
//                      same-document page change it predates, dropped when it is captured again)
//       act:<tabId> -> {<frameId>: {lastChunkUrl, headers, count, ts}} (headers: the allowlisted
//                      ones the browser sent for that chunk; a player probe's playlist base)
//       top:<tabId> -> the top frame's http(s) URL, from webNavigation (never from a content script)
//       hub:<tabId>, cand:<tabId>, segs:<tabId>, page:<tabId>, src:<tabId>, probe:<tabId>, var:<tabId>,
//       res:<tabId>, intro:<tabId>, jobs:<tabId> and inc:<tabId> belong to the hub (see the hub section).
// isMaster comes from the app's probe (4.2): set on every entry with the probed URL,
// and on entries captured later from the probe:<tabId> cache. A "maybe" entry becomes
// "hls" once the probe parses it as a playlist (also from that cache) and is removed
// when the app says it is not one; until then only the probe run reads it.
// At most MAX_ENTRIES_PER_FRAME entries per frame (that frame's oldest stale entry goes
// first, then its newest maybe but the one just captured, then its oldest mp4 or file,
// then its oldest entry) and
// MAX_ENTRIES_PER_TAB per tab (taken from the frame with the most entries, same order).
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
const resKey = (tabId) => `res:${tabId}`;
const jobsKey = (tabId) => `jobs:${tabId}`;
const incKey = (tabId) => `inc:${tabId}`;
const introKey = (tabId) => `intro:${tabId}`;

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
  // A numbered .webm of a frame that plays DASH is one of its segments, not a file.
  const piece = entry.kind === "file" && /\d\.webm$/.test(new URL(entry.url).pathname.toLowerCase());
  if (piece && entries.some((e) => e.frameId === entry.frameId && e.kind === "dash")) {
    return bumpActive(tabId, entry.frameId, entry.url, entry.headers, entry.ts);
  }
  const probed = got[probeKey(tabId)][entry.url];
  // A refetch of a known non-playlist (a polled URL) is not probed again.
  if (entry.kind === "maybe" && isObject(probed) && isObject(probed.error) && probed.error.code === "invalid") return;
  if (probed && Array.isArray(probed.variants)) {
    entry.isMaster = probed.variants.length > 0;
    if (entry.kind === "maybe") entry.kind = "hls"; // a playlist refetch stays the playlist
  }
  const index = entries.findIndex((e) => e.url === entry.url);
  const isNew = index < 0;
  // Later Range requests (moov at the end, seeks) go straight to the final URL: keep the alias.
  if (!isNew && entry.alias === undefined && typeof entries[index].alias === "string") {
    entry.alias = entries[index].alias;
  }
  // Also from the stored entry: its probe record may have left the cache (MAX_PROBE_CACHE).
  if (!isNew && entry.kind === "maybe" && entries[index].kind === "hls") {
    Object.assign(entry, { kind: "hls", isMaster: entries[index].isMaster }); // a probed playlist's refetch
  }
  if (!isNew && entry.kind === "maybe") {
    entries[index] = entry; // keeps its place: eviction spares a frame's earliest maybes
  } else {
    if (!isNew) entries.splice(index, 1); // dedupe by URL (mp4 Range requests, playlist refetches)
    entries.push(entry);
  }
  const inFrame = () => entries.filter((e) => e.frameId === entry.frameId).length;
  while (inFrame() > MAX_ENTRIES_PER_FRAME) dropOldest(entries, entry.frameId, entry);
  while (entries.length > MAX_ENTRIES_PER_TAB) dropOldest(entries, largestFrame(entries), entry);
  await chrome.storage.session.set({ [key]: entries });
  if (DEBUG && isNew) {
    console.debug(
      `[SegDown] capture tab=${tabId} frame=${entry.frameId} kind=${entry.kind}${entry.sw ? " sw" : ""} headers=[${Object.keys(entry.headers).join(", ")}]`
    );
  }
}

// Removes one entry of frameId: its oldest stale entry (staleAt: from a previous page
// of a single-page app), else its newest maybe other than `added` (the entry just
// stored), so a frame keeps its earliest maybes (a player fetches its disguised
// playlists first, and a refetch keeps its place) and a page's other requests never
// evict media, then its oldest mp4 or file, so segment churn never evicts a playlist
// or manifest, else
// its oldest entry.
function dropOldest(entries, frameId, added) {
  let i = entries.findIndex((e) => e.frameId === frameId && e.staleAt !== undefined && e !== added);
  if (i < 0) i = entries.findLastIndex((e) => e.frameId === frameId && e.kind === "maybe" && e !== added);
  if (i < 0) i = entries.findIndex((e) => e.frameId === frameId && (e.kind === "mp4" || e.kind === "file"));
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

async function bumpActive(tabId, frameId, url, headers, ts) {
  const key = actKey(tabId);
  const active = (await chrome.storage.session.get({ [key]: {} }))[key];
  const prev = active[frameId];
  active[frameId] = { lastChunkUrl: url, headers, count: (prev ? prev.count : 0) + 1, ts };
  await chrome.storage.session.set({ [key]: active });
}

// Bumped by clearTab, so a probe that was in flight does not write into the next page.
const tabGens = new Map();
const tabGen = (tabId) => tabGens.get(tabId) || 0;

// Player introspection (hub section): bumped by clearTab and onPageChanged, so a
// player probe in flight writes nothing into the next page. The tab's manifest
// text from the last probe stays in memory only (storage.session quota):
// tabId -> {ts (= intro:<tabId>.ts), text}, at most MAX_INTRO_MANIFESTS tabs.
const introGens = new Map();
const introGen = (tabId) => introGens.get(tabId) || 0;
const introManifests = new Map();

function clearTab(tabId) {
  tabGens.set(tabId, tabGen(tabId) + 1);
  introGens.set(tabId, introGen(tabId) + 1);
  introManifests.delete(tabId);
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
      resKey(tabId),
      introKey(tabId),
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

// Also for tabId -1 (a page's service worker), so onHeadersReceived knows its headers.
function onSendHeaders(details) {
  const now = Date.now();
  const prev = pending.get(details.requestId); // an earlier hop of the same redirect chain
  pending.delete(details.requestId); // redirects re-fire with the same id; keep order honest
  const entry = {
    tabId: details.tabId,
    frameId: details.frameId,
    url: details.url,
    firstUrl: prev ? prev.firstUrl : details.url,
    headers: pickHeaders(details.requestHeaders),
    ts: now,
  };
  if ((prev && prev.refetch) || refetching.has(refetchKey(details.tabId, details.frameId, details.url))) entry.refetch = true;
  pending.set(details.requestId, entry);
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

// A prerendered page's outermost frame (Chrome speculation rules): not shown yet, and
// its frame id changes on activation. Firefox and Safari send neither field.
function isActiveTop(details) {
  const top = details.frameType ? details.frameType === "outermost_frame" : details.frameId === 0;
  return top && (!details.documentLifecycle || details.documentLifecycle === "active");
}

// The tab a service-worker request (tabId -1) belongs to, or null: the one http(s)
// tab on the worker's origin (initiator in Chromium, originUrl in Firefox), and with
// several, the one whose URL is the request's Referer (both without their hash).
// Only tabs on the request's side when it says which one (Firefox); without that field
// (Chrome), null as soon as an incognito tab is on the origin, as the side is unknown.
async function workerTab(details, headers) {
  const from = typeof details.initiator === "string" ? details.initiator : details.originUrl;
  const u = typeof from === "string" ? httpURL(from) : null;
  if (!u) return null;
  const noHash = (url) => url.split("#")[0];
  let tabs = (await chrome.tabs.query({})).filter((tab) => {
    const t = Number.isInteger(tab.id) ? httpURL(tab.url) : null;
    return t !== null && t.origin === u.origin;
  });
  if (typeof details.incognito === "boolean") tabs = tabs.filter((tab) => tab.incognito === details.incognito);
  else if (tabs.some((tab) => tab.incognito === true)) return null;
  if (tabs.length > 1) {
    const referer = typeof headers.Referer === "string" ? noHash(headers.Referer) : null;
    tabs = referer ? tabs.filter((tab) => noHash(tab.url) === referer) : [];
  }
  return tabs.length === 1 ? tabs[0].id : null;
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.documentLifecycle === "prerender") return; // see isActiveTop
    const { tabId, frameId, requestId, url } = details;
    if (refetching.has(refetchKey(tabId, frameId, url))) return; // the hub's own re-fetch
    if (IGNORED_TYPES.has(details.type)) return;
    if (details.statusCode < 200 || details.statusCode > 299) return;
    // If the worker restarted since onSendHeaders, store the entry without headers.
    const p = pending.get(requestId);
    if (p && p.refetch) return; // a re-fetch whose key is gone already, or a redirect hop of one
    const parsed = httpURL(url);
    if (!parsed) return;
    const kind = classify(
      parsed.pathname,
      contentType(details.responseHeaders),
      details.type,
      contentLength(details.responseHeaders),
      details.method,
      details.statusCode,
      totalSize(details.responseHeaders, details.statusCode),
      dispositionExt(details.responseHeaders)
    );
    if (!kind) return;
    const ts = Date.now();
    const headers = p ? p.headers : {};
    // isMaster: from an earlier probe of this URL (addEntry), else set by the 4.2 probe.
    // Without its range params, so addEntry's dedupe by URL collapses ranged fetches (chunks keep theirs).
    const entry = { url: stripRangeParams(url), frameId, kind, headers, ts };
    // alias: the pre-redirect URL (a <video src> that 302s keeps it as its currentSrc).
    const first = p ? p.firstUrl : null;
    if (first && first.length <= MAX_URL_LENGTH && httpURL(first) && stripRangeParams(first) !== entry.url) {
      entry.alias = stripRangeParams(first);
    }
    // A page's service worker (no frame): media only, as frame 0 of the one tab it serves.
    if (tabId < 0) {
      if (!MEDIA_KINDS.has(kind)) return;
      workerTab(details, headers)
        .then((boundTab) => {
          if (boundTab === null) return undefined;
          return withTab(boundTab, () => addEntry(boundTab, { ...entry, frameId: 0, sw: true }));
        })
        .catch(logError);
      return;
    }
    if (kind === "chunk") {
      withTab(tabId, () => bumpActive(tabId, frameId, url, headers, ts)).catch(logError);
      return;
    }
    withTab(tabId, () => addEntry(tabId, entry)).catch(logError);
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
// after the clear and the page's saved segments are read for that URL. A prerender
// commit fires while the user still sees the old page; its activation commits again
// as "active", and that one clears the tab.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (!isActiveTop(details)) return;
  clearTab(details.tabId).catch(logError);
  setTopURL(details.tabId, details.url)
    .then(() => refreshActionMenu().catch(hubWarn))
    .catch(logError);
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
// not own (no sendResponse, so later onMessage listeners still get them). It also
// ignores every message from a prerendered page (sender.documentLifecycle
// "prerender", Chrome 106+): that page is not shown yet. A
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
// header values, no captures; one stated exception: copyText, see Source
// correlation). Exceptions: while nothing is selected, a frame
// may `select` one of its own videos (frameId = its sender.frameId), so it can
// claim the overlay; and `openOverlay` (the player button), `fullOptions` and
// `downloadFull` (the Download full button) are accepted from any frame, for its
// own videos only.
//
//   Agent (every frame, owns that frame's <video> elements):
//   candidates {videos: [{videoKey, area, duration, live, paused, excluded, score,
//              currentSrc?, videoId?, blob?, drm?}]}
//              The frame's full list (replaces the previous one, [] clears it).
//              videoKey: [A-Za-z0-9_-]{1,64}, stable per element for the frame's
//              lifetime. area: finite >= 0, the part of the video inside the
//              frame's viewport (CSS px^2). duration: finite >= 0, or null when
//              unknown or live (JSON turns Infinity into null, so live videos
//              send live: true). excluded: null | "ad" (an ancestor has an ad
//              class token or id, see agent.js) | "live" | "small" (rendered box
//              width * height < 200x112, on-screen or not), first match in that
//              order. score: area * min(duration, 3 h), 0 when excluded or
//              duration is null, x 0.1 for a muted, looping, controls-less
//              object-fit: cover video, x 4 for the frame's last played video.
//              currentSrc: only if http(s), max 8192 chars,
//              else omitted. videoId: digits only (1-25), Facebook's
//              data-video-id of the video's container, else omitted. width,
//              height (optional): the video's intrinsic size, integers
//              1...100000, kept only as a pair (labels in `view`). blob, drm
//              (optional, true or omitted): currentSrc is a blob: URL (MSE; the
//              Player introspection below runs only for such a video) / the
//              video has mediaKeys (EME attached). At most 20
//              videos (the top scores when a frame has more). Agents re-send
//              only when a field the hub uses changes (the score in coarse
//              buckets, so scrolling rarely re-sends), and
//              send [] on pagehide (a removed iframe takes its videos with it).
//              -> {ok}. The hub re-runs the auto-pick (below). From an ignored
//              tab (Ignored sites) the list counts as [].
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
//   cancelStart [selected] (the overlay's Cancel, which replaces Mark start
//              while a start is pending): clears pendingStart (no-op when none)
//              and sends state to "all" -> {ok, state}.
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
//              if none) only in the selected video's frame. ui: {fullClipButton,
//              playerButton, fullDownloadButton, ignored}: the app's switches from
//              storage.local `ui` and whether this tab is ignored (Ignored sites;
//              the domain list never leaves the hub) (every switch true and ignored false when
//              nothing is stored; then it also pings the app,
//              not awaited, so the pong's `ui` broadcast follows once the app
//              is reachable; onInstalled pings too). Agents send it once at load
//              (and after a back/forward cache restore) for state.panelOpen and
//              ui (a frame that loads after the overlay opened missed the
//              `state` broadcast).
//   openOverlay {videoKey} any frame, NOT [selected] (the player button):
//              frameId is always the sender's, never the body's. An ignored tab
//              (Ignored sites) -> {ok: false, error: "ignored"}. videoKey must
//              be one of that frame's candidates with excluded null (else {ok:
//              false, error: "no-video"}). Selects it like `select` (selectedBy
//              "user"; its errors pass through), opens the panel like
//              setPanelOpen {open: true} (state to "all"), then sends
//              toggleOverlay {open: true} to that frame. -> {ok, state}.
//   fullOptions {videoKey, probe?: boolean} any frame, NOT [selected] (the
//              Download full button): the target is checked like openOverlay
//              (frameId from the sender; "ignored", "no-video"), but it is never
//              selected and no stored choice or overlay state changes. -> {ok,
//              kind: "variants" | "heights" | "none", items: [string],
//              defaultIndex, pending}, at once from the probe cache (never
//              waiting for a probe; the button asks again while pending).
//              Without probe, the protocol comes from the last pong only (no
//              native call); probe: true asks the app first (deps; a failing app
//              counts as protocol 1). The source is the one Send the job would
//              take for that video (target-aware correlation; the selected video
//              is "own"). variants: the HLS Quality rule of `view` wins (more than
//              one variant; items from the same labels, "WxH · N.N Mbps" or "N.N
//              Mbps"); else heights when the job runs yt-dlp (Page resolution
//              picker; more than one height; items "Best", then "<h>p", so index 0
//              = Best). defaultIndex: what the overlay would take: for the own
//              video the stored choice, else (and for any other video) the
//              preferred one. Labels are built from numbers only. pending:
//              variants or heights with no cached record yet (items [],
//              defaultIndex 0); kind "none" with pending true: no pong is known
//              yet and the HLS rule did not answer (no hls source, or its cached
//              playlist has at most one variant). kind "none" with
//              pending false means no list is possible: no source, a probe error
//              record, an empty or one-entry list, protocol < 3 for a page, a
//              direct file without page first, Browser mode (answered right
//              after the target check, no native call) and Another-app mode
//              (settings.downloadWith "otherApp" in the pong used, protocol >=
//              OPEN_WITH_PROTOCOL): both take the whole file. Only probe: true starts a probe,
//              with no panelOpen gate, when the record is missing or stale: for
//              the own video's HLS source the probe run, as `view`; for a page
//              (any video) or another video's playlist one probe of that one URL
//              (no run, no "maybe" captures, no sourceChanged), one at a time per
//              tab and URL.
//   downloadFull {videoKey, kind?: "heights" | "variants", index?} any frame,
//              NOT [selected] (the Download full button's click): kind and index
//              come together or not at all (else bad-message); every other field
//              is ignored, so the body never carries a URL, a duration or a
//              height. The target is checked like fullOptions ("ignored",
//              "no-video") and is never selected; no stored choice, segment,
//              pendingStart or overlay state changes. With kind: the app is asked
//              (deps; failing -> the app-unreachable / app-error replies of
//              download) and the list fullOptions would answer now must have
//              the same kind and more than index items, else {ok: false, error:
//              "options-changed"}. Then it runs `download` {full: true} for that
//              video (no mode or incognito from the body: settings.mode, the
//              tab's incognito), with its source, duration and page URL from the
//              target-aware correlation: same checks and replies ({ok, jobId} |
//              {ok: false, error: "app-unreachable" | "app-error" |
//              "app-outdated" | "no-source" | "no-duration" | "over-limit",
//              message?}), same jobs:<tabId> / jobt entries, no segs:<tabId>.
//              The pick applies to this one job: variants index -> that variant,
//              as chooseVariant would (a non-default one pins the media, no page
//              first); heights index -> maxHeight (0 = Best, omitted; i > 0 ->
//              the height of items[i]). Without a pick: the own video takes the stored
//              choices, as `download`; another video the defaults (preferred
//              variant, settings.preferredHeight unless a variant was chosen).
//              settings.fullClipConfirm is not applied (the button never asks).
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
//   Ignored sites. A tab is ignored when the host of top:<tabId> (webNavigation,
//   never a content script) equals a domain of storage.local `ui`.ignoredDomains
//   or is a subdomain of one (no top URL -> not ignored); its frames follow the
//   top page. Content scripts only get the per-tab `ignored` in `ui` (getState,
//   the `ui` broadcast), never the list. Gates: candidates, openOverlay and the
//   Overlay toggle (below).
//   ignoreSite {} [selected] (the overlay's "Ignore this site") ->
//              setSiteIgnored(tabId, true): the host of top:<tabId> (none ->
//              {ok: false, error: "no-site"}), then the app's pong (deps; failing
//              -> the app-unreachable / app-error replies of Send the job; protocol
//              < 4 -> {ok: false, error: "app-outdated", message: "Update the
//              SegDown app to turn sites off from the browser"}), then the native
//              setIgnored (deps, below) -> {ok, ignored}. The Toolbar menu (below)
//              uses the same setter, also with ignored false.
//
//   Source correlation (4.1). Content scripts only ever get a source summary
//   {kind: "hls" | "dash" | "mp4" | "file" | "page", host, file (last path component, no query),
//   frameId, via: "currentSrc" | "player" | "capture" | "page" | "user"}, never
//   the URL's query or header values; a playlist source (step 3) gives {kind:
//   "hls", host: its baseURL's host, file: "inline playlist"}, never its text.
//   One exception: `refetch` (Send the job) sends a captured playlist URL to the
//   frame that requested it (the capture's frameId), which already knows it; the
//   reply is untrusted text, checked like a player manifest (isPlaylistText).
//   A second exception: `copyText` (Browser mode) sends the resolved URL and its
//   Referer / User-Agent / Origin (never Cookie) to the selected video's frame,
//   only on a click there and only in Browser mode, so the overlay can write the
//   clipboard (the worker has none; an offscreen document would need two more
//   permissions).
//   The full Source (URL + captured headers) stays in this worker:
//   resolveSource(tabId) builds it for the job (4.3).
//   getSource [selected] -> {ok, source: summary | null} (null: nothing
//              captured and no http(s) top URL). For an hls source the summary
//              adds the 4.2 variant fields (below). Also starts the probe when
//              one is due and the overlay is open.
//   chooseSource {index} [selected]: index into the source list: the tab's hls,
//              dash, mp4 and file captures (cap:<tabId>; dash and file only when
//              the last pong's protocol >= DASH_PROTOCOL, since an older app fails
//              to decode the whole enqueue) sorted by frameId, then URL (a
//              re-fetch moves an entry to the end of cap:<tabId>, so that order
//              is not used). -> {ok, source: summary}, or {ok: false, error:
//              "unknown-source"} when out of range. The choice (src:<tabId>)
//              overrides the auto order until the selected video or the page
//              changes. The order below reads the same gated captures.
//   A media request of a page's service worker (tabId -1) counts as a frame-0
//   capture of the one tab on the worker's origin (several such tabs: the one
//   whose URL is the request's Referer; none or still several: not captured).
//   Never its chunks. A capture made before a same-document page change is stale
//   (staleAt) until it is captured again, or until its frame's chunks from the
//   capture's directory arrive more than STALE_GRACE_MS after the change; only
//   steps 4 and 5 skip stale captures (an exact URL in 1-3 names the stream).
//   Order (first match wins; `selected` is hub:<tabId>.selected):
//     1. the user's choice (via "user");
//     2. the selected candidate's currentSrc (http(s) only, via "currentSrc"):
//        kind and headers from the capture with the same URL or pre-redirect
//        alias, else kind from the path (.m3u8 -> hls; .webm / .mkv / .ogv ->
//        file when protocol >= DASH_PROTOCOL; otherwise mp4) and no headers;
//     3. the selected video's player probe (Player introspection; intro:<tabId>
//        for that {frameId, videoKey}, used only while its candidate has blob:
//        true, so never with an http currentSrc; via "player"): its manifest,
//        when the last pong's protocol >= PLAYLIST_PROTOCOL, as {type:
//        "playlist", text, baseURL, headers} (baseURL and headers from the
//        record); else its url of kind hls or mp4 (or dash when protocol >=
//        DASH_PROTOCOL): the capture with the same URL or alias (its headers),
//        else {type: "media", url, kind, headers: Referer "<origin of the
//        video's frame>/" and Origin, through the header allowlist} (none when
//        that frame's URL is unknown). A url of kind dash for an older app or of
//        no kind goes on to step 4;
//     4. in the selected video's frame (live captures only), the newest hls capture with isMaster,
//        then the newest hls capture (isMaster is unknown until a probe), then
//        the newest dash, then the newest mp4, then the newest file (via
//        "capture");
//     5. tab-wide (live captures only), when that frame has nothing (or nothing is selected): frames
//        with active chunks (act:<tabId>) first, then hls, then dash, before mp4
//        and file, then a probed master (4.2), then the newest (via "capture", with the
//        capture's own frameId; chooseSource picks another one);
//     6. the page URL for yt-dlp (via "page"): from top:<tabId>; for a selected
//        video in a subframe, that frame's URL from
//        chrome.webNavigation.getFrame (never from a content script) when it is
//        http(s), at most MAX_URL_LENGTH chars and not the top URL (an embed's
//        own page); else, for a Facebook top URL and a selected frame-0
//        candidate with videoId, https://<top host>/watch/?v=<videoId>. A page
//        source {type: "page", url} has no headers (yt-dlp fetches the page
//        itself), no HLS probe and no variants (its heights: Page resolution
//        picker). Every page rule (page-first, heights, DRM) uses this URL.
//   A playlist source has no HLS probe and no variants.
//
//   HLS variant picker (4.2). Only this worker talks to the app:
//   chrome.runtime.sendNativeMessage(NATIVE_HOST, {type: "probe", source:
//   {type: "media", url, kind: "hls", headers}}) -> {type: "variants", variants:
//   [{url, bandwidth, resolution?: {width, height} | null, audioGroup?}]} ([] for
//   a media playlist) or {type: "error", code, message}. getSource and
//   chooseSource start a probe run while the overlay is open (one per tab at a
//   time, in the background; fullOptions {probe: true} also does, see there):
//   it probes the resolved hls source when its URL has no cached result (a
//   failure is retried after PROBE_RETRY_MS, a success is kept until the tab is
//   cleared). When that source came from the capture order and is a media
//   playlist (players fetch the variant playlists after the master), it then
//   probes the same frame's other hls (and "maybe") captures with unknown
//   isMaster, oldest first, until one is a master; at most MAX_PROBES_PER_RUN
//   probes, stopping at the first failure other than "invalid" (that URL is not
//   a playlist). Each result sets isMaster on the captures with that URL
//   (variants non-empty), so the order above prefers the master. Before those,
//   while the resolved source is not an hls capture of the selected video's frame, a run
//   probes the selected video's frame's "maybe" captures (tab-wide when nothing
//   is selected), oldest first: one that parses becomes an hls capture, one the
//   app answers "invalid" (not a playlist) is dropped and the next is tried (such
//   drops do not count toward MAX_PROBES_PER_RUN; at most MAX_ENTRIES_PER_FRAME
//   per run), and a refetch of a dropped one is not captured again. A run that
//   stored the resolved source's result or a new playlist sends `sourceChanged`
//   to the selected video's frame. An "unavailable" maybe also lets the run go on
//   (it counts toward MAX_PROBES_PER_RUN). A maybe probe makes the app GET that
//   URL again with the captured headers (once: a non-playlist is not re-captured).
//   Known limit: a disguised playlist fetched after its frame already holds
//   MAX_ENTRIES_PER_FRAME unprobed maybes is evicted by the next one.
//   Summary fields for an hls source (numbers only, never variant URLs):
//     probe {state: "pending"} (not probed yet) | {state: "error", message}
//       (message: "SegDown app not reachable: install browser integration" when
//       the native call fails, else the app's message);
//     variants [{width, height (null when the playlist has no RESOLUTION),
//       bandwidth}], highest bandwidth first (ties: playlist order, so index 0
//       is the variant the app picks by default), and variant: the index the job
//       takes: the user's choice, else the preferred one (settings.preferredHeight:
//       the tallest variant with a height <= it, else the shortest; variants
//       without a height are skipped), else 0.
//   chooseVariant {index} [selected]: index into the current source's variants.
//              -> {ok, source: summary}, or {ok: false, error: "unknown-variant"}
//              when out of range. Index 0 is a choice too (it overrides the
//              preferred one). The choice (var:<tabId>) holds for that source and
//              selected video until either changes or the page changes.
//   resolveSource adds variantURL only when that index is not 0: without it the
//   app fetches the master itself and also takes the variant's separate audio
//   rendition; with it the app uses that playlist and takes its audio rendition
//   from the master. audioURL is never set.
//
//   Page resolution picker. Only when the pong's protocol >= 3 (an older app
//   answers a page probe with variants [] and ignores maxHeight) and the job
//   runs yt-dlp (Send the job: a page source, or page first), and while the
//   HLS Quality section (below) does not show: `view` asks the app, while the
//   overlay is open (one run per tab at a time, in the background; fullOptions
//   {probe: true} also does, see there),
//   chrome.runtime.sendNativeMessage(NATIVE_HOST, {type: "probe",
//   source: {type: "page", url: the job's page URL}}) -> {type: "formats",
//   heights: [integer]} (tallest first, [] when yt-dlp is missing or cannot
//   read the page; takes seconds) or {type: "error", code, message}. The hub
//   keeps integers 1...8640, deduped, tallest first, at most MAX_HEIGHTS. A
//   formats reply ([] included) is cached for that page URL until the tab is
//   cleared, a failure is retried after PROBE_RETRY_MS; a stored result sends
//   `sourceChanged` to the selected video's frame. When the HLS Quality section
//   does not show (an hls source with more than one variant, or its probe
//   pending or failed), `view`'s source adds (numbers only, never URLs):
//     heightProbe {state: "pending"} (not probed yet), else heights [integer]
//       (the cached list, [] after a failure) and height: the chosen index, 0 =
//       Best (no maxHeight), i = heights[i - 1]; without a choice, the preferred
//       one (settings.preferredHeight: the tallest height <= it, else the
//       shortest), else 0.
//   chooseHeight {index} [selected]: 0 picks Best (it overrides the preferred
//              height), i in 1...heights.length picks heights[i - 1]. -> {ok}, or {ok: false,
//              error: "unknown-height"} when out of range or the job would not
//              run yt-dlp. The choice (res:<tabId>) holds for that page URL and
//              selected video, while the height is in the cached list, until
//              either changes or the page changes.
//
//   Player introspection. A video whose currentSrc is blob: (MSE; the agent's
//   `blob` flag) plays a stream the captures can only guess, so on demand the hub
//   asks the page's player library which stream the video plays. When: a `select`
//   (after the selection is written) and setPanelOpen / the toggle opening the
//   panel (both fire-and-forget; a result less than INTRO_TTL_MS old for the same
//   video is reused), fullOptions {probe: true} (not awaited: the reply never
//   waits), and every `download` (awaited, always a new probe; downloadFull goes
//   through it, so one probe per click). Never from candidates, scans or timers,
//   and only for a target candidate with blob: true. One run per tab at a time.
//   How: the hub asks the video's agent to `tag` it with a random
//   data-segdown-<16 hex> attribute, runs playerProbe in that frame only through
//   chrome.scripting.executeScript({world: "MAIN"}) (a static function of this
//   file, raced against INTRO_TIMEOUT_MS), then `untag`s it. The probe duck-types
//   hls.js, Shaka, dash.js, video.js and JW Player objects reachable from
//   window's own keys (values only, no getters), keeps only the player whose
//   media element carries the attribute, and reads a blob: playlist of the
//   page's own origin (at most MAX_INLINE_PLAYLIST_BYTES). A browser without
//   MAIN world (the error names `world`) turns the probe off for the worker's
//   lifetime; any failure just leaves the captures to Source correlation.
//   What is trusted: the result is page data, checked by cleanIntro (url: http(s)
//   only, never blob:; kind from its type or path; drm boolean; manifest: within
//   the cap, no NUL, "#EXTM3U" after an optional BOM). frameId and videoKey come
//   from the hub, never from the page. The manifest's baseURL and headers never
//   come from the page either: the frame's last chunk request (act:<tabId>,
//   lastChunkUrl + its headers), else the frame's newest capture (its own URL and
//   headers), else the frame's URL from webNavigation.getFrame with Referer
//   "<origin>/" and Origin "<origin>" (through the header allowlist); with none
//   of them the manifest is dropped. What is stored: every run replaces
//   intro:<tabId> (Storage below; a run that found nothing or failed removes
//   it) and keeps the manifest text in worker memory only (at most
//   MAX_INTRO_MANIFESTS tabs; a worker restart loses it and the next call probes
//   again). A run whose tab was cleared or changed page meanwhile writes
//   nothing. A run that wrote or removed the selected video's record sends
//   `sourceChanged` to its frame.
//
//   deps [selected] -> {ok, missing: [tool], appError?}: the tools the app
//              reports missing, each one of "yt-dlp" | "ffmpeg" | "ffprobe" |
//              "deno" (others dropped). The hub asks the app
//              chrome.runtime.sendNativeMessage(NATIVE_HOST, {type: "ping"}) ->
//              {type: "pong", version, missing: [string], protocol?, settings?:
//              {mode, incognitoDefault, maxDuration?, fullClipButton?,
//              fullClipConfirm?, playerButton?, fullDownloadButton?,
//              ignoredDomains?, preferredHeight?, downloadWith?,
//              downloadWithRev?, otherAppName?}}, at most once
//              per DEPS_TTL_MS (10 s; one cached
//              answer for every tab, also for the settings; concurrent callers
//              share one request). protocol: an integer >= 1, absent -> 1 (2:
//              incognito and fallback, 3: maxHeight and the page probe, 4:
//              setIgnored, 5: the playlist source, 6: the dash and file media
//              kinds, 7: openWith).
//              settings are checked field by field: mode "separate" | "merged"
//              (else "separate"), incognitoDefault (true only when true, so an
//              app without settings gives false), maxDuration (seconds, finite >
//              0, else no limit), fullClipButton, fullClipConfirm,
//              playerButton and fullDownloadButton (false only when false, so
//              absent -> true), ignoredDomains (lowercased
//              hostnames as the app's IgnoredDomain.normalize makes them, others
//              dropped, deduped, at most MAX_IGNORED_DOMAINS; not an array -> []),
//              preferredHeight (an integer 1...8640, else null = Best),
//              downloadWith "segdown" | "browser" | "otherApp" (else
//              "segdown"), downloadWithRev (a safe integer >= 0, the app's
//              count of downloadWith changes, else 0), otherAppName (the
//              chosen app's name: a string, control characters removed, at
//              most MAX_APP_NAME code points, else null). Every
//              pong sets the persistence gate to settings.incognitoDefault
//              (Segment persistence) and keeps storage.local `ui` equal to the
//              two switches and ignoredDomains, plus browserOnly / appRev
//              (Browser mode; written, and sent as `ui` to
//              "all" in every tab (below), only when they differ from the stored
//              value). A ping without a pong leaves `ui` as it is (never pinged:
//              both true, no ignored domains). Any other reply or a failed call
//              -> missing [] and appError (APP_UNREACHABLE when the call fails),
//              cached the same way. appError blocks nothing here; Download
//              pings again when the cached answer is a failure and refuses
//              while the app still does not answer (below).
//              setIgnored (Ignored sites; protocol >= 4):
//              chrome.runtime.sendNativeMessage(NATIVE_HOST, {type: "setIgnored",
//              host: the raw hostname of top:<tabId> (never a body), ignored}) ->
//                a pong (as above; the app added the host's site without a
//                  leading "www." when the rest has a dot, or removed every
//                  domain covering the host; already covered is no change) ->
//                  handled like a ping's pong, cached in its place, and `ui` is
//                  updated before the reply;
//                {type: "error", code, message} (e.g. "The Ignored sites list
//                  is full.") -> {ok: false, error: "app-error", code, message}
//                  (message capped at MAX_MESSAGE_CHARS), the cache unchanged;
//                the native call fails -> {ok: false, error: "app-unreachable",
//                  message: APP_UNREACHABLE}; any other reply -> app-error
//                  "internal".
//              It waits for a ping in flight, then is the shared request itself
//              (fetchDeps callers whose cache is stale wait for it; a fresh
//              cache answers first, as always), so an older pong never lands
//              after it.
//
//   Send the job (4.3).
//   download {mode?: "separate" | "merged", incognito?: boolean, full?: boolean}
//              [selected]: the overlay's Download button (full: true for its
//              Full clip button). Every other field is ignored. The hub builds
//              the rest from its own state: segments from segs:<tabId> (not
//              read for full); then the app's pong (deps; still failing -> the
//              app-unreachable / app-error replies below); then Another app
//              (below); then [] segments -> {ok: false, error: "no-segments"};
//              the effective incognito = the tab is
//              incognito (Incognito) || body incognito (the body can turn it
//              on, never off), refused with {ok: false, error: "app-outdated",
//              message: "Update the SegDown app to download incognito"} when the
//              pong's protocol < 2; the source from resolveSource(tabId) (with
//              captured headers and the chooseSource / chooseVariant choices;
//              null -> {ok: false, error: "no-source"}): when it is media or a
//              playlist (Source correlation step 3), the user pinned neither the
//              source (chooseSource) nor a non-default variant (chooseVariant),
//              protocol >= 2 and there is a page URL (Source correlation step
//              6), the job gets source = {type: "page", url: page URL} and
//              fallback = that media or playlist (the app tries yt-dlp first);
//              otherwise source = the resolved source and no fallback. A
//              playlist source {type: "playlist", text, baseURL, headers} is
//              playlist text the app must not fetch again (protocol >=
//              PLAYLIST_PROTOCOL only). A media source's kind is "hls" | "mp4" |
//              "dash" (an MPD manifest) | "file" (a progressive file other than
//              mp4/mov, e.g. WebM); dash and file only when protocol >=
//              DASH_PROTOCOL (Source correlation).
//              DRM, checked before anything goes to the app and skipped when the
//              user pinned the source as above: the player probe's drm flag
//              (Shaka drmInfo(), JW Player item.drm) -> {ok: false, error:
//              "drm"}; else the candidate's drm (bare mediaKeys, which has false
//              positives): a page-first job is sent without its fallback (yt-dlp
//              still tries, captured encrypted media is never downloaded), a job
//              without a page attempt -> {ok: false, error: "drm"}.
//              Page re-fetch, after DRM (and the full clip's checks), at most once
//              per click: when the hls media the job would send (the fallback of
//              a page-first job, else the source) has a probe record (4.2) with
//              error code "unavailable" (the app fetched that URL with the
//              captured headers and was refused; the host also answers it while
//              the app is not running, which costs one extra GET), protocol >=
//              PLAYLIST_PROTOCOL, and cap:<tabId> holds an hls capture with that
//              exact URL that a page's service worker did not make (else the job
//              goes unchanged), the hub asks that capture's frame `refetch` (Hub
//              -> content) with credentials "include" when the capture has a
//              Cookie or its URL has the frame's origin (webNavigation), else
//              "same-origin" (hls.js's default), the capture's Referer as
//              referrer, maxBytes MAX_INLINE_PLAYLIST_BYTES, and waits
//              REFETCH_TIMEOUT_MS + 1 s. A reply {ok: true, text} whose text
//              passes isPlaylistText replaces that slot with {type: "playlist",
//              text, baseURL: the capture's URL (its final URL after redirects),
//              headers: its allowlisted headers}; a page-first job keeps its page
//              source. Anything else sends the job unchanged (the app then
//              reports the expired link). The download log line adds refetch=ok
//              or refetch=fail when the frame was asked. While the frame is asked,
//              refetching holds "<tabId> <frameId> <url>" (expiry now +
//              REFETCH_TIMEOUT_MS + 1 s, pruned on each set, deleted once
//              answered): a request with that key (onHeadersReceived), or whose
//              pending entry got refetch: true at onSendHeaders (redirect hops
//              keep it), is not captured and bumps no act:<tabId>. No marker
//              header is added. A browser that reports the fetch with another
//              tab or frame id captures it again, which only replaces the same
//              cap: entry (addEntry dedupes by URL; a playlist is never a chunk).
//              mediaDuration: the selected candidate's duration when finite > 0,
//              else omitted. pageURL: the page URL of Source correlation step 6
//              (the Facebook watch URL included) when it is http(s), else omitted
//              (the window's card opens it; older apps ignore it); when that is a
//              subframe's URL, the top URL instead (the page the user watched;
//              omitted when it is not http(s)).
//              maxHeight: protocol >= 3 and a page source only (never for the
//              fallback): the chooseHeight choice that still applies to the
//              job's page URL (omitted for Best); without one,
//              settings.preferredHeight unless the user chose an HLS variant
//              (yt-dlp takes the tallest format up to it); else omitted (Best).
//              The fallback's variantURL follows the preferred variant too.
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
//              sanitizes it again). Then (tidyTitle, each step only when text is
//              left): a leading "(N) " / "(N+) " counter and a leading "▶" / "►"
//              are dropped, and one trailing " - Site" (also "–", "—", "|") when
//              Site, lowercased without spaces, dots and hyphens, is the site
//              label of top:<tabId>'s host (its second-to-last label, the only
//              one for a one-label host such as localhost) or its last two
//              labels joined (no such rule for an IP host). precision is always "precise" (required on
//              the wire; the app replaces it with its own setting). Apart from
//              a full clip's over-limit, the hub refuses neither a missing tool
//              nor a total over maxDuration (the overlay disables Download and
//              Full clip from `view`; the app checks both).
//              Then:
//              chrome.runtime.sendNativeMessage(NATIVE_HOST, {type: "enqueue", job:
//              {source, title, segments: [{start, end}] (never done), mode,
//              precision, fallback?, mediaDuration?, pageURL?, maxHeight?,
//              incognito?: true}}) ->
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
//              Browser mode (ui.browserOnly), checked first (no segments read,
//              no native call; downloadFull goes through it): the whole file,
//              saved by the browser. After the player probe Download makes, the
//              source from resolveSource (no page first; dash and file captures
//              kept); only a direct media source (directMedia: via
//              "currentSrc" or "user", or kind hls / dash; an mp4 / file from
//              the capture tiers or the player probe is one MSE track) of kind
//              mp4 or file is saved: null -> "no-source", a playlist ->
//              "inline-only", any other -> "copy-only"; a private-window tab ->
//              "private-window" (Chrome's spanning worker would save it in the
//              normal profile). No chrome.downloads (Safari) ->
//              chrome.tabs.create({url}) -> {ok, saved: "tab"}. Else
//              chrome.downloads.download({url, filename: saveName ("SegDown/"
//              + the tidied title with / \ : * ? " < > | and control
//              characters as spaces, at most 120 code points, "video" when
//              empty, + the URL's extension among SAVE_EXTS, else ".mp4" for
//              mp4; none for a file of another extension), saveAs: false,
//              conflictAction: "uniquify"}), once more without filename when
//              refused -> {ok, saved: "browser"} (started; a later HTTP error
//              shows in the browser's list) or {ok: false, error:
//              "browser-download"}. No headers option (the browser refuses
//              Referer, Origin, Cookie and User-Agent there; it sends its own
//              cookies). Segments, mode, incognito, maxDuration, jobs:<tabId>,
//              jobt and status do not apply.
//              Another app (the pong's settings.downloadWith "otherApp" and
//              protocol >= OPEN_WITH_PROTOCOL), right after the pong check and
//              before no-segments: the whole video's link goes to the app,
//              which opens it in the app the user chose. After the player
//              probe, resolveSource: null -> "no-source", a playlist ->
//              "inline-only", a private-window tab -> "private-window"; else
//              sendNativeMessage(NATIVE_HOST, {type: "openWith", url: the
//              media URL when directMedia, else the page URL (Source
//              correlation step 6), else the media URL}) (only the URL: never
//              headers or Cookie; an HLS master as is, no variant pick) ->
//                {type: "opened", app} -> {ok, opened: app (cleaned like
//                  otherAppName)};
//                {type: "error", code, message} -> {ok: false, error:
//                  "app-error", code, message} (e.g. no app chosen, a bad URL);
//                the native call fails -> {ok: false, error: "app-unreachable",
//                  message: APP_UNREACHABLE}; any other reply -> app-error
//                  "internal".
//              No jobs:<tabId> or jobt entry. Log lines: download tab=…
//              with=browser|otherApp kind=<kind> saved=<…> | opened |
//              error=<code> (never the URL).
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
//              its media fallback), warning (string | null, what a done job
//              left out, e.g. its empty segments)}. title: the stored one, else "Job " + the
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
//   the port. enqueue, cancel, probe, ping, setIgnored and openWith always use
//   sendNativeMessage. Jobs run in the app: closing the port never affects them.
//   Safari never opens the port: every status there is its own
//   sendNativeMessage (a short appex call).
//
//   Overlay view (5.2).
//   view [selected] -> everything the overlay draws, summaries only (no URLs,
//              headers or captures): {ok,
//                segments (segs:<tabId>), pendingStart (number | null),
//                duration (the selected video's, null when unknown or live),
//                source (getSource's summary of the resolved source, or null;
//                  hls variants also carry label "WxH · N.N Mbps"; heights,
//                  height and heightProbe: Page resolution picker),
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
//                fullClipConfirm (settings.fullClipConfirm: Full clip asks
//                  before it downloads; true without settings),
//                overLimit (the segments' total duration > settings.maxDuration),
//                maxDuration (seconds, or null = no limit; always present),
//                depsProblem (only when Download must be disabled: ffmpeg
//                  missing, or yt-dlp missing for a page source without a
//                  fallback; deno never blocks),
//                appError (the ping failed),
//                job (this tab's newest job from `jobs`: {id, state,
//                  segmentIndex, segmentCount, fraction, bytes, message,
//                  fallbackUsed, warning}, or null),
//                downloadWith ("segdown" | "otherApp" from the pong, the app's
//                  "browser" counting as "segdown" outside Browser mode; then
//                  depsProblem is left out for "otherApp", which needs no
//                  tool) and otherApp (settings.otherAppName in Another-app
//                  mode, else null)}.
//              In Browser mode (also when the view's own ping just turned it
//              on): no ping, no status, no probe; source is the resolved
//              source's summary (no page first, no variants or heights),
//              pageFirst false, job null, no depsProblem or appError, the
//              settings fields from the defaults, and downloadWith "browser",
//              saveable (Download can save it: directMedia and kind mp4 or
//              file), copy (the copyText kinds for the source: ["link",
//              "ytdlp", "ffmpeg"] for direct media that is not dash, else
//              ["link", "ytdlp"]; [] for a playlist or no source) and
//              inlineOnly: true for a playlist.
//              Uses the deps cache and, when the tab has jobs or else when jobt
//              holds an entry with page.key = page:<tabId>.key and no applied,
//              one status request (a failure is ignored), made before segments
//              are read so they carry its Downloaded segments flags; starts a
//              probe run like getSource, and the page probe.
//
//   Browser mode. While storage.local ui.browserOnly is true no native message is
//   sent and no native port is opened (the host launches the app for any message):
//   one sendNative wrapper (a backstop) plus early returns: deps answers
//   {missing: [], appError: BROWSER_ONLY} without pinging or touching the cache,
//   probes do not run, status answers an error and clears the running badge,
//   ignoreSite answers app-error and the Toolbar menu hides both items. Download is
//   the browser's (Send the job), fullOptions answers kind "none". An unreachable
//   app never switches the mode; only the menu below or an app-side change does
//   (the `ui` storage line). Segments stay in storage.session while no pong of this
//   worker's life allowed persistence.
//   setDownloadWith {browser: boolean} [selected] (the overlay's "Download with"
//              menu) -> {ok}: writes ui {...stored, browserOnly: browser, appRev:
//              "sync"}; leaving Browser mode also drops the cached pong (the
//              next `view` pings). Never calls the app, never writes back to it.
//   copyText {what: "link" | "ytdlp" | "ffmpeg"} [selected], Browser mode only
//              (else bad-message) -> {ok, text} | {ok: false, error: "no-source"
//              | "inline-only" (a playlist) | "copy-only" | "bad-url" |
//              "bad-message" (ffmpeg for a dash or page source)}. After the
//              player probe, the selected video's resolved source: link: its
//              URL; ytdlp: "yt-dlp [--referer R] [--user-agent U] [--add-header
//              'Origin:O'] URL" with the page URL when the media is not direct;
//              ffmpeg (direct media only, else copy-only): "ffmpeg [-user_agent
//              U] [-referer R] [-headers 'Origin: O'] -i URL -c copy
//              './<base><ext>'" (base as saveName's; .mp4 for hls and mp4, a
//              file's own extension among SAVE_EXTS, else .mkv). Headers only
//              from the source's Referer / User-Agent / Origin, never Cookie (the
//              clipboard is readable by every app); every value POSIX
//              single-quoted ('\'' for a quote); a URL or value with a C0
//              control character or DEL -> "bad-url". Log: copy tab=… what=…
//              kind=… (never the text).
//
// Hub -> content: chrome.tabs.sendMessage(tabId, msg, {frameId}). agent.js and
// the overlay share each frame, so every message names its receiver in `to`;
// each listener ignores the others.
//   to "agent" (the video's frame):
//     seek {videoKey, time} | play {videoKey} | pause {videoKey} -> {ok}
//     getTime {videoKey} -> {ok, currentTime, duration (null if unknown), paused}
//     select {videoKey | null}: the frame's selected video (null: none there)
//     tag {videoKey, attr}: attr matches ^data-segdown-[0-9a-f]{16}$; sets attr="1"
//       on that tracked, connected video, removed by untag or after 5 s -> {ok}
//       ({ok: false} for an unknown video or a bad name). Player introspection only.
//     untag {attr}: same name check; removes attr from the video tagged with it -> {ok}
//     refetch {url, credentials, referrer?, maxBytes} -> {ok, text} | {ok: false,
//       error}: url http(s), at most 8192 chars; credentials "include" |
//       "same-origin"; maxBytes an integer 1...1 MiB (else error "bad-message");
//       referrer only when it is an http(s) URL of the frame's own origin (else
//       the frame's URL). One fetch from the isolated world {cache: "force-cache",
//       redirect: "error"}, aborted after 5 s; error "http" (not 2xx), "too-big"
//       (over maxBytes), "failed" (CORS, abort, redirect, not UTF-8). Answered
//       asynchronously; never carries the URL, status text or headers. Send the
//       job (page re-fetch) only.
//   to "overlay" (the selected video's frame):
//     segments {segments: [{start, end, done?}]}: after every change of segs:<tabId>
//     mark {action, time, frameId, videoKey, start?, end?} | markError {action, error}
//     toggleOverlay {open}: the toggle below or `openOverlay`; open = the new
//     panelOpen.
//     sourceChanged {}: a probe run or a player probe stored results; the overlay
//     asks `view` again.
//   to "all" (every frame, no frameId option):
//     state {state} after the selection, selectedBy or pendingStart changes.
//     Also sent after panelOpen changes: agents listen for `[` / `]` only while
//     the overlay is open.
//     ui {ui: {fullClipButton, playerButton, fullDownloadButton, ignored}} to every tab
//     (chrome.tabs.query; ignored: that tab's, Ignored sites) when a pong (ping
//     or setIgnored) changed the stored switches or ignored domains
//     (storage.local `ui`).
//
// Overlay toggle (3.5): the "toggle-panel" command and the toolbar button
// (chrome.action.onClicked; fires once the manifest has no default_popup, 5.4).
// On an ignored tab (Ignored sites) the hub first pings the app (deps; the pong's
// list may have dropped the domain); still ignored -> panelOpen is left as it is
// and the button shows an "off" badge for NO_VIDEO_BADGE_MS. Otherwise they
// flip panelOpen for that tab, send state to "all", then send toggleOverlay to
// the selected video's frame (a frame that gets the selection later reads
// state.panelOpen). With nothing selected, panelOpen stays false and the button
// shows a "none" badge for NO_VIDEO_BADGE_MS. The selection becoming null also
// sets panelOpen false. Top-frame navigation clears hub:<tabId>, so the overlay
// is closed again on the next page.
//
// Running badge: the toolbar button's global badge shows how many of the app's
// jobs are queued or running (red, white text), none at 0. Set from every status
// reply (overlay polls, and the poll below); a failed status clears it. While the
// count is above 0 the hub asks status again ACTIVE_POLL_MS after the last reply,
// and once after a Download is enqueued. A flash badge above is per tab and goes
// back to this one when it clears.
//
// Toolbar menu: only where chrome.contextMenus exists (feature-detected; a
// browser that refuses the "action" context simply has no menu). Two items on
// the toolbar button, created hidden on install / update / browser start:
// "site-off" "Turn off SegDown on <host without a leading www. when the rest has
// a dot>" when the active tab (last-focused window) has an http(s) top:<tabId>
// that is not ignored, "site-on" "Turn on SegDown on <the first listed domain
// covering the host>" when it is ignored, neither without a top URL. Refreshed
// on tab activation, window focus, a top-frame commit or same-document URL change
// (after top:<tabId>), a `ui` change and a setIgnored success. A click ->
// setSiteIgnored(tab, item is "site-off") (Ignored sites); the badge shows "off"
// / "on" on success, "!" on any failure, for NO_VIDEO_BADGE_MS.
//
// Same-document URL changes (webNavigation.onHistoryStateUpdated, the active top
// frame) update top:<tabId>. When the URL, without its hash, differs from the key in
// page:<tabId>, the hub also clears pendingStart and the source, variant and
// height choices src:<tabId> / var:<tabId> / res:<tabId>, and the player probe's
// intro:<tabId> and manifest (a probe in flight writes nothing; captures stay but
// are marked `staleAt`; the capture tiers skip them until they are captured again or
// their frame's chunks keep arriving; probe results stay; the next video's
// requests add to them), loads the new page's
// segments (Segment persistence), relays them to the selected video's frame and
// sends `state` to "all". The selection stays until the agents report other
// videos.
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
//                    message}}, <page url>: {ts, heights: [integer]} | {ts, error}}
//                    (4.2 and page probe results, no headers; at most
//                    MAX_PROBE_CACHE URLs, oldest ts dropped)
//   var:<tabId>  -> {source, url, selected}   (chooseVariant: the master's URL, the
//                    chosen variant's URL, the selection; never sent to content scripts)
//   res:<tabId>  -> {page, height, selected}   (chooseHeight: the page URL, the chosen
//                    height (0 = Best), the selection; never sent to content scripts)
//   intro:<tabId> -> {frameId, videoKey, ts, url?, kind?, drm, hasManifest, baseURL,
//                    headers}   (the last player probe; Player introspection; never
//                    sent to content scripts)
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
//   ui           -> {fullClipButton, playerButton, fullDownloadButton, ignoredDomains,
//                    browserOnly, appRev}
//                    (the app's switches and ignored domains from the last pong,
//                    ping or setIgnored; absent -> every switch true, [];
//                    stored without ignoredDomains -> []; stored without
//                    fullDownloadButton -> true; content
//                    scripts get only the switches and a per-tab `ignored`, through
//                    getState and the `ui` broadcast, never browserOnly / appRev).
//                    browserOnly: Browser mode (absent -> false). appRev: the app's
//                    downloadWithRev from the last pong, null before any (absent),
//                    or "sync" after a setDownloadWith. The newest change wins, on
//                    the revision, never the value (A -> X -> A between two pongs
//                    is still seen), with no write-back to the app: a pong with
//                    appRev null turns browserOnly on only for "browser"; with
//                    "sync" it records the revision and leaves browserOnly (the
//                    menu pick is newer: Browser mode heard no pong); with another
//                    revision it sets browserOnly = (downloadWith == "browser").
//                    It always stores appRev = the revision. Known limit: an app
//                    change made after a menu pick and before the next pong is
//                    recorded, not applied. updateUI and setDownloadWith write
//                    the whole object in one queue (UI_KEY).
//   reload       -> "<own version>><app version>"   (the last version pair that
//                    reloaded this extension; see reloadIfOutdated)
// ---------------------------------------------------------------------------

const MAX_CANDIDATES_PER_FRAME = 20;
const MAX_URL_LENGTH = 8192;
const VIDEO_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MARK_ACTIONS = new Set(["markStart", "markEnd"]);
const EXCLUSIONS = new Set(["small", "ad", "live"]);
const MIN_MAIN_DURATION = 30; // seconds; shorter videos lose to a longer candidate
const MAX_SEGMENTS = 100; // SegDownCore Validation
const MAX_PAGES = 200; // seg:* entries kept in storage.local, most recent ts first
const ACTIVE_POLL_MS = 2 * 1000; // status poll while the running badge shows a count
const ACTIVE_BADGE_COLOR = "#E5484D"; // the running badge's red
const NO_VIDEO_BADGE_MS = 2000; // the toolbar's "none" / "off" badge after a toggle with nothing selected / an ignored tab; also the Toolbar menu's "off" / "on" / "!"
const MODES = new Set(["separate", "merged"]);
const FULL_KINDS = new Set(["heights", "variants"]); // downloadFull pick lists (fullOptions kinds)
const NATIVE_HOST = "com.math2it.segdown";
const APP_UNREACHABLE = "SegDown app not reachable: install browser integration";
const PROBE_RETRY_MS = 30 * 1000; // a failed probe of a URL is not repeated sooner
const MAX_PROBES_PER_RUN = 6;
const MAX_PROBE_CACHE = 50; // probed URLs kept per tab
const MAX_VARIANTS = 100; // variants kept per master
const MAX_HEIGHTS = 32; // heights kept per page probe
const MAX_HEIGHT = 8640; // Validation.maxHeightLimit
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
const UI_KEY = "ui"; // storage.local: the app's switches and ignored domains from the last pong
const MAX_IGNORED_DOMAINS = 200; // settings.ignoredDomains kept (the app's cap too)
const MAX_DOMAIN_LENGTH = 253; // IgnoredDomain.maxLength
// IgnoredDomain.normalize's hostname: labels of 1-63 [a-z0-9-], no "-" first or last.
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const RELOAD_KEY = "reload"; // storage.local: the version pair of the last self-reload
const DEPS_TTL_MS = 10 * 1000; // ping answers (missing tools, settings) are reused this long
const TOOLS = new Set(["yt-dlp", "ffmpeg", "ffprobe", "deno"]); // SegDownCore Tool raw values
const INCOGNITO_NEEDS_UPDATE = "Update the SegDown app to download incognito";
const IGNORE_NEEDS_UPDATE = "Update the SegDown app to turn sites off from the browser";
const MAX_VIDEO_SIDE = 100000; // candidate width/height in px
// Player introspection: the app's IPC.protocolVersion that added the `playlist` source.
const PLAYLIST_PROTOCOL = 5;
// The app's IPC.protocolVersion that added the `dash` and `file` media kinds.
const DASH_PROTOCOL = 6;
// The app's IPC.protocolVersion that added the `openWith` request (Another app).
const OPEN_WITH_PROTOCOL = 7;
const DOWNLOAD_WITH = new Set(["segdown", "browser", "otherApp"]); // ClientSettings.downloadWith
const BROWSER_ONLY = "Browser mode: SegDown downloads with the browser and does not use the SegDown app.";
const COPY_KINDS = new Set(["link", "ytdlp", "ffmpeg"]); // copyText
// Extensions a browser-saved file keeps (saveName); others get ".mp4" (kind mp4) or the browser's name.
const SAVE_EXTS = [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".3gp"];
const MAX_SAVE_BASE = 120; // code points of a saved file's base name
const MAX_APP_NAME = 100; // code points of settings.otherAppName and an `opened` app name
const INTRO_TTL_MS = 30 * 1000; // a probe result serves the panel this long (never a job)
const INTRO_TIMEOUT_MS = 3000; // executeScript of the MAIN-world probe
const MAX_INLINE_PLAYLIST_BYTES = 256 * 1024; // Validation.maxInlinePlaylistBytes
const MAX_INTRO_MANIFESTS = 8; // tabs whose probed manifest text stays in memory
const REFETCH_TIMEOUT_MS = 5000; // the agent's abort of a page re-fetch; the hub waits 1 s more

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
  for (const flag of ["blob", "drm"]) {
    if (v[flag] !== undefined && typeof v[flag] !== "boolean") return null;
    if (v[flag] === true) out[flag] = true;
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
  ["key", (m) => (MARK_ACTIONS.has(m.action) ? { action: m.action } : null)],
  ["removeSegment", (m) => (isIndex(m.index, MAX_SEGMENTS) ? { index: m.index } : null)],
  ["clearSegments", () => ({})],
  ["cancelStart", () => ({})],
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
  [
    "fullOptions",
    (m) =>
      isVideoKey(m.videoKey) && (m.probe === undefined || typeof m.probe === "boolean")
        ? { videoKey: m.videoKey, probe: m.probe === true }
        : null,
  ],
  [
    "downloadFull",
    (m) => {
      if (!isVideoKey(m.videoKey)) return null;
      if (m.kind === undefined && m.index === undefined) return { videoKey: m.videoKey, kind: null, index: null };
      return FULL_KINDS.has(m.kind) && isIndex(m.index, Math.max(MAX_VARIANTS, MAX_HEIGHTS + 1))
        ? { videoKey: m.videoKey, kind: m.kind, index: m.index }
        : null;
    },
  ],
  ["getState", () => ({})],
  ["setPanelOpen", (m) => (typeof m.open === "boolean" ? { open: m.open } : null)],
  ["getSource", () => ({})],
  ["chooseSource", (m) => (isIndex(m.index, MAX_ENTRIES_PER_TAB) ? { index: m.index } : null)],
  ["chooseVariant", (m) => (isIndex(m.index, MAX_VARIANTS) ? { index: m.index } : null)],
  ["chooseHeight", (m) => (isIndex(m.index, MAX_HEIGHTS + 1) ? { index: m.index } : null)],
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
  ["ignoreSite", () => ({})],
  ["setDownloadWith", (m) => (typeof m.browser === "boolean" ? { browser: m.browser } : null)],
  ["copyText", (m) => (COPY_KINDS.has(m.what) ? { what: m.what } : null)],
]);

// Accepted only from the frame that holds the selected video (see the protocol).
const SELECTED_FRAME_TYPES = new Set([
  "removeSegment",
  "clearSegments",
  "cancelStart",
  "seek",
  "getTime",
  "play",
  "pause",
  "select",
  "setPanelOpen",
  "getSource",
  "chooseSource",
  "chooseVariant",
  "chooseHeight",
  "download",
  "jobs",
  "cancel",
  "deps",
  "setIncognito",
  "view",
  "ignoreSite",
  "setDownloadWith",
  "copyText",
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
  // An ignored tab reports nothing: the auto-pick drops to null and the overlay closes.
  const ignored = await tabIgnored(tabId, (await readUI()).ignoredDomains);
  announceCandidates(tabId, await setFrameCandidates(tabId, frameId, ignored ? [] : videos));
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
  ensureIntro(tabId, hub.selected).catch(hubWarn); // Player introspection (blob: videos only)
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

async function onCancelStart(tabId) {
  const hub = await withTab(tabId, async () => {
    const h = await readHub(tabId);
    if (h.pendingStart !== null) {
      h.pendingStart = null;
      await writeHub(tabId, h);
    }
    return h;
  });
  notifyAll(tabId, { type: "state", state: hub });
  hubLog(`cancelStart tab=${tabId}`);
  return { ok: true, state: hub };
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
  if (hub.panelOpen && hub.selected) ensureIntro(tabId, hub.selected).catch(hubWarn); // shares onSelect's run
  return { ok: true, state: hub };
}

// Player button: the sender frame (never the message) selects one of its own
// non-excluded videos and opens the overlay on it. Not selected-frame gated.
async function onOpenOverlay(tabId, frameId, { videoKey }) {
  if (await tabIgnored(tabId, (await readUI()).ignoredDomains)) return { ok: false, error: "ignored" };
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
  const reply = { ok: true, state: hub, ui: await uiFor(tabId, await readUI()) };
  if (hub.selected && hub.selected.frameId === frameId) reply.segments = segments;
  // No pong yet (e.g. the app's integration was installed after this extension):
  // ask the app in the background; its pong broadcasts the switches and `ignored`.
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
// at: the navigation's time; captures older than it are marked stale (isLive).
async function onPageChanged(tabId, url, at = Date.now()) {
  const key = pageKeyOf(url);
  const result = await withTab(tabId, async () => {
    const rec = await readPageRecord(tabId);
    if (rec && rec.key === key) return null;
    const caps = (await chrome.storage.session.get({ [capKey(tabId)]: [] }))[capKey(tabId)];
    if (Array.isArray(caps) && caps.length) {
      for (const e of caps) if (isObject(e) && e.ts < at) e.staleAt = at; // a later change moves it on
      await chrome.storage.session.set({ [capKey(tabId)]: caps });
    }
    const h = await readHub(tabId);
    h.pendingStart = null; // a start belongs to the page it was marked on
    await writeHub(tabId, h);
    await chrome.storage.session.remove([srcKey(tabId), varKey(tabId), resKey(tabId), introKey(tabId)]);
    introGens.set(tabId, introGen(tabId) + 1); // a player probe in flight writes nothing
    introManifests.delete(tabId);
    return { hub: h, segments: await loadSegments(tabId) };
  });
  if (!result) return;
  const { hub, segments } = result;
  if (hub.selected) notifyOverlay(tabId, hub.selected.frameId, { type: "segments", segments });
  notifyAll(tabId, { type: "state", state: hub });
  hubLog(`pageChanged tab=${tabId}`);
}

// --- source correlation (4.1; rules under "Source correlation" in the protocol) ---

const MEDIA_KINDS = new Set(["hls", "dash", "mp4", "file"]);
const isMediaEntry = (e) => isObject(e) && MEDIA_KINDS.has(e.kind) && typeof e.url === "string";

// Does the app decode the dash and file kinds? An older app fails to decode the whole
// enqueue, so correlate and sourceList drop those captures for it. Browser mode
// (ui.browserOnly) keeps them: nothing goes to an app (correlate and sourceList's
// callers read the flag).
const dashAllowed = () => appProtocol() >= DASH_PROTOCOL;
const isAppMediaEntry = (e) => isMediaEntry(e) && (dashAllowed() || (e.kind !== "dash" && e.kind !== "file"));

// Pure: the capture e is url, or was redirected from it (alias).
const sameURL = (e, url) => e.url === url || e.alias === url;

// Only allowlisted headers, copied (stored headers came from pickHeaders already).
function copyHeaders(h) {
  const headers = {};
  for (const name of ALLOWED_HEADERS) if (isObject(h) && typeof h[name] === "string") headers[name] = h[name];
  return headers;
}

function entrySource(e, via) {
  return { source: { type: "media", url: e.url, kind: e.kind, headers: copyHeaders(e.headers) }, frameId: e.frameId, via };
}

// The Referer / Origin a player's cross-origin request sends from a page at url
// (strict-origin-when-cross-origin), through the header allowlist.
function originHeaders(url) {
  const origin = httpURL(url).origin;
  return pickHeaders([{ name: "Referer", value: `${origin}/` }, { name: "Origin", value: origin }]);
}

// The frame's URL from webNavigation (never from a content script) when it is
// http(s) and at most MAX_URL_LENGTH chars, else null.
async function frameURL(tabId, frameId) {
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId });
    const url = frame && frame.url;
    return typeof url === "string" && url.length <= MAX_URL_LENGTH && httpURL(url) ? url : null;
  } catch {
    return null; // the frame is gone, or no getFrame (Safari)
  }
}

// Pure: the selected Facebook video's own page (frame 0, with videoId), else topURL.
function videoPageURL(topURL, selected, cand) {
  const u = topURL ? httpURL(topURL) : null;
  if (!u || !(selected && selected.frameId === 0) || !(cand && cand.videoId)) return topURL;
  if (u.hostname !== "facebook.com" && !u.hostname.endsWith(".facebook.com")) return topURL;
  return `${u.origin}/watch/?v=${cand.videoId}`;
}

// Pure: the capture is from the current page: not marked stale by a page change
// (onPageChanged), or its frame's chunks still come from its directory (the URL up to
// its last "/") more than STALE_GRACE_MS after the change.
function isLive(e, active) {
  if (e.staleAt === undefined) return true;
  const a = active[e.frameId];
  if (!isObject(a) || !(a.ts > e.staleAt + STALE_GRACE_MS) || typeof a.lastChunkUrl !== "string") return false;
  const u = new URL(e.url);
  return a.lastChunkUrl.startsWith(u.origin + u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1));
}

// Pure: {source, frameId, via} or null. `media` holds media entries the app takes,
// oldest first. intro: the selected video's player probe record plus manifest (the
// text, only when the app takes a playlist source) and frameHeaders (from the frame's
// URL), or null. dash: the app takes the dash and file kinds (DASH_PROTOCOL).
function pickSource({ selected, currentSrc, choice, intro, media, active, topURL, dash = false }) {
  if (choice) {
    const e = media.findLast((x) => x.url === choice.url);
    if (e) return entrySource(e, "user");
  }
  if (selected && currentSrc) {
    const e = media.findLast((x) => sameURL(x, currentSrc));
    if (e) return entrySource(e, "currentSrc");
    const path = httpURL(currentSrc).pathname.toLowerCase();
    // An old app gets webm & co. as mp4: it can still re-encode them in precise mode.
    const fileExt = [".webm", ".mkv", ".ogv"].some((x) => path.endsWith(x));
    const kind = path.endsWith(".m3u8") ? "hls" : fileExt && dash ? "file" : "mp4";
    return { source: { type: "media", url: currentSrc, kind, headers: {} }, frameId: selected.frameId, via: "currentSrc" };
  }
  if (selected && intro) {
    if (intro.manifest) {
      const source = { type: "playlist", text: intro.manifest, baseURL: intro.baseURL, headers: copyHeaders(intro.headers) };
      return { source, frameId: selected.frameId, via: "player" };
    }
    // dash only when the app reads DASH; a URL of no known kind is skipped too.
    if (intro.url && (intro.kind === "hls" || intro.kind === "mp4" || (intro.kind === "dash" && dash))) {
      const e = media.findLast((x) => sameURL(x, intro.url));
      if (e) return entrySource(e, "player");
      const source = { type: "media", url: intro.url, kind: intro.kind, headers: copyHeaders(intro.frameHeaders) };
      return { source, frameId: selected.frameId, via: "player" };
    }
  }
  // The capture tiers skip stale captures: with none live, the page source (never the previous video).
  const live = media.filter((e) => isLive(e, active));
  if (selected) {
    const own = live.filter((e) => e.frameId === selected.frameId);
    const e =
      own.findLast((x) => x.kind === "hls" && x.isMaster === true) ||
      own.findLast((x) => x.kind === "hls") ||
      own.findLast((x) => x.kind === "dash") ||
      own.findLast((x) => x.kind === "mp4") ||
      own.findLast((x) => x.kind === "file");
    if (e) return entrySource(e, "capture");
  }
  let best = null;
  let bestTier = -1;
  for (const e of live) {
    const kindTier = e.kind === "hls" ? 4 : e.kind === "dash" ? 2 : 0;
    const tier = (isObject(active[e.frameId]) ? 8 : 0) + kindTier + (e.isMaster === true ? 1 : 0);
    if (tier >= bestTier) [best, bestTier] = [e, tier]; // >=: the newest wins a tie
  }
  if (best) return entrySource(best, "capture");
  return topURL ? { source: { type: "page", url: topURL }, frameId: 0, via: "page" } : null;
}

// Reads everything in one tab-queue turn. A choice made for another video (or
// none) is dropped here, so it cannot come back when that video is re-selected.
// target ({frameId, videoKey}, default the selected video) is "own" when it is the
// selected video; another target (the Download full button) is resolved without
// the stored src: choice, which it never reads nor drops. r.own says which.
// The player probe's record is used only for that target while its candidate is
// blob:, its manifest only when the last pong allows a playlist source. A video in
// a subframe uses that frame's URL as the page (r.pageFrame; r.topURL keeps the top).
function correlate(tabId, target = null) {
  return withTab(tabId, async () => {
    const keys = [capKey(tabId), actKey(tabId), candKey(tabId), srcKey(tabId), topKey(tabId), introKey(tabId)];
    const got = await chrome.storage.session.get(keys);
    const hub = await readHub(tabId);
    const sel = target || hub.selected;
    const own = !target || sameSelection(target, hub.selected);
    const cand = sel ? ((got[candKey(tabId)] || {})[sel.frameId] || []).find((v) => v.videoKey === sel.videoKey) : null;
    let choice = own && isObject(got[srcKey(tabId)]) ? got[srcKey(tabId)] : null;
    if (choice && !sameSelection(choice.selected || null, sel)) {
      await chrome.storage.session.remove(srcKey(tabId));
      choice = null;
    }
    const top = got[topKey(tabId)];
    const topURL = typeof top === "string" && httpURL(top) ? top : null;
    const dash = dashAllowed() || (await readUI()).browserOnly; // Browser mode keeps dash and file
    // A subframe's own URL (an embed's page reads best in yt-dlp); Facebook's rule is frame 0 only.
    const subURL = sel && sel.frameId > 0 ? await frameURL(tabId, sel.frameId) : null;
    const pageFrame = Boolean(subURL && subURL !== topURL);
    const pageURL = pageFrame ? subURL : videoPageURL(topURL, sel, cand);
    const rec = got[introKey(tabId)];
    let intro = null;
    if (isObject(rec) && cand && cand.blob === true && sameSelection(rec, sel)) {
      const kept = introManifests.get(tabId);
      const allowed = rec.hasManifest && kept && kept.ts === rec.ts && appProtocol() >= PLAYLIST_PROTOCOL;
      const ownURL = sel.frameId > 0 ? subURL : topURL; // the video's frame
      intro = { ...rec, manifest: allowed ? kept.text : null, frameHeaders: ownURL ? originHeaders(ownURL) : {} };
    }
    const r = pickSource({
      selected: sel,
      currentSrc: cand && cand.currentSrc ? cand.currentSrc : null,
      choice,
      intro,
      media: (got[capKey(tabId)] || []).filter((e) => isMediaEntry(e) && (dash || (e.kind !== "dash" && e.kind !== "file"))),
      active: isObject(got[actKey(tabId)]) ? got[actKey(tabId)] : {},
      topURL: pageURL,
      dash,
    });
    // For the job (5.2): the page URL (page-first), the target video's duration and
    // the DRM signals (player: the player probe's flag; keys: the agent's mediaKeys).
    if (r) {
      Object.assign(r, {
        pageURL,
        topURL,
        pageFrame,
        duration: cand && isFiniteNum(cand.duration) && cand.duration > 0 ? cand.duration : null,
        own,
        drm: { player: Boolean(intro && intro.drm === true), keys: Boolean(cand && cand.drm === true) },
      });
    }
    return r;
  });
}

// For the job builder (4.3): {source, frameId, via, pageURL, topURL, pageFrame,
// duration, own, drm: {player, keys}} with the full Source (captured headers), or null. Service-worker only; never send it to
// a content script. Reads the probe cache only (no native call); variantURL only
// for a variant other than the default one (variantChosen: the user chose it).
// An own target (see correlate) uses the stored var: choice; another target only
// reads the cache (readProbeRec), so the selected video's choice stays. variantPick
// (an index into the sorted list) is a choice for this one job, for either target.
async function resolveSource(tabId, target = null, variantPick = null) {
  const r = await correlate(tabId, target);
  if (!r) return null;
  if (isHLS(r)) {
    const { list, choice } = r.own
      ? await readVariants(tabId, r.source.url)
      : { ...(await readProbeRec(tabId, r.source.url)), choice: null };
    const picked = Number.isInteger(variantPick);
    const i = picked ? variantPick : variantIndex(list, choice);
    if (i > 0 && i < list.length) r.source.variantURL = list[i].url; // a pick past a changed list: default
    r.variantChosen = picked || Boolean(choice);
  }
  return r;
}

// The job's sources (see "Send the job"): page first with the resolved media as
// its fallback when the media was not pinned by the user (chooseSource, a
// non-default chooseVariant) and the app speaks protocol 2 (a playlist source too);
// else the resolved source alone. -> {r, source, fallback (null when none), pinned}
// or null. pinned: the user's pick, which no DRM rule overrides.
// target / variantPick: see resolveSource (none = the selected video, as stored).
async function planSource(tabId, protocol, target = null, variantPick = null) {
  const r = await resolveSource(tabId, target, variantPick);
  if (!r) return null;
  const pinned = r.via === "user" || Boolean(r.variantChosen && r.source.variantURL);
  if ((r.source.type === "media" || r.source.type === "playlist") && !pinned && protocol >= 2 && r.pageURL) {
    return { r, source: { type: "page", url: r.pageURL }, fallback: r.source, pinned };
  }
  return { r, source: r.source, fallback: null, pinned };
}

// Explicit field map: no query, no headers (see the protocol).
function summarizeSource(r) {
  if (!r) return null;
  if (r.source.type === "playlist") {
    const base = httpURL(r.source.baseURL);
    return { kind: "hls", host: base ? base.host : "", file: "inline playlist", frameId: r.frameId, via: r.via };
  }
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

// The source list chooseSource indexes: the tab's hls, dash, mp4 and file captures
// (dash and file only for an app at DASH_PROTOCOL, or in Browser mode: browser true)
// sorted by frameId, then URL.
// Stable while no capture is added or dropped (a re-fetch moves an entry to the end of
// cap:<tabId>, so that order would shift under the menu).
function sourceList(entries, browser = false) {
  return entries
    .filter((e) => (browser ? isMediaEntry(e) : isAppMediaEntry(e)))
    .sort((a, b) => a.frameId - b.frameId || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

async function onChooseSource(tabId, { index }) {
  const chosen = await withTab(tabId, async () => {
    const key = capKey(tabId);
    const entries = (await chrome.storage.session.get({ [key]: [] }))[key];
    const e = sourceList(Array.isArray(entries) ? entries : [], (await readUI()).browserOnly)[index];
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
    fullClipConfirm: o.fullClipConfirm !== false,
    playerButton: o.playerButton !== false,
    fullDownloadButton: o.fullDownloadButton !== false,
    ignoredDomains: cleanDomains(o.ignoredDomains),
    preferredHeight: Number.isInteger(o.preferredHeight) && o.preferredHeight >= 1 && o.preferredHeight <= MAX_HEIGHT ? o.preferredHeight : null,
    downloadWith: DOWNLOAD_WITH.has(o.downloadWith) ? o.downloadWith : "segdown",
    // 0 from an older app (no revision): updateUI compares revisions, never values.
    downloadWithRev: Number.isSafeInteger(o.downloadWithRev) && o.downloadWithRev >= 0 ? o.downloadWithRev : 0,
    otherAppName: cleanAppName(o.otherAppName),
  };
}

// A display name from the app (control characters removed, at most MAX_APP_NAME
// code points), or null.
function cleanAppName(name) {
  if (typeof name !== "string") return null;
  const text = [...name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")].slice(0, MAX_APP_NAME).join("").trim();
  return text || null;
}

// Hostnames like IgnoredDomain.normalize's (lowercased first), deduped, at most
// MAX_IGNORED_DOMAINS; anything but an array -> [].
function cleanDomains(list) {
  if (!Array.isArray(list)) return [];
  const hosts = list
    .filter((d) => typeof d === "string")
    .map((d) => d.toLowerCase())
    .filter((d) => d.length <= MAX_DOMAIN_LENGTH && DOMAIN_RE.test(d));
  return [...new Set(hosts)].slice(0, MAX_IGNORED_DOMAINS);
}

// storage.local ui, checked; never pinged (nothing stored) -> every switch on, no
// ignored domains, not in Browser mode, no app revision seen. A value stored before
// ignoredDomains existed reads as [], one stored before fullDownloadButton existed
// reads it as true, one stored before browserOnly / appRev existed as false / null.
async function readUI() {
  const u = (await chrome.storage.local.get(UI_KEY))[UI_KEY];
  const mode = {
    browserOnly: isObject(u) && u.browserOnly === true,
    appRev: isObject(u) && (Number.isSafeInteger(u.appRev) || u.appRev === "sync") ? u.appRev : null,
  };
  return isObject(u) && typeof u.fullClipButton === "boolean" && typeof u.playerButton === "boolean"
    ? {
        fullClipButton: u.fullClipButton,
        playerButton: u.playerButton,
        fullDownloadButton: u.fullDownloadButton !== false,
        ignoredDomains: cleanDomains(u.ignoredDomains),
        ...mode,
      }
    : { fullClipButton: true, playerButton: true, fullDownloadButton: true, ignoredDomains: [], ...mode };
}

// Browser mode (see the protocol): no native message, no native port.
const browserOnly = async () => (await readUI()).browserOnly;

// Ignored tab: the host of top:<tabId> is one of domains or a subdomain of one
// (no top URL -> false).
async function tabIgnored(tabId, domains) {
  if (domains.length === 0) return false;
  const top = (await chrome.storage.session.get(topKey(tabId)))[topKey(tabId)];
  let host;
  try {
    host = new URL(top).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

// The `ui` content scripts of tabId get: the switches and whether the tab is
// ignored, never the list.
async function uiFor(tabId, { fullClipButton, playerButton, fullDownloadButton, ignoredDomains }) {
  return { fullClipButton, playerButton, fullDownloadButton, ignored: await tabIgnored(tabId, ignoredDomains) };
}

// True once a pong or a "Download with" menu pick has stored ui (never cleared).
async function hasStoredUI() {
  return (await chrome.storage.local.get(UI_KEY))[UI_KEY] !== undefined;
}

// After a pong: saves the switches, ignored domains and Browser mode when they
// changed (or were never stored) and sends every tab its own `ui` (uiFor).
// Browser mode follows the newest change (see the protocol's `ui` storage line): the
// app's downloadWith applies only when its revision is new; after a menu pick
// (appRev "sync") the revision is recorded, not applied. Read-modify-write in the
// UI_KEY queue, shared with onSetDownloadWith.
async function updateUI(settings) {
  const { fullClipButton, playerButton, fullDownloadButton, ignoredDomains, downloadWith, downloadWithRev: rev } = settings;
  const ui = await withTab(UI_KEY, async () => {
    const stored = await hasStoredUI();
    const prev = await readUI();
    let browser = prev.browserOnly;
    if (prev.appRev === null) browser = browser || downloadWith === "browser"; // first pong ever
    else if (prev.appRev !== "sync" && rev !== prev.appRev) browser = downloadWith === "browser"; // a new app change
    const sameDomains =
      prev.ignoredDomains.length === ignoredDomains.length && prev.ignoredDomains.every((d, i) => d === ignoredDomains[i]);
    if (
      stored &&
      prev.fullClipButton === fullClipButton &&
      prev.playerButton === playerButton &&
      prev.fullDownloadButton === fullDownloadButton &&
      sameDomains &&
      prev.browserOnly === browser &&
      prev.appRev === rev
    )
      return null;
    const next = { ...prev, fullClipButton, playerButton, fullDownloadButton, ignoredDomains, browserOnly: browser, appRev: rev };
    await chrome.storage.local.set({ [UI_KEY]: next });
    return next;
  });
  if (!ui) return;
  for (const tab of await chrome.tabs.query({})) {
    if (Number.isInteger(tab.id) && tab.id >= 0) notifyAll(tab.id, { type: "ui", ui: await uiFor(tab.id, ui) });
  }
  refreshActionMenu().catch(hubWarn);
}

// Downloads between the click and the app's reply: a reload then would drop the job.
let downloadsInFlight = 0;

// The app updates the folder a Chromium browser loads this extension from (its
// Browsers page), so an app version other than this one means newer files on disk:
// reload to run them. Once per version pair, so a copy loaded from elsewhere (an
// older release zip) or Safari's appex never loops. Never during a download: a
// later ping (after DEPS_TTL_MS) reloads instead. Never on Firefox: the signed add-on
// rereads the same package, and Firefox updates it from its update_url.
async function reloadIfOutdated(appVersion) {
  if (IS_FIREFOX) return;
  const own = chrome.runtime.getManifest().version;
  if (typeof appVersion !== "string" || appVersion === own || typeof chrome.runtime.reload !== "function") return;
  if (downloadsInFlight > 0) return;
  const pair = `${own}>${appVersion}`;
  if ((await chrome.storage.local.get(RELOAD_KEY))[RELOAD_KEY] === pair) return;
  await chrome.storage.local.set({ [RELOAD_KEY]: pair });
  hubLog(`reload: extension ${own}, app ${appVersion}`);
  chrome.runtime.reload();
}

const isPong = (reply) => isObject(reply) && reply.type === "pong" && Array.isArray(reply.missing);

// A pong (ping or setIgnored) -> {result: {missing: [tool], protocol, settings},
// ui: the running updateUI (never rejects)}. Sets the persistence gate
// (incognitoDefault) and the storage.local ui switches and ignored domains
// (updateUI); an app version other than this one reloads the extension
// (reloadIfOutdated).
function applyPong(reply) {
  const settings = cleanSettings(reply.settings);
  const protocol = Number.isInteger(reply.protocol) && reply.protocol >= 1 ? reply.protocol : 1;
  const opened = incognitoDefault === null;
  incognitoDefault = settings.incognitoDefault;
  if (opened) persistHeldSegments().catch(hubWarn);
  const ui = updateUI(settings).catch(hubWarn);
  reloadIfOutdated(reply.version).catch(hubWarn);
  const missing = [...new Set(reply.missing.filter((t) => typeof t === "string" && TOOLS.has(t)))];
  return { result: { missing, protocol, settings }, ui };
}

// The only way to the native host besides the status port: refuses in Browser mode
// (a backstop; callers return early so the error never lands in a cache).
async function sendNative(msg) {
  if (await browserOnly()) throw new Error(BROWSER_ONLY);
  return chrome.runtime.sendNativeMessage(NATIVE_HOST, msg);
}

// -> {missing: [tool], protocol, settings} or {missing: [], appError}. Never
// throws. Every pong goes through applyPong, and its updateUI is awaited, so a
// caller sees the Browser mode the pong set.
async function pingNative() {
  let reply;
  try {
    reply = await sendNative({ type: "ping" });
  } catch {
    return { missing: [], appError: APP_UNREACHABLE };
  }
  if (isPong(reply)) {
    const { result, ui } = applyPong(reply);
    await ui;
    return result;
  }
  return { missing: [], appError: "Unexpected reply from the SegDown app." };
}

const depsCache = { ts: 0, result: null, run: null };

// settings.preferredHeight from the last pong (no native call), or null.
const preferredHeight = () => (depsCache.result && depsCache.result.settings ? depsCache.result.settings.preferredHeight : null);

// The protocol of the last pong (no native call): 1 without one or when the app errored.
const appProtocol = () => (depsCache.result && !depsCache.result.appError ? depsCache.result.protocol : 1);

// The index in heights of the tallest one <= pref, else of the shortest one; -1
// without a preference or a height (non-integers are skipped). Ties keep the first.
function preferredIndex(heights, pref) {
  let best = -1;
  if (!pref) return best;
  heights.forEach((h, i) => {
    if (!Number.isInteger(h)) return;
    const b = heights[best];
    if (best < 0 || (h <= pref ? b > pref || h > b : b > pref && h < b)) best = i;
  });
  return best;
}

// retryError: a cached failure is not reused (Download asks the app again).
// Browser mode: no ping, the cache untouched, {missing: [], appError: BROWSER_ONLY, browser: true}.
async function fetchDeps(retryError = false) {
  if (await browserOnly()) return { missing: [], appError: BROWSER_ONLY, browser: true };
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

// The overlay's "Download with" menu (see "Browser mode" in the protocol). Never
// calls the app; leaving Browser mode drops the cached pong so the next `view` pings.
async function onSetDownloadWith(tabId, { browser }) {
  await withTab(UI_KEY, async () => {
    await chrome.storage.local.set({ [UI_KEY]: { ...(await readUI()), browserOnly: browser, appRev: "sync" } });
  });
  if (!browser) depsCache.result = null;
  hubLog(`downloadWith tab=${tabId} browser=${browser}`);
  refreshActionMenu().catch(hubWarn);
  return { ok: true };
}

async function onDeps() {
  const { missing, appError } = await fetchDeps();
  const reply = { ok: true, missing: [...missing] };
  if (appError) reply.appError = appError;
  return reply;
}

// --- ignored sites from the browser (rules under "Ignored sites" in the protocol) ---

// The hostname of top:<tabId> (webNavigation, never a content script), or null.
async function topHost(tabId) {
  const top = (await chrome.storage.session.get(topKey(tabId)))[topKey(tabId)];
  try {
    return new URL(top).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

// Sends setIgnored once no ping is in flight, and is the shared depsCache.run while
// it runs, so a ping that answers later cannot overwrite the new list. fetchDeps
// callers that find the cache stale meanwhile share it and get a deps result: the
// pong's (also cached), else deps (the cache is left as it is). -> the hub reply.
async function setIgnoredNative(host, ignored, deps) {
  while (depsCache.run) await depsCache.run;
  let reply = null;
  const shared = (async () => {
    let answer;
    try {
      answer = await sendNative({ type: "setIgnored", host, ignored });
    } catch {
      reply = appFailure(APP_UNREACHABLE);
      return deps;
    }
    if (isPong(answer)) {
      const { result, ui } = applyPong(answer);
      Object.assign(depsCache, { ts: Date.now(), result });
      await ui; // the `ui` broadcast before the reply
      reply = { ok: true, ignored };
      return result;
    }
    if (isObject(answer) && answer.type === "error" && typeof answer.code === "string") {
      const text = typeof answer.message === "string" ? answer.message.slice(0, MAX_MESSAGE_CHARS) : "";
      reply = { ok: false, error: "app-error", code: answer.code.slice(0, 32), message: text || "SegDown could not change the Ignored sites." };
    } else {
      reply = { ok: false, error: "app-error", code: "internal", message: "Unexpected reply from the SegDown app." };
    }
    return deps;
  })().finally(() => {
    if (depsCache.run === shared) depsCache.run = null;
  });
  depsCache.run = shared;
  await shared;
  return reply;
}

// Turns the site of tabId's top page off (ignored) or back on in the app's list.
// -> {ok, ignored} or {ok: false, error, message?}.
async function setSiteIgnored(tabId, ignored) {
  const host = await topHost(tabId);
  if (!host) return { ok: false, error: "no-site" };
  const deps = await fetchDeps(true);
  if (deps.appError) return appFailure(deps.appError);
  if (deps.protocol < 4) return { ok: false, error: "app-outdated", message: IGNORE_NEEDS_UPDATE };
  const result = await setIgnoredNative(host, ignored, deps);
  hubLog(`setIgnored tab=${tabId} ${ignored} ${result.ok ? "ok" : `error=${result.code || result.error}`}`);
  if (result.ok) refreshActionMenu().catch(hubWarn); // updateUI skips it when nothing changed
  return result;
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

// -> {variants}, {heights} (a page probe) or {error: {code, message}}. Never throws.
async function probeNative(source) {
  let reply;
  try {
    reply = await sendNative({ type: "probe", source });
  } catch {
    // Host manifest missing, host not allowed for this extension, or it crashed.
    return { error: { code: "unreachable", message: APP_UNREACHABLE } };
  }
  if (isObject(reply) && reply.type === "variants" && Array.isArray(reply.variants)) {
    return { variants: reply.variants.slice(0, MAX_VARIANTS).map(cleanVariant).filter(Boolean) };
  }
  if (isObject(reply) && reply.type === "formats" && Array.isArray(reply.heights)) {
    const heights = reply.heights.filter((h) => Number.isInteger(h) && h >= 1 && h <= MAX_HEIGHT);
    return { heights: [...new Set(heights)].sort((a, b) => b - a).slice(0, MAX_HEIGHTS) };
  }
  if (isObject(reply) && reply.type === "error" && typeof reply.code === "string") {
    const text = typeof reply.message === "string" ? reply.message.slice(0, MAX_MESSAGE_CHARS) : "";
    return { error: { code: reply.code.slice(0, 32), message: text || "SegDown could not read the playlist." } };
  }
  return { error: { code: "internal", message: "Unexpected reply from the SegDown app." } };
}

// A cached result that makes a new probe unnecessary.
const isFresh = (rec, now) =>
  isObject(rec) && (Array.isArray(rec.variants) || Array.isArray(rec.heights) || now - rec.ts < PROBE_RETRY_MS);

// The next Source to probe for resolved source r, or null (rules in the protocol).
function nextProbe(tabId, r) {
  return withTab(tabId, async () => {
    const got = await chrome.storage.session.get({ [probeKey(tabId)]: {}, [capKey(tabId)]: [] });
    const cache = got[probeKey(tabId)];
    const now = Date.now();
    const rec = cache[r.source.url];
    if (!isFresh(rec, now)) return r.source;
    if (r.via !== "capture" || !Array.isArray(rec.variants) || rec.variants.length) return null;
    // A "maybe" too: a disguised master is fetched before its (also disguised) variant playlist.
    const next = got[capKey(tabId)].find(
      (e) =>
        isObject(e) && (e.kind === "hls" || e.kind === "maybe") && typeof e.url === "string" &&
        e.frameId === r.frameId && e.isMaster === undefined && !isFresh(cache[e.url], now)
    );
    return next ? entrySource({ ...next, kind: "hls" }, "capture").source : null;
  });
}

// The next "maybe" capture to probe as HLS, oldest first (players fetch their
// playlists first), or null: only while r is not already an hls source from the
// selected video's frame (tab-wide when nothing is selected), and only from that frame.
function nextMaybe(tabId, r) {
  return withTab(tabId, async () => {
    const { selected } = await readHub(tabId);
    const frame = selected ? selected.frameId : null;
    if (isHLS(r) && (frame === null || r.frameId === frame)) return null;
    const got = await chrome.storage.session.get({ [probeKey(tabId)]: {}, [capKey(tabId)]: [] });
    const cache = got[probeKey(tabId)];
    const now = Date.now();
    const next = got[capKey(tabId)].find(
      (e) => isObject(e) && e.kind === "maybe" && (frame === null || e.frameId === frame) && !isFresh(cache[e.url], now)
    );
    return next ? entrySource({ ...next, kind: "hls" }, "capture").source : null;
  });
}

// Writes one result and sets isMaster on the captures with that URL. A "maybe"
// capture with that URL becomes "hls" when it parsed, and is removed when the app
// says it is not a playlist ("invalid").
function storeProbe(tabId, gen, url, result) {
  return withTab(tabId, async () => {
    if (tabGen(tabId) !== gen) return false; // the tab was cleared meanwhile
    const got = await chrome.storage.session.get({ [probeKey(tabId)]: {}, [capKey(tabId)]: [] });
    const cache = got[probeKey(tabId)];
    delete cache[url]; // re-inserted last
    cache[url] = { ts: Date.now(), ...result };
    const urls = Object.keys(cache).sort((a, b) => cache[a].ts - cache[b].ts);
    for (const old of urls.slice(0, Math.max(0, urls.length - MAX_PROBE_CACHE))) delete cache[old];
    const notPlaylist = Boolean(result.error && result.error.code === "invalid");
    const entries = got[capKey(tabId)].filter((e) => !(notPlaylist && isObject(e) && e.url === url && e.kind === "maybe"));
    for (const e of entries) {
      if (!(result.variants && isObject(e) && e.url === url)) continue;
      e.isMaster = result.variants.length > 0;
      if (e.kind === "maybe") e.kind = "hls";
    }
    await chrome.storage.session.set({ [probeKey(tabId)]: cache, [capKey(tabId)]: entries });
    return true;
  });
}

async function runProbes(tabId) {
  if (await browserOnly()) return; // no native call in Browser mode
  const gen = tabGen(tabId);
  let stored = false;
  let budget = MAX_PROBES_PER_RUN;
  let drops = MAX_ENTRIES_PER_FRAME; // "maybe" captures that are not playlists, on top of the budget
  while (budget > 0) {
    const r = await correlate(tabId);
    const maybe = await nextMaybe(tabId, r);
    if (!maybe && !isHLS(r)) break;
    const source = maybe || (await nextProbe(tabId, r));
    if (!source) break;
    const result = await probeNative({ type: "media", url: source.url, kind: "hls", headers: source.headers });
    if (!(await storeProbe(tabId, gen, source.url, result))) return;
    if (maybe && result.error && result.error.code === "invalid") {
      if (--drops <= 0) break;
    } else budget--;
    // Only the resolved source's result or a new playlist changes what the overlay shows;
    // notifying for anything else would start another run.
    if (result.variants || source.url === (r && r.source.url)) stored = true;
    hubLog(`probe tab=${tabId}${maybe ? " maybe" : ""} ${result.error ? `error=${result.error.code}` : `variants=${result.variants.length}`}`);
    // "invalid" (not a playlist), and "unavailable" for a "maybe" (its refetch failed), are about
    // that URL only: go on with the next one. Any other error is the app's or the host's.
    const perURL = result.error && (result.error.code === "invalid" || (maybe && result.error.code === "unavailable"));
    if (result.error && !perURL) break;
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

// Read-only: the cached result for url and its list (variants sorted as above for
// a playlist, heights for a page; one URL's record holds one or the other). No
// choice and no storage writes: safe for a target that is not the selected video.
function readProbeRec(tabId, url) {
  return withTab(tabId, async () => {
    const got = await chrome.storage.session.get(probeKey(tabId));
    const rec = isObject(got[probeKey(tabId)]) ? got[probeKey(tabId)][url] : undefined;
    if (!isObject(rec)) return { rec: null, list: [] };
    const list = Array.isArray(rec.variants) ? sortVariants(rec.variants) : Array.isArray(rec.heights) ? rec.heights : [];
    return { rec, list };
  });
}

// The variant the job takes: the user's choice, else the preferred height's, else 0.
function variantIndex(list, choice) {
  if (choice) return Math.max(0, list.findIndex((v) => v.url === choice.url));
  return Math.max(0, preferredIndex(list.map((v) => v.height), preferredHeight()));
}

// summarizeSource plus the variant fields for an hls source; starts a probe run
// only while the panel is open (a probe spawns the native host), for any source
// (a page or another frame's media may wait on a "maybe" capture).
async function describeSource(tabId, r) {
  const summary = summarizeSource(r);
  const { panelOpen } = await withTab(tabId, () => readHub(tabId));
  if (panelOpen) startProbes(tabId);
  if (!isHLS(r)) return summary;
  const { rec, list, choice } = await readVariants(tabId, r.source.url);
  if (!rec) summary.probe = { state: "pending" };
  else if (rec.error) summary.probe = { state: "error", message: String(rec.error.message) };
  else if (list.length) {
    summary.variants = list.map((v) => ({ width: v.width, height: v.height, bandwidth: v.bandwidth }));
    summary.variant = variantIndex(list, choice);
  }
  return summary;
}

async function onChooseVariant(tabId, { index }) {
  const r = await correlate(tabId);
  if (!isHLS(r)) return { ok: false, error: "unknown-variant" };
  const { list } = await readVariants(tabId, r.source.url);
  if (index >= list.length) return { ok: false, error: "unknown-variant" };
  await withTab(tabId, async () => {
    const { selected } = await readHub(tabId);
    return chrome.storage.session.set({ [varKey(tabId)]: { source: r.source.url, url: list[index].url, selected } });
  });
  hubLog(`chooseVariant tab=${tabId} index=${index}`);
  return { ok: true, source: await describeSource(tabId, await correlate(tabId)) };
}

// --- page resolution picker (rules under "Page resolution picker" in the protocol) ---

// The page URL yt-dlp gets for plan (page source or page first), or null when the
// job would not run yt-dlp or the app is older than protocol 3.
const heightsPage = (plan, protocol) => (plan && protocol >= 3 && plan.source.type === "page" ? plan.source.url : null);

// The cached heights for pageURL and the height choice that still applies to it
// (a choice for another page, video or a vanished height is dropped here; 0 = Best).
function readHeights(tabId, pageURL) {
  return withTab(tabId, async () => {
    const got = await chrome.storage.session.get([probeKey(tabId), resKey(tabId)]);
    const rec = isObject(got[probeKey(tabId)]) ? got[probeKey(tabId)][pageURL] : undefined;
    const list = isObject(rec) && Array.isArray(rec.heights) ? rec.heights : [];
    let choice = isObject(got[resKey(tabId)]) ? got[resKey(tabId)] : null;
    if (choice) {
      const { selected } = await readHub(tabId);
      if (choice.page !== pageURL || !sameSelection(choice.selected || null, selected) || !(choice.height === 0 || list.includes(choice.height))) {
        await chrome.storage.session.remove(resKey(tabId));
        choice = null;
      }
    }
    return { rec: isObject(rec) ? rec : null, list, choice };
  });
}

async function runPageProbe(tabId, pageURL) {
  if (await browserOnly()) return; // no native call in Browser mode
  const gen = tabGen(tabId);
  if (isFresh((await readHeights(tabId, pageURL)).rec, Date.now())) return;
  const result = await probeNative({ type: "page", url: pageURL });
  if (!(await storeProbe(tabId, gen, pageURL, result))) return;
  hubLog(`probe tab=${tabId} ${result.error ? `error=${result.error.code}` : `heights=${(result.heights || []).length}`}`);
  const { selected } = await withTab(tabId, () => readHub(tabId));
  if (selected) notifyOverlay(tabId, selected.frameId, { type: "sourceChanged" });
}

// One page probe per tab at a time; later calls share it.
const pageProbeRuns = new Map();

function startPageProbe(tabId, pageURL) {
  if (pageProbeRuns.has(tabId)) return pageProbeRuns.get(tabId);
  const run = runPageProbe(tabId, pageURL)
    .catch(hubWarn)
    .finally(() => pageProbeRuns.delete(tabId));
  pageProbeRuns.set(tabId, run);
  return run;
}

async function onChooseHeight(tabId, { index }) {
  const app = await fetchDeps();
  const protocol = app.appError ? null : app.protocol;
  const page = heightsPage(await planSource(tabId, protocol), protocol);
  if (!page) return { ok: false, error: "unknown-height" };
  const { list } = await readHeights(tabId, page);
  if (index > list.length) return { ok: false, error: "unknown-height" };
  await withTab(tabId, async () => {
    const { selected } = await readHub(tabId);
    return chrome.storage.session.set({ [resKey(tabId)]: { page, height: index ? list[index - 1] : 0, selected } });
  });
  hubLog(`chooseHeight tab=${tabId} index=${index}`);
  return { ok: true };
}

// --- player introspection (rules under "Player introspection" in the protocol) ---

// Serialized into the page (executeScript func): no closure over this worker,
// every limit comes in as an argument or a literal. Runs in the page's MAIN
// world, so everything it reads is page data (checked again by cleanIntro).
// -> {url?, type?, drm, manifest?} or null; never throws.
async function playerProbe(attr, maxBytes) {
  try {
    const own = (o, k) => {
      try {
        const d = Object.getOwnPropertyDescriptor(o, k);
        return d ? d.value : undefined; // a value only: never runs a getter
      } catch {
        return undefined;
      }
    };
    const isTagged = (el) => {
      try {
        return Boolean(el) && el.nodeType === 1 && el.hasAttribute(attr); // works inside shadow roots too
      } catch {
        return false;
      }
    };
    const holds = (root) => {
      try {
        return isTagged(root) || Boolean(root && root.querySelector(`[${attr}]`));
      } catch {
        return false;
      }
    };
    // Players are duck-typed: bundled sites have no window.Hls / window.shaka.
    // Window's own keys, newest last (the page's globals follow the built-ins).
    const objs = [];
    const seen = new Set();
    const add = (o) => {
      if (o && typeof o === "object" && !seen.has(o)) {
        seen.add(o);
        objs.push(o);
      }
    };
    let keys = [];
    try {
      keys = Object.getOwnPropertyNames(window).slice(-2000);
    } catch {
      // no keys
    }
    for (const k of keys) {
      const o = own(window, k);
      if (!o || typeof o !== "object") continue;
      add(o);
      for (const p of ["hls", "_hls", "player", "shaka", "dash"]) add(own(o, p));
    }
    let hit = null;
    for (const o of objs) {
      try {
        if (typeof o.loadSource === "function" && "url" in o && "media" in o && Array.isArray(o.levels)) {
          if (isTagged(o.media)) hit = { url: o.url, type: "application/x-mpegurl", drm: false }; // hls.js
        } else if (typeof o.getAssetUri === "function" && typeof o.getMediaElement === "function") {
          if (isTagged(o.getMediaElement())) {
            const drm = typeof o.drmInfo === "function" && o.drmInfo() != null; // Shaka
            hit = { url: o.getAssetUri(), drm };
          }
        } else if (typeof o.getSource === "function" && typeof o.getVideoElement === "function") {
          if (isTagged(o.getVideoElement())) hit = { url: o.getSource(), type: "application/dash+xml", drm: false }; // dash.js
        }
      } catch {
        // not a player, or a broken one
      }
      if (hit) break;
    }
    if (!hit) {
      try {
        const vjs = own(window, "videojs");
        const players = typeof vjs === "function" && typeof vjs.getPlayers === "function" ? vjs.getPlayers() : null;
        for (const p of Object.values(players || {})) {
          if (!p || typeof p.el !== "function" || !holds(p.el())) continue;
          const s = p.currentSource();
          if (s) hit = { url: s.src, type: s.type, drm: false };
          break;
        }
      } catch {
        // no video.js
      }
    }
    if (!hit) {
      try {
        const jw = own(window, "jwplayer");
        if (typeof jw === "function") {
          for (const c of document.querySelectorAll(".jwplayer")) {
            if (!holds(c)) continue;
            const item = jw(c).getPlaylistItem();
            if (item) {
              const sources = Array.isArray(item.sources) ? item.sources : [];
              const file = item.file || (sources.find((s) => s && s.file) || {}).file;
              hit = { url: file, type: typeof item.type === "string" ? item.type : undefined, drm: Boolean(item.drm) };
            }
            break;
          }
        }
      } catch {
        // no JW Player
      }
    }
    if (!hit) return null;
    const out = { drm: hit.drm === true };
    if (typeof hit.url === "string") out.url = hit.url;
    if (typeof hit.type === "string") out.type = hit.type;
    // A playlist that exists only in the page: read it, at most maxBytes.
    if (out.url && out.url.startsWith(`blob:${location.origin}/`)) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2000);
      try {
        const res = await fetch(out.url, { signal: ctl.signal });
        const reader = res.body.getReader();
        const chunks = [];
        let size = 0;
        while (size <= maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.length;
        }
        reader.cancel().catch(() => {});
        if (size <= maxBytes) {
          const bytes = new Uint8Array(size);
          let at = 0;
          for (const c of chunks) {
            bytes.set(c, at);
            at += c.length;
          }
          const text = new TextDecoder().decode(bytes);
          if (/^﻿?#EXTM3U/.test(text)) out.manifest = text;
        }
      } catch {
        // unreadable or too slow: no manifest
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  } catch {
    return null;
  }
}

// Playlist text the app may get inline (a player probe's manifest, a page re-fetch;
// untrusted): within MAX_INLINE_PLAYLIST_BYTES, no NUL, "#EXTM3U" after an optional BOM.
function isPlaylistText(m) {
  return (
    typeof m === "string" &&
    m.length <= MAX_INLINE_PLAYLIST_BYTES &&
    !m.includes("\0") &&
    (m.startsWith("﻿") ? m.slice(1) : m).startsWith("#EXTM3U") &&
    new TextEncoder().encode(m).length <= MAX_INLINE_PLAYLIST_BYTES
  );
}

// The probe's result (untrusted page data, HUB_VALIDATORS style) -> a fresh
// {url?, kind?, drm, manifest?}, or null when it is malformed or holds nothing usable.
function cleanIntro(raw) {
  if (!isObject(raw)) return null;
  if (raw.drm !== undefined && typeof raw.drm !== "boolean") return null;
  const out = { drm: raw.drm === true };
  const u = typeof raw.url === "string" && raw.url.length <= MAX_URL_LENGTH ? httpURL(raw.url) : null; // never blob:
  if (u) {
    out.url = raw.url;
    const type = typeof raw.type === "string" && raw.type.length <= 200 ? raw.type.toLowerCase() : "";
    const path = u.pathname.toLowerCase();
    if (/mpegurl/.test(type) || path.endsWith(".m3u8")) out.kind = "hls";
    else if (/dash/.test(type) || path.endsWith(".mpd")) out.kind = "dash";
    else if (type === "video/mp4" || path.endsWith(".mp4")) out.kind = "mp4";
  }
  if (isPlaylistText(raw.manifest)) out.manifest = raw.manifest;
  return out.url || out.manifest || out.drm ? out : null;
}

// Call inside withTab. The base URL and headers of a probed manifest, never from
// the page: the frame's last chunk request, else its newest capture (its own URL,
// so a Cookie stays scoped to the origin it was sent to), else the frame's URL
// with the Referer / Origin a player's cross-origin request sends. -> {baseURL,
// headers} or null when none is an http(s) URL.
async function introBase(tabId, frameId) {
  const got = await chrome.storage.session.get({ [actKey(tabId)]: {}, [capKey(tabId)]: [] });
  const ok = (url) => typeof url === "string" && url.length <= MAX_URL_LENGTH && Boolean(httpURL(url));
  const act = isObject(got[actKey(tabId)]) ? got[actKey(tabId)][frameId] : null;
  if (isObject(act) && ok(act.lastChunkUrl)) return { baseURL: act.lastChunkUrl, headers: copyHeaders(act.headers) };
  const entries = Array.isArray(got[capKey(tabId)]) ? got[capKey(tabId)] : [];
  const e = entries.findLast((x) => isObject(x) && x.frameId === frameId && ok(x.url));
  if (e) return { baseURL: e.url, headers: copyHeaders(e.headers) };
  const url = await frameURL(tabId, frameId);
  return url ? { baseURL: url, headers: originHeaders(url) } : null;
}

// Keeps text as the tab's manifest (newest MAX_INTRO_MANIFESTS tabs).
function keepManifest(tabId, ts, text) {
  introManifests.delete(tabId); // re-inserted last
  introManifests.set(tabId, { ts, text });
  for (const old of introManifests.keys()) {
    if (introManifests.size <= MAX_INTRO_MANIFESTS) break;
    introManifests.delete(old);
  }
}

// Replaces the tab's record with intro's (null removes it), unless the tab was
// cleared or changed page since gen. A manifest without a base URL is dropped.
// -> the selection when its record was written or removed (its overlay should
// ask `view` again), else null.
function writeIntro(tabId, gen, target, intro) {
  return withTab(tabId, async () => {
    if (introGen(tabId) !== gen) return null;
    const key = introKey(tabId);
    const old = (await chrome.storage.session.get(key))[key];
    const { selected } = await readHub(tabId);
    introManifests.delete(tabId);
    const base = intro && intro.manifest ? await introBase(tabId, target.frameId) : null;
    let rec = null;
    if (intro && (base || intro.url || intro.drm)) {
      rec = { frameId: target.frameId, videoKey: target.videoKey, ts: Date.now(), drm: intro.drm, hasManifest: Boolean(base) };
      if (intro.url) rec.url = intro.url;
      if (intro.kind) rec.kind = intro.kind;
      Object.assign(rec, base || { baseURL: null, headers: {} });
      await chrome.storage.session.set({ [key]: rec });
      if (base) keepManifest(tabId, rec.ts, intro.manifest);
    } else if (old !== undefined) {
      await chrome.storage.session.remove(key);
    }
    const touched = (rec && sameSelection(selected, target)) || (isObject(old) && sameSelection(selected, old));
    return selected && touched ? selected : null;
  });
}

let mainWorldOff = false; // executeScript refused world "MAIN": no probe for this worker's life

// Rejects with Error("timeout") after ms.
function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// One player probe of target ({frameId, videoKey}); every run replaces the
// tab's record (see the protocol). Never call inside withTab.
async function runIntro(tabId, target) {
  const gen = introGen(tabId);
  const log = (what) => hubLog(`intro tab=${tabId} frame=${target.frameId} video=${target.videoKey} ${what}`);
  let intro = null;
  if (typeof chrome.scripting?.executeScript === "function" && !mainWorldOff) {
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
    const attr = `data-segdown-${hex}`;
    const tag = await askAgent(tabId, target.frameId, { type: "tag", videoKey: target.videoKey, attr });
    if (tag.ok !== true) log("tag-refused");
    else {
      try {
        const results = await withTimeout(
          chrome.scripting.executeScript({
            target: { tabId, frameIds: [target.frameId] },
            world: "MAIN",
            func: playerProbe,
            args: [attr, MAX_INLINE_PLAYLIST_BYTES],
          }),
          INTRO_TIMEOUT_MS
        );
        intro = cleanIntro(Array.isArray(results) && results[0] ? results[0].result : null);
        log(intro ? `found kind=${intro.kind || "none"} manifest=${Boolean(intro.manifest)} drm=${intro.drm}` : "none");
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        if (/\bworld\b/i.test(message)) {
          mainWorldOff = true;
          console.warn("[SegDown] hub: no MAIN world for executeScript; player introspection is off");
        }
        log(message === "timeout" ? "timeout" : "error");
      } finally {
        askAgent(tabId, target.frameId, { type: "untag", attr }).catch(hubWarn);
      }
    }
  }
  const selected = await writeIntro(tabId, gen, target, intro);
  if (selected) notifyOverlay(tabId, selected.frameId, { type: "sourceChanged" });
}

// The tab's record for target, or null. fresh: younger than INTRO_TTL_MS with
// its manifest (if any) still in memory, else null.
function readIntro(tabId, target, fresh = false) {
  return withTab(tabId, async () => {
    const rec = (await chrome.storage.session.get(introKey(tabId)))[introKey(tabId)];
    if (!isObject(rec) || !sameSelection(rec, target)) return null;
    if (!fresh) return rec;
    const kept = introManifests.get(tabId);
    return Date.now() - rec.ts < INTRO_TTL_MS && (!rec.hasManifest || (kept && kept.ts === rec.ts)) ? rec : null;
  });
}

// Is target a candidate whose currentSrc is blob:?
async function isBlobTarget(tabId, target) {
  const cands = await withTab(tabId, () => readCands(tabId));
  return (cands[target.frameId] || []).some((v) => v.videoKey === target.videoKey && v.blob === true);
}

// tabId -> {target, run}: the player probe in flight (one per tab at a time).
const introRuns = new Map();

// The tab's player probe record for target, probing first when needed (blob:
// videos only). Without fresh, a recent record is reused and a run in flight
// for the same target is shared (the panel). fresh (Download) waits for a run
// in flight, then always probes, so its result is never from before the click.
// The run is registered before any await, so callers in one turn share it.
// Reads the record back (what the generation guard let through); never rejects.
function ensureIntro(tabId, target, { fresh = false } = {}) {
  const busy = introRuns.get(tabId);
  let run;
  if (busy && !fresh && sameSelection(busy.target, target)) run = busy.run;
  else {
    run = (busy ? busy.run : Promise.resolve())
      .then(async () => {
        if (!fresh && (await readIntro(tabId, target, true))) return;
        if (await isBlobTarget(tabId, target)) await runIntro(tabId, target);
      })
      .catch(hubWarn)
      .finally(() => {
        if (introRuns.get(tabId) && introRuns.get(tabId).run === run) introRuns.delete(tabId);
      });
    introRuns.set(tabId, { target, run });
  }
  return run.then(() => readIntro(tabId, target)).catch((err) => {
    hubWarn(err);
    return null;
  });
}

// --- Download full button (rules under fullOptions in the protocol) ---

// The sender frame's video as a target, checked like openOverlay (never selects it).
async function fullTarget(tabId, frameId, videoKey) {
  if (await tabIgnored(tabId, (await readUI()).ignoredDomains)) return { ok: false, error: "ignored" };
  const cands = await withTab(tabId, () => readCands(tabId));
  if (!(cands[frameId] || []).some((v) => v.videoKey === videoKey && v.excluded === null)) {
    return { ok: false, error: "no-video" };
  }
  return { ok: true, target: { frameId, videoKey } };
}

// The button's list for target, from the probe cache only: {kind, items,
// defaultIndex, pending, plan, probeSource}. The HLS Quality rule wins as in
// `view`; protocol null (no pong yet) leaves the heights unknown. probeSource:
// the native probe source whose record is missing or stale, else null. An own
// target (plan.r.own) uses the stored choices; another one reads the cache only.
async function fullOptionsFor(tabId, target, protocol) {
  const plan = await planSource(tabId, protocol, target);
  const none = (pending, probeSource = null) => ({ kind: "none", items: [], defaultIndex: 0, pending, plan, probeSource });
  if (!plan) return none(false);
  const own = plan.r.own;
  const now = Date.now();
  if (isHLS(plan.r)) {
    const { url, headers } = plan.r.source;
    const { rec, list, choice } = own ? await readVariants(tabId, url) : { ...(await readProbeRec(tabId, url)), choice: null };
    const probeSource = isFresh(rec, now) ? null : { type: "media", url, kind: "hls", headers };
    if (!rec) return { kind: "variants", items: [], defaultIndex: 0, pending: true, plan, probeSource };
    if (rec.error) return none(false, probeSource);
    if (list.length > 1) {
      return { kind: "variants", items: list.map(variantLabel), defaultIndex: variantIndex(list, choice), pending: false, plan, probeSource };
    }
  }
  if (protocol === null) return none(true);
  const page = heightsPage(plan, protocol);
  if (!page) return none(false);
  const { rec, list, choice } = own ? await readHeights(tabId, page) : { ...(await readProbeRec(tabId, page)), choice: null };
  const probeSource = isFresh(rec, now) ? null : { type: "page", url: page };
  if (!rec) return { kind: "heights", items: [], defaultIndex: 0, pending: true, plan, probeSource };
  if (rec.error || list.length <= 1) return none(false, probeSource);
  const defaultIndex = choice ? (choice.height ? 1 + list.indexOf(choice.height) : 0) : 1 + preferredIndex(list, preferredHeight());
  return { kind: "heights", items: ["Best", ...list.map((h) => `${h}p`)], defaultIndex, pending: false, plan, probeSource };
}

// One probe of one URL for a target that is not the selected video (probe runs
// follow the selection); later calls for that tab and URL share it. Freshness is
// read with readProbeRec only (readHeights / readVariants drop the selected
// video's choices). No sourceChanged: the target has no overlay.
const probeOnceRuns = new Map();

function probeOnce(tabId, source) {
  const key = `${tabId} ${source.url}`;
  if (probeOnceRuns.has(key)) return probeOnceRuns.get(key);
  const run = (async () => {
    if (await browserOnly()) return; // no native call in Browser mode
    const gen = tabGen(tabId);
    if (isFresh((await readProbeRec(tabId, source.url)).rec, Date.now())) return;
    const result = await probeNative(source);
    if (!(await storeProbe(tabId, gen, source.url, result))) return;
    const found = result.variants ? `variants=${result.variants.length}` : `heights=${(result.heights || []).length}`;
    hubLog(`probe once tab=${tabId} ${result.error ? `error=${result.error.code}` : found}`);
  })()
    .catch(hubWarn)
    .finally(() => probeOnceRuns.delete(key));
  probeOnceRuns.set(key, run);
  return run;
}

async function onFullOptions(tabId, frameId, { videoKey, probe }) {
  const t = await fullTarget(tabId, frameId, videoKey);
  if (!t.ok) return t;
  // Browser and Another-app modes take the whole file: no list, the button downloads at once.
  const whole = { ok: true, kind: "none", items: [], defaultIndex: 0, pending: false };
  if (await browserOnly()) return whole;
  // The button hovers: a player probe is started, never awaited (Download awaits its own).
  if (probe) ensureIntro(tabId, t.target).catch(hubWarn);
  // probe: ask the app (it may launch it); else the last pong only. A failing app
  // counts as protocol 1 (no heights), so the button downloads at once and gets the
  // app's error from downloadFull.
  const app = probe ? await fetchDeps() : depsCache.result;
  if (otherAppMode(app)) return whole;
  const protocol = !app ? null : app.appError ? 1 : app.protocol;
  const o = await fullOptionsFor(tabId, t.target, protocol);
  // Not awaited: the reply never waits for a probe (the button polls).
  // A page always gets its own one-shot probe: startPageProbe's one run per tab
  // may be busy with another URL and would never probe this one.
  if (probe && o.probeSource) {
    const gen = tabGen(tabId);
    const run = o.plan.r.own && o.probeSource.type !== "page" ? startProbes(tabId) : probeOnce(tabId, o.probeSource);
    // A playlist with at most one variant falls through to the page heights, which
    // polls never probe: once the playlist probe settles, probe that page here.
    if (o.probeSource.type !== "page") {
      run
        .then(async () => {
          if (tabGen(tabId) !== gen) return;
          const next = await fullOptionsFor(tabId, t.target, protocol);
          if (next.probeSource && next.probeSource.type === "page") probeOnce(tabId, next.probeSource);
        })
        .catch(hubWarn);
    }
  }
  return { ok: true, kind: o.kind, items: o.items, defaultIndex: o.defaultIndex, pending: o.pending };
}

// The button's download: a full clip of the sender frame's video (never selected).
// A {kind, index} pick must still match the list fullOptions would show now.
async function onDownloadFull(tabId, frameId, { videoKey, kind, index }, from) {
  const t = await fullTarget(tabId, frameId, videoKey);
  if (!t.ok) return t;
  if (kind) {
    const app = await fetchDeps(true);
    if (app.appError) return appFailure(app.appError);
    const o = await fullOptionsFor(tabId, t.target, app.protocol);
    if (o.kind !== kind || index >= o.items.length) return { ok: false, error: "options-changed" };
  }
  return onDownload(tabId, from, { mode: null, incognito: false, full: true }, { target: t.target, pick: kind ? { kind, index } : null });
}

// --- send the job (4.3; rules under "Send the job" in the protocol) ---

// The app's reply mapped to the frame's (never the job or its source).
async function enqueueNative(job) {
  let reply;
  try {
    reply = await sendNative({ type: "enqueue", job });
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

// "(3) ▶ Clip - YouTube" on www.youtube.com -> "Clip" (rules in the protocol
// comment's "Send the job"). Pure; host "" (or an IP) has no site rule.
function tidyTitle(title, host) {
  let t = title;
  const cut = (re) => {
    const rest = t.replace(re, "").trim();
    if (rest) t = rest;
  };
  cut(/^\(\d{1,4}\+?\)\s+/);
  cut(/^[\u25b6\u25ba]\ufe0f?\s*/);
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (!labels.length || host.includes(":") || /^\d+(\.\d+){3}$/.test(host)) return t;
  const norm = (s) => s.toLowerCase().replace(/[\s.-]/g, "");
  const sites = [norm(labels.length > 1 ? labels[labels.length - 2] : labels[0]), norm(labels.slice(-2).join("."))];
  const m = /^(.*\S)\s+[-\u2013\u2014|]\s+(\S.*)$/.exec(t);
  if (m && sites.includes(norm(m[2]))) t = m[1];
  return t;
}

// The tab's title (never the message body or the sending frame's document),
// tidied for the host of top:<tabId>.
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
  const top = await withTab(tabId, async () => (await chrome.storage.session.get(topKey(tabId)))[topKey(tabId)]);
  let host = "";
  try {
    host = new URL(top).hostname;
  } catch {
    // no top-frame URL
  }
  return tidyTitle(cleanTitle(title), host);
}

// A failed ping as a Download reply.
function appFailure(appError) {
  return appError === APP_UNREACHABLE
    ? { ok: false, error: "app-unreachable", message: APP_UNREACHABLE }
    : { ok: false, error: "app-error", code: "internal", message: appError };
}

// Asks the frame that captured the hls playlist url to fetch it again (see "Send the
// job"). -> null when it does not apply (no hls capture with that URL, or a service
// worker's), else {entry, text} (text null when the page got nothing usable). Never
// holds the tab queue while it waits.
async function refetchPlaylist(tabId, url) {
  const entries = await withTab(tabId, async () => (await chrome.storage.session.get({ [capKey(tabId)]: [] }))[capKey(tabId)]);
  const entry = Array.isArray(entries) ? entries.find((e) => isObject(e) && e.url === url && e.kind === "hls") : null;
  if (!entry || entry.sw === true || !Number.isInteger(entry.frameId)) return null;
  const headers = copyHeaders(entry.headers);
  // "include" fails CORS against Access-Control-Allow-Origin: *; hls.js sends "same-origin".
  const frame = await frameURL(tabId, entry.frameId);
  const sameOrigin = frame !== null && httpURL(frame).origin === httpURL(entry.url).origin;
  const msg = {
    to: "agent",
    type: "refetch",
    url: entry.url,
    credentials: headers.Cookie || sameOrigin ? "include" : "same-origin",
    maxBytes: MAX_INLINE_PLAYLIST_BYTES,
  };
  if (headers.Referer) msg.referrer = headers.Referer; // the agent keeps it only when same-origin
  const key = refetchKey(tabId, entry.frameId, entry.url);
  const now = Date.now();
  for (const [k, expiry] of refetching) if (expiry <= now) refetching.delete(k);
  refetching.set(key, now + REFETCH_TIMEOUT_MS + 1000);
  let timer;
  try {
    // Not askAgent: a frame that cannot answer is not dropped for this.
    const reply = await Promise.race([
      Promise.resolve()
        .then(() => chrome.tabs.sendMessage(tabId, msg, { frameId: entry.frameId }))
        .catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(resolve, REFETCH_TIMEOUT_MS + 1000, null);
      }),
    ]);
    const text = isObject(reply) && reply.ok === true && isPlaylistText(reply.text) ? reply.text : null;
    return { entry, text };
  } finally {
    clearTimeout(timer);
    refetching.delete(key);
  }
}

// aim (downloadFull only): {target, pick: {kind, index} | null}, a video that may
// not be the selected one and a pick from its fullOptions list for this one job.
async function onDownload(tabId, from, body, aim = null) {
  if (await browserOnly()) return downloadInBrowser(tabId, from, aim && aim.target);
  // A full clip never reads segs:<tabId>: its one segment comes from the plan below.
  // The page key is read with the segments, so a later navigation cannot relink them.
  let { segments, pageId } = body.full
    ? { segments: null, pageId: null }
    : await withTab(tabId, async () => ({
        segments: await readSegments(tabId),
        pageId: pageKeyOf((await chrome.storage.session.get(topKey(tabId)))[topKey(tabId)]),
      }));
  // Settings, protocol and the incognito default come from a pong: without one
  // the job cannot follow the user's incognito choice.
  const app = await fetchDeps(true);
  if (app.appError) return appFailure(app.appError);
  // Another app gets the whole video's link: no segments needed.
  if (otherAppMode(app)) return openInOtherApp(tabId, from, aim && aim.target);
  if (segments && !segments.length) return { ok: false, error: "no-segments" };
  const incognito = (await withTab(tabId, () => tabIncognito(tabId, from))).on || body.incognito;
  if (incognito && app.protocol < 2) return { ok: false, error: "app-outdated", message: INCOGNITO_NEEDS_UPDATE };
  const variantPick = aim && aim.pick && aim.pick.kind === "variants" ? aim.pick.index : null;
  // A job never uses a cached player probe: probe again now (blob: videos only).
  const target = aim ? aim.target : (await withTab(tabId, () => readHub(tabId))).selected;
  if (target) await ensureIntro(tabId, target, { fresh: true });
  const plan = await planSource(tabId, app.protocol, aim && aim.target, variantPick); // own withTab turns; never nest
  if (!plan) return { ok: false, error: "no-source" };
  // DRM (see "Send the job"): the player's own flag refuses the job; bare mediaKeys
  // only drops a page-first job's captured fallback. A pinned source skips both.
  const drm = plan.r.drm.player ? "player" : plan.r.drm.keys ? "keys" : null;
  const sourceKind = (s) => (s.type === "page" || s.type === "playlist" ? s.type : s.kind);
  const tags = ` via=${plan.r.via}${drm ? ` drm=${drm}` : ""}${plan.r.pageFrame ? " page=frame" : ""}`;
  if (drm && !plan.pinned) {
    if (drm === "player" || plan.source.type !== "page") {
      hubLog(`download tab=${tabId} kind=${sourceKind(plan.source)}${tags} error=drm`);
      return { ok: false, error: "drm" };
    }
    plan.fallback = null;
  }
  if (body.full) {
    // The end is the hub's own duration of the target video, never the message's.
    const d = plan.r.duration;
    if (!isFiniteNum(d) || !(d > 0)) return { ok: false, error: "no-duration" };
    if (app.settings.maxDuration !== null && d > app.settings.maxDuration) return { ok: false, error: "over-limit" };
    segments = [{ start: 0, end: d }];
  }
  // A hls capture the app was refused (its probe record says "unavailable", which the
  // host also answers while the app is not running: then one extra, usually cached,
  // GET): the frame that played it fetches it again and the text goes as a playlist.
  const slot = plan.fallback ? "fallback" : "source";
  const media = plan[slot];
  let refetched = "";
  if (
    media.type === "media" &&
    media.kind === "hls" &&
    app.protocol >= PLAYLIST_PROTOCOL &&
    (await readProbeRec(tabId, media.url)).rec?.error?.code === "unavailable"
  ) {
    const got = await refetchPlaylist(tabId, media.url);
    if (got) {
      refetched = ` refetch=${got.text ? "ok" : "fail"}`;
      if (got.text) plan[slot] = { type: "playlist", text: got.text, baseURL: got.entry.url, headers: copyHeaders(got.entry.headers) };
    }
  }
  const title = await tabTitle(tabId, from);
  const mode = body.mode || app.settings.mode;
  // precision is required on the wire, but the app replaces it with its own setting.
  const job = { source: plan.source, title, segments: segments.map(({ start, end }) => ({ start, end })), mode, precision: "precise" };
  if (plan.fallback) job.fallback = plan.fallback;
  const page = heightsPage(plan, app.protocol); // the page attempt only, never the fallback
  if (page) {
    // A heights pick: 0 = Best, else that height. Another video never reads (nor
    // drops) the selected video's chooseHeight choice.
    const heightPick = aim && aim.pick && aim.pick.kind === "heights" ? aim.pick.index : null;
    let height;
    if (heightPick !== null) height = heightPick ? (await readProbeRec(tabId, page)).list[heightPick - 1] : null;
    else {
      const { choice } = plan.r.own ? await readHeights(tabId, page) : { choice: null };
      height = choice ? choice.height : plan.r.variantChosen ? null : app.settings.preferredHeight;
    }
    if (height) job.maxHeight = height;
  }
  if (plan.r.duration !== null) job.mediaDuration = plan.r.duration;
  // The Downloads card links to the page the user watched: the top URL when a subframe's was used.
  const cardURL = plan.r.pageFrame ? plan.r.topURL : plan.r.pageURL;
  if (cardURL) job.pageURL = cardURL;
  if (incognito) job.incognito = true;
  const result = await enqueueNative(job);
  hubLog(`download tab=${tabId} kind=${sourceKind(plan.source)}${plan.fallback ? `+${sourceKind(plan.fallback)}` : ""}${refetched}${tags} segments=${segments.length}${job.maxHeight ? ` maxHeight=${job.maxHeight}` : ""} ${result.ok ? "enqueued" : `error=${result.code || result.error}`}`);
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
    fetchStatus(); // the running badge counts the new job
  }
  return result;
}

// --- Browser mode and Another app (rules under "Browser mode" and "Send the job" in the protocol) ---

// The app's last pong (a fetchDeps result, or null) has Another app on and speaks openWith.
const otherAppMode = (app) =>
  Boolean(app && !app.appError && app.settings && app.settings.downloadWith === "otherApp" && app.protocol >= OPEN_WITH_PROTOCOL);

// Pure: the resolved media is the whole stream: the video's own http currentSrc or the
// user's chooseSource pick, or a playlist or manifest. An mp4 / file from the capture
// tiers or the player probe is not: on MSE sites it is one ranged track (video or audio).
function directMedia(r) {
  if (!r || r.source.type !== "media") return false;
  return r.via === "currentSrc" || r.via === "user" || r.source.kind === "hls" || r.source.kind === "dash";
}

// "hls" | "dash" | "mp4" | "file" | "page" | "playlist".
const kindOf = (r) => (r.source.type === "media" ? r.source.kind : r.source.type);

// Pure: the lowercased extension of url's last path component (".webm"), else "".
function urlExt(url) {
  const u = httpURL(url);
  const name = u ? u.pathname.slice(u.pathname.lastIndexOf("/") + 1) : "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

// Pure: a file name base from the tab title: / \ : * ? " < > | and control characters
// become spaces, runs of spaces collapse, no leading or trailing dots or spaces, at
// most MAX_SAVE_BASE code points; empty -> "video".
function saveBase(title) {
  const trim = (t) => t.replace(/^[. ]+|[. ]+$/g, "");
  const cleaned = trim(title.replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, " ").replace(/ {2,}/g, " "));
  return trim([...cleaned].slice(0, MAX_SAVE_BASE).join("")) || "video";
}

// Pure: "SegDown/<base><ext>" for chrome.downloads (ext: the URL's when it is one of
// SAVE_EXTS, else ".mp4" for kind mp4), or null for a file of another extension (no
// filename: the browser names it from the response).
function saveName(title, url, kind) {
  const ext = urlExt(url);
  if (SAVE_EXTS.includes(ext)) return `SegDown/${saveBase(title)}${ext}`;
  return kind === "mp4" ? `SegDown/${saveBase(title)}.mp4` : null;
}

// The player probe Download makes (see onDownload): fresh, for target or the selected video.
async function freshIntro(tabId, target) {
  const t = target || (await withTab(tabId, () => readHub(tabId))).selected;
  if (t) await ensureIntro(tabId, t, { fresh: true });
}

// Browser mode's Download and Download full video: the whole file, saved by the
// browser (no job, no jobs:<tabId>, no native call). target: see onDownload's aim.
async function downloadInBrowser(tabId, from, target) {
  await freshIntro(tabId, target);
  const r = await resolveSource(tabId, target);
  const kind = r ? kindOf(r) : "none";
  const done = (reply) => {
    hubLog(`download tab=${tabId} with=browser kind=${kind} ${reply.ok ? `saved=${reply.saved}` : `error=${reply.error}`}`);
    return reply;
  };
  if (!r) return done({ ok: false, error: "no-source" });
  if (kind === "playlist") return done({ ok: false, error: "inline-only" });
  if (!directMedia(r) || (kind !== "mp4" && kind !== "file")) return done({ ok: false, error: "copy-only" });
  // Chrome's spanning worker belongs to the normal profile: the file would land there.
  if ((await withTab(tabId, () => tabIncognito(tabId, from))).forced) return done({ ok: false, error: "private-window" });
  const url = r.source.url;
  if (typeof chrome.downloads?.download !== "function") {
    // No downloads API (Safari): the file opens in a new tab, where the browser's Save works.
    try {
      await chrome.tabs.create({ url });
    } catch {
      return done({ ok: false, error: "browser-download" });
    }
    return done({ ok: true, saved: "tab" });
  }
  // No headers option: the browser refuses Referer, Origin, Cookie and User-Agent there.
  const options = { url, saveAs: false, conflictAction: "uniquify" };
  const save = (o) => Promise.resolve().then(() => chrome.downloads.download(o)).then(() => true, () => false);
  const filename = saveName(await tabTitle(tabId, from), url, kind);
  // A refused filename (invalid on this system): once more without one.
  const started = (filename !== null && (await save({ ...options, filename }))) || (await save(options));
  return done(started ? { ok: true, saved: "browser" } : { ok: false, error: "browser-download" });
}

// Pure: a POSIX single-quoted shell word ('\'' for a quote), so a pasted value never runs code.
const shq = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// Pure: the copyText text for what ("link" | "ytdlp" | "ffmpeg"), resolved source r and
// the tab's title -> {ok: true, text} | {ok: false, error: "copy-only" | "bad-url"}.
// Headers: Referer, User-Agent and Origin only; never Cookie (every app reads the clipboard).
function copyCommand(what, r, title) {
  const { source } = r;
  const direct = directMedia(r);
  if (what === "ffmpeg" && !direct) return { ok: false, error: "copy-only" };
  // yt-dlp gets the page, never one MSE track (planSource's page-first rule).
  const url = what === "ytdlp" && !direct && r.pageURL ? r.pageURL : source.url;
  const h = isObject(source.headers) ? source.headers : {};
  const header = (name) => (typeof h[name] === "string" && h[name] ? h[name] : null);
  const [referer, agent, origin] = [header("Referer"), header("User-Agent"), header("Origin")];
  if ([url, referer, agent, origin].some((v) => v !== null && /[\u0000-\u001f\u007f]/.test(v))) {
    return { ok: false, error: "bad-url" };
  }
  if (what === "link") return { ok: true, text: url };
  const words = [];
  if (what === "ytdlp") {
    words.push("yt-dlp");
    if (referer) words.push("--referer", shq(referer));
    if (agent) words.push("--user-agent", shq(agent));
    if (origin) words.push("--add-header", shq(`Origin:${origin}`));
    words.push(shq(url));
  } else {
    // mp4 for hls and mp4; a file keeps its own container (VP8 does not fit in mp4), mkv when unknown.
    const ext = source.kind !== "file" ? ".mp4" : SAVE_EXTS.includes(urlExt(url)) ? urlExt(url) : ".mkv";
    words.push("ffmpeg");
    if (agent) words.push("-user_agent", shq(agent));
    if (referer) words.push("-referer", shq(referer));
    if (origin) words.push("-headers", shq(`Origin: ${origin}`));
    words.push("-i", shq(url), "-c", "copy", shq(`./${saveBase(title)}${ext}`));
  }
  return { ok: true, text: words.join(" ") };
}

// copyText (Browser mode only): the selected video's link, or a command, for the clipboard.
async function onCopyText(tabId, from, { what }) {
  if (!(await browserOnly())) return { ok: false, error: "bad-message" };
  await freshIntro(tabId, null);
  const r = await resolveSource(tabId);
  const kind = r ? kindOf(r) : "none";
  let result;
  if (!r) result = { ok: false, error: "no-source" };
  else if (kind === "playlist") result = { ok: false, error: "inline-only" };
  // ffmpeg has no dash demuxer here, and a page needs yt-dlp.
  else if (what === "ffmpeg" && !["hls", "mp4", "file"].includes(kind)) result = { ok: false, error: "bad-message" };
  else result = copyCommand(what, r, await tabTitle(tabId, from));
  hubLog(`copy tab=${tabId} what=${what} kind=${kind}${result.ok ? "" : ` error=${result.error}`}`);
  return result;
}

// openWith (Another app): only the URL goes to the app, never headers or Cookie.
async function openWithNative(url) {
  let reply;
  try {
    reply = await sendNative({ type: "openWith", url });
  } catch {
    return { ok: false, error: "app-unreachable", message: APP_UNREACHABLE };
  }
  if (isObject(reply) && reply.type === "opened" && typeof reply.app === "string") {
    return { ok: true, opened: cleanAppName(reply.app) || "the chosen app" };
  }
  if (isObject(reply) && reply.type === "error" && typeof reply.code === "string") {
    const text = typeof reply.message === "string" ? reply.message.slice(0, MAX_MESSAGE_CHARS) : "";
    return { ok: false, error: "app-error", code: reply.code.slice(0, 32), message: text || "SegDown could not open the link." };
  }
  return { ok: false, error: "app-error", code: "internal", message: "Unexpected reply from the SegDown app." };
}

// Another-app mode's Download and Download full video: the app opens the whole video's
// link in the app the user chose. The media URL only when it is the whole stream, else
// the page URL. No job, no jobs:<tabId>. target: see onDownload's aim.
async function openInOtherApp(tabId, from, target) {
  await freshIntro(tabId, target);
  const r = await resolveSource(tabId, target);
  const kind = r ? kindOf(r) : "none";
  let result;
  if (!r) result = { ok: false, error: "no-source" };
  else if (kind === "playlist") result = { ok: false, error: "inline-only" };
  // A private window's link never leaves the browser.
  else if ((await withTab(tabId, () => tabIncognito(tabId, from))).forced) result = { ok: false, error: "private-window" };
  else result = await openWithNative(directMedia(r) ? r.source.url : r.pageURL || r.source.url);
  hubLog(`download tab=${tabId} with=otherApp kind=${kind} ${result.ok ? "opened" : `error=${result.code || result.error}`}`);
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
    warning: typeof s.warning === "string" && s.warning ? s.warning.slice(0, MAX_MESSAGE_CHARS) : null,
  };
}

// The status port: one connectNative port, replies matched to requests in order.
const statusPort = { port: null, pending: [], idleTimer: null, fallbackNext: false };
// Safari (the only target besides Firefox with globalThis.browser) hands port messages to the
// appex but never routes its replies back to the port, so status always uses sendNativeMessage there.
const HAS_STATUS_PORT = typeof chrome.runtime.connectNative === "function"
  && (typeof globalThis.browser === "undefined" || IS_FIREFOX);

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

// Running badge (see the protocol): the global text, and the poll while it counts jobs.
let activeBadge = null;
let activePoll = null;

function showActiveJobs(jobs) {
  const count = jobs.filter((j) => j.state === "queued" || j.state === "running").length;
  const text = count ? String(count) : "";
  if (text !== activeBadge) {
    activeBadge = text;
    chrome.action.setBadgeText({ text }).catch(() => {});
  }
  clearTimeout(activePoll);
  activePoll = count ? setTimeout(fetchStatus, ACTIVE_POLL_MS) : null;
}

// Not every browser has a badge color or text color: then the defaults stay.
try {
  chrome.action.setBadgeBackgroundColor({ color: ACTIVE_BADGE_COLOR }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ color: "#FFFFFF" }).catch(() => {});
} catch {
  // unsupported
}

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
  // Browser mode: no status call and no port; the running badge clears (and its poll stops).
  if (await browserOnly()) {
    showActiveJobs([]);
    return { error: BROWSER_ONLY };
  }
  const msg = { type: "status" };
  let reply;
  try {
    if (statusPort.fallbackNext || !HAS_STATUS_PORT) {
      statusPort.fallbackNext = false;
      reply = await sendNative(msg);
    } else {
      reply = await portRequest(msg);
    }
  } catch {
    showActiveJobs([]);
    return { error: APP_UNREACHABLE };
  }
  if (isObject(reply) && reply.type === "status" && Array.isArray(reply.jobs)) {
    lastJobs = reply.jobs.map(cleanJobStatus).filter(Boolean);
    showActiveJobs(lastJobs);
    await applyDownloaded(lastJobs).catch(hubWarn);
    return { jobs: lastJobs };
  }
  showActiveJobs([]);
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
  const unknown = (id) => ({ id, state: "unknown", segmentIndex: 0, segmentCount: 0, fraction: 0, message: null, outputs: [], bytes: null, fallbackUsed: false, warning: null });
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
    reply = await sendNative({ type: "cancel", id });
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
  // Browser mode asks the app nothing. Read again after the ping: its pong may have
  // just turned Browser mode on (the user picked Browser only in the app).
  let browser = await browserOnly();
  const app = browser ? null : await fetchDeps();
  if (!browser) browser = await browserOnly();
  const settings = (!browser && app.settings) || cleanSettings(null);
  // Before the segments are read: its status call may flag downloaded ones.
  const newest = browser ? null : (await onJobs(tabId)).jobs[0];
  // No tab jobs (e.g. reloaded before the job finished): ask the app for this page's pending one.
  if (!browser && !newest && (await pageJobPending(tabId))) await fetchStatus();
  const { hub, segments, cands, entries, inc } = await withTab(tabId, async () => ({
    hub: await readHub(tabId),
    segments: await readSegments(tabId),
    cands: await readCands(tabId),
    entries: (await chrome.storage.session.get({ [capKey(tabId)]: [] }))[capKey(tabId)],
    inc: await tabIncognito(tabId, from),
  }));
  const protocol = browser || app.appError ? null : app.protocol;
  // Browser mode: the resolved source as is (no page first) and no probe.
  const plan = browser ? null : await planSource(tabId, protocol);
  const r = browser ? await resolveSource(tabId) : plan && plan.r;
  const source = browser ? summarizeSource(r) : plan ? await describeSource(tabId, plan.r) : null;
  if (source && source.variants) source.variants = source.variants.map((v) => ({ ...v, label: variantLabel(v) }));
  // The overlay's HLS Quality section wins; else the page's heights (Page resolution picker).
  const hlsQuality =
    source &&
    source.kind === "hls" &&
    ((Array.isArray(source.variants) && source.variants.length > 1) ||
      (source.probe && (source.probe.state === "pending" || source.probe.state === "error")));
  const page = heightsPage(plan, protocol);
  if (source && page && !hlsQuality) {
    if (hub.panelOpen) startPageProbe(tabId, page);
    const { rec, list, choice } = await readHeights(tabId, page);
    if (!rec) source.heightProbe = { state: "pending" };
    else {
      const height = choice ? (choice.height ? 1 + list.indexOf(choice.height) : 0) : 1 + preferredIndex(list, settings.preferredHeight);
      Object.assign(source, { heights: list, height });
    }
  }
  const list = sourceList(Array.isArray(entries) ? entries : [], browser);
  const sourceIndex = r && r.source.type === "media" ? list.findIndex((e) => e.url === r.source.url) : -1;
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
    fullClipConfirm: settings.fullClipConfirm,
    overLimit,
    maxDuration: settings.maxDuration, // null = no limit
    job: newest
      ? (({ id, state, segmentIndex, segmentCount, fraction, bytes, message, fallbackUsed, warning }) =>
          ({ id, state, segmentIndex, segmentCount, fraction, bytes, message, fallbackUsed, warning }))(newest)
      : null,
  };
  if (browser) {
    const kind = r ? kindOf(r) : null;
    const direct = directMedia(r);
    reply.downloadWith = "browser";
    reply.saveable = direct && (kind === "mp4" || kind === "file");
    reply.copy = !r || kind === "playlist" ? [] : direct && kind !== "dash" ? ["link", "ytdlp", "ffmpeg"] : ["link", "ytdlp"];
    if (kind === "playlist") reply.inlineOnly = true;
    return reply;
  }
  // The app's "browser" while the extension is not in Browser mode counts as "segdown".
  const other = otherAppMode(app);
  reply.downloadWith = other ? "otherApp" : "segdown";
  reply.otherApp = other ? settings.otherAppName : null;
  // Another app needs no tool: it gets the link only.
  const problem = other ? null : depsProblem(app.missing, plan);
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
    case "cancelStart":
      return onCancelStart(tabId);
    case "seek":
    case "getTime":
    case "play":
    case "pause":
      return toSelected(tabId, { type, ...body });
    case "select":
      return onSelect(tabId, body);
    case "openOverlay":
      return onOpenOverlay(tabId, frameId, body);
    case "fullOptions":
      return onFullOptions(tabId, frameId, body);
    case "downloadFull":
      downloadsInFlight++;
      return onDownloadFull(tabId, frameId, body, from).finally(() => {
        downloadsInFlight--;
      });
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
    case "chooseHeight":
      return onChooseHeight(tabId, body);
    case "download":
      downloadsInFlight++;
      return onDownload(tabId, from, body).finally(() => {
        downloadsInFlight--;
      });
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
    case "ignoreSite":
      return setSiteIgnored(tabId, true);
    case "setDownloadWith":
      return onSetDownloadWith(tabId, body);
    case "copyText":
      return onCopyText(tabId, from, body);
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
  if (sender.documentLifecycle === "prerender") return undefined; // not shown yet (Chrome 106+)
  const tabId = sender.tab && sender.tab.id;
  if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(sender.frameId) || sender.frameId < 0) {
    return undefined;
  }
  const from = { tabTitle: sender.tab.title, tabIncognito: sender.tab.incognito === true };
  return replyAsync(hubDispatch(tabId, sender.frameId, msg, from), sendResponse);
});

// Chrome does not inject the manifest's content_scripts into tabs already open at
// install/update; this does, in the manifest's order (overlay and button read the
// agent's globalThis.segdownAgent). Firefox may inject them itself: the content
// scripts' own guard makes the second injection a no-op. storage.session was wiped,
// so each tab's top URL and saved segments come back first. Restricted pages (the
// Web Store) throw; one tab never stops the others. Some Safari builds lack scripting.
async function injectOpenTabs() {
  if (typeof chrome.scripting?.executeScript !== "function") return;
  const tabs = await chrome.tabs.query({});
  const open = tabs.filter((tab) => Number.isInteger(tab.id) && httpURL(tab.url) && !tab.discarded);
  await Promise.all(
    open.map(async (tab) => {
      try {
        await setTopURL(tab.id, tab.url);
        await restoreSegments(tab.id);
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["content/agent.js", "content/overlay.js", "content/button.js"],
        });
      } catch (err) {
        hubWarn(err);
      }
    })
  );
}

// The app's settings as soon as the extension is installed or updated, not only
// when the overlay first opens. Not on a browser update ("chrome_update"): the
// ping launches the app.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  setupActionMenu();
  if (reason === "install" || reason === "update") {
    fetchDeps().catch(hubWarn);
    injectOpenTabs().catch(hubWarn);
  }
});

// A subframe that navigates takes its videos with it (top-frame navigation clears
// the whole tab in the capture section). A prerendered page's outermost frame has
// frameId > 0 but is not a subframe (frameType; Firefox and Safari have none).
chrome.webNavigation.onCommitted.addListener((details) => {
  const sub = details.frameType ? details.frameType === "sub_frame" : details.frameId > 0;
  if (sub) dropFrame(details.tabId, details.frameId);
});

// Safari has no onHistoryStateUpdated: SPA navigations there keep the old page key.
chrome.webNavigation.onHistoryStateUpdated?.addListener((details) => {
  if (!isActiveTop(details)) return;
  setTopURL(details.tabId, details.url)
    .then(() => refreshActionMenu())
    .catch(hubWarn);
  const at = Number.isFinite(details.timeStamp) ? details.timeStamp : Date.now();
  onPageChanged(details.tabId, details.url, at).catch(hubWarn);
});

// Content scripts never reach storage.local; only this worker reads and writes it.
// Not every browser supports an access level for storage.local; then this only logs.
try {
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(hubWarn);
} catch (err) {
  hubWarn(err);
}

// A short toolbar badge on tabId, cleared after NO_VIDEO_BADGE_MS. null hands the
// tab back to the global (running) badge; a browser that refuses null gets "".
function flashBadge(tabId, text) {
  const badge = (t) => chrome.action.setBadgeText({ tabId, text: t });
  badge(text).catch(() => {});
  setTimeout(() => badge(null).catch(() => badge("").catch(() => {})), NO_VIDEO_BADGE_MS);
}

// Overlay toggle: the toolbar button and the "toggle-panel" shortcut (see the protocol).
async function toggleOverlay(tabId) {
  if (await tabIgnored(tabId, (await readUI()).ignoredDomains)) {
    // The list may have changed in the app: ask it first. The pong's own settings;
    // without them (Browser mode, a failing app) the stored list.
    const deps = await fetchDeps().catch(() => ({}));
    const domains = deps.settings ? deps.settings.ignoredDomains : (await readUI()).ignoredDomains;
    if (await tabIgnored(tabId, domains)) return flashBadge(tabId, "off");
  }
  const { state } = await setPanelOpen(tabId, null);
  if (state.selected) return notifyOverlay(tabId, state.selected.frameId, { type: "toggleOverlay", open: state.panelOpen });
  // No video to open the overlay on: a short badge says so.
  flashBadge(tabId, "none");
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

// Toolbar menu (see the protocol). Safari may have no contextMenus or no "action"
// context: then there is no menu (lastError is read, never thrown).
const ACTION_MENU = typeof chrome.contextMenus?.create === "function";
const MENU_IDS = ["site-off", "site-on"];
const menuDone = () => void chrome.runtime.lastError; // read, so Chrome does not report it as unchecked

// The two items, hidden until refreshActionMenu shows the active tab's one.
function setupActionMenu() {
  if (!ACTION_MENU) return;
  try {
    chrome.contextMenus.removeAll(() => {
      menuDone();
      try {
        for (const id of MENU_IDS) {
          const title = id === "site-off" ? "Turn off SegDown on this site" : "Turn on SegDown on this site";
          chrome.contextMenus.create({ id, title, contexts: ["action"], visible: false }, menuDone);
        }
        refreshActionMenu().catch(hubWarn);
      } catch (err) {
        hubWarn(err);
      }
    });
  } catch (err) {
    hubWarn(err);
  }
}

function updateMenuItem(id, props) {
  try {
    chrome.contextMenus.update(id, props, menuDone);
  } catch (err) {
    hubWarn(err);
  }
}

// IgnoredDomain.site: without a leading "www." when the rest still has a dot.
const siteOf = (host) => (host.startsWith("www.") && host.slice(4).includes(".") ? host.slice(4) : host);

// Shows the item for the active tab of the last-focused window: none without an
// http(s) top URL or in Browser mode (the list lives in the app), else "Turn off"
// (not ignored) or "Turn on" (ignored).
async function refreshActionMenu() {
  if (!ACTION_MENU) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const ui = await readUI();
  const host = !ui.browserOnly && tab && Number.isInteger(tab.id) && tab.id >= 0 ? await topHost(tab.id) : null;
  const domain = host && ui.ignoredDomains.find((d) => host === d || host.endsWith(`.${d}`));
  updateMenuItem("site-off", host && !domain ? { visible: true, title: `Turn off SegDown on ${siteOf(host)}` } : { visible: false });
  updateMenuItem("site-on", domain ? { visible: true, title: `Turn on SegDown on ${domain}` } : { visible: false });
}

chrome.runtime.onStartup.addListener(setupActionMenu);

if (ACTION_MENU) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!MENU_IDS.includes(info.menuItemId) || !tab || !Number.isInteger(tab.id) || tab.id < 0) return;
    const tabId = tab.id;
    setSiteIgnored(tabId, info.menuItemId === "site-off")
      .then((r) => flashBadge(tabId, r.ok ? (r.ignored ? "off" : "on") : "!"))
      .catch((err) => {
        hubWarn(err);
        flashBadge(tabId, "!");
      });
  });
  chrome.tabs.onActivated.addListener(() => refreshActionMenu().catch(hubWarn));
  chrome.windows?.onFocusChanged?.addListener(() => refreshActionMenu().catch(hubWarn));
}

// --- debug (service-worker console only) ---

// segdownDebugSeek(tabId, seconds): seeks the selected video (the auto-picked
// main video unless the user chose one). Goes through hubDispatch as that video's frame.
async function segdownDebugSeek(tabId, time) {
  const { selected } = await withTab(tabId, () => readHub(tabId));
  return selected ? hubDispatch(tabId, selected.frameId, { type: "seek", time }) : { ok: false, error: "no-selection" };
}
