# SegDown
Download video as segments from the internet.

## What it is

SegDown is a macOS menu bar app plus a browser extension: mark time ranges on a video in the browser, and only those ranges are downloaded. The repo holds the core package (`Packages/SegDownCore`), a dev CLI (`segdown-cli`), the menu bar app with its native messaging host (`segdown-host`), and a browser extension (Chromium, and Safari through the app's embedded Safari Web Extension) that marks segments on a page's video and sends them to the app as download jobs.

- Direct media (mp4) and HLS streams, including clear-key AES-128 HLS, are cut with `ffmpeg`. Pages that `yt-dlp` supports go through `yt-dlp`.
- Each range is saved as its own file, or all ranges are joined into one merged mp4.
- Precise mode (default) re-encodes, so cuts land exactly on the marked times. Fast mode copies the streams without re-encoding, so cuts land on the nearest keyframes.

## Requirements

- macOS 14 or later
- Xcode with Swift 6
- Homebrew tools (looked up in `/opt/homebrew/bin` and `/usr/local/bin`):

  ```sh
  brew install yt-dlp ffmpeg deno xcodegen
  ```

## Build the app

The Xcode project is generated from `project.yml` by XcodeGen; `SegDown.xcodeproj` is gitignored.

```sh
xcodegen generate
xcodebuild -project SegDown.xcodeproj -scheme SegDown -configuration Debug build
```

Do not pass `-derivedDataPath`; without it the build lands in Xcode's own DerivedData folder, so Xcode and the command line reuse each other's builds. To find the built `SegDown.app`:

```sh
xcodebuild -project SegDown.xcodeproj -scheme SegDown -configuration Debug -showBuildSettings | grep -m1 BUILT_PRODUCTS_DIR
```

The app is ad-hoc signed, for personal use only. `segdown-host` is embedded in `SegDown.app/Contents/MacOS`.

## Menu bar app

SegDown runs as a menu bar item only (scissors icon, no Dock icon). Its window shows:

- Dependencies: whether `yt-dlp`, `ffmpeg`, `ffprobe` and `deno` are found, with a `brew install …` line for the missing ones, and a Re-check button.
- Browser integration: the browsers that have the native messaging host manifest, and the "Install browser integration" button.
- Jobs: title, state, progress per segment, Cancel, and Show in Finder for the output files; Clear finished removes finished jobs.
- Default precision: Precise or Fast. It is only stored for now; each job carries its own precision.
- Quit SegDown.

## Browser integration (Chromium)

1. Copy `SegDown.app` to `/Applications` and open it from there.
2. In Chrome, open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the `extension/` folder. The `key` in `extension/manifest.json` fixes the extension ID to `kigkemeomlcgfgnknafeomgglcjeoicb`. Reload the pages that were open before you loaded or reloaded the extension: Chrome does not inject content scripts into tabs that are already open.
3. In the SegDown menu, click "Install browser integration". It writes `com.math2it.segdown.json` into the `NativeMessagingHosts` folder of each installed Chromium browser (Chrome, Chromium, Brave, Edge, Arc) under `~/Library/Application Support/`, pointing at the app's embedded `segdown-host`.

The manifest holds the app's absolute path, so install again after moving the app; the menu warns when the installed path is stale. When the app is not running, `segdown-host` launches it hidden.

To check the connection to the app, open the extension's service worker console (`chrome://extensions` → SegDown → service worker) and run:

```js
chrome.runtime.sendNativeMessage("com.math2it.segdown", {type: "ping"}, console.log)
```

It logs the app version and the missing tools.

## Browser integration (Safari)

The same extension ships inside `SegDown.app` as a Safari Web Extension (`SegDownSafari.appex`, built from `extension/`). It is ad-hoc signed, so Safari treats it as unsigned:

1. Copy `SegDown.app` to `/Applications` and open it once, so macOS registers the extension.
2. In Safari, open Settings › Advanced and turn on "Show features for web developers".
3. In Settings › Developer, turn on "Allow unsigned extensions" (asks for your password). Safari turns this off again every time it quits, so repeat this step after each Safari restart.
4. In Settings › Extensions, tick SegDown. If it is not listed, close and reopen the Settings window, or quit and reopen `SegDown.app`. After replacing `SegDown.app` with a new build, untick and tick SegDown once, so Safari reloads the extension.
5. Grant website access: in the same pane, "Always Allow on Every Website…" (or allow sites one by one from the toolbar button). Without it the extension sees no media requests and runs no content scripts.

The Safari extension talks to the app directly, without `segdown-host`: each `sendNativeMessage` goes to the appex, which relays it over the same Unix socket and launches the app hidden when it is not running. The appex is sandboxed; a `com.apple.security.temporary-exception.sbpl` entitlement allows it to connect to `~/Library/Application Support/SegDown/segdown.sock` and nothing else.

To check the connection, open Develop › Web Extension Background Content › SegDown and run:

```js
await browser.runtime.sendNativeMessage("com.math2it.segdown", {type: "ping"})
```

Known limits in Safari:

- Usually no `Cookie` header: Safari's `webRequest` has no `extraHeaders` option, so the captured headers normally lack cookies and sites that need a login cookie for their media links fail with HTTP 403. Use "Use yt-dlp (page URL)" where `yt-dlp` supports the site.
- Media capture is best effort; when a source is missing, play the video again or use "Use yt-dlp (page URL)".
- Content scripts can read the extension's local storage (saved segments per page URL): Safari has no `storage.local.setAccessLevel`.
- Single-page sites that change the URL without reloading keep the previous URL's segments (no `webNavigation.onHistoryStateUpdated` in Safari).
- Job progress is read with one native call per second instead of one open connection.
- The frame label in the panel shows Safari's long frame ids.

### Using the panel

The toolbar button opens the SegDown popup: its Toggle panel button (or Alt+Shift+S) shows or hides a floating panel (drag it by its title bar). The popup also lists this tab's jobs and the app's other recent jobs with their progress, errors, a Cancel button for queued and running jobs, and the file names of finished ones (open them from the SegDown menu bar).

- Video: the panel picks the page's main video across all frames, including players in cross-origin iframes. Videos smaller than 200×112, videos inside ad containers and live streams are not picked automatically (a live stream shows as live and cannot be marked). When the page has several videos, a picker lets you choose another one; small and ad videos are listed with the reason and can still be chosen.
- Timeline: a mini timeline shows the playhead and the segments; click it to seek.
- Mark start / Mark end: mark a range at the video's current time. The end must be after the start.
- Segments: the list is kept sorted. Edit a start or end as `h:mm:ss.s`, `mm:ss.s` or `ss.s`, jump to a segment's start, or delete it. Clear removes all segments after an inline "Clear? Yes / No". Overlapping segments get a warning. At most 100 segments.
- Output: Separate (one file per segment) or Merged (one mp4). Cut: Precise (default) or Fast.
- Sources: the media requests captured in the tab (MP4, HLS, and a count of loaded stream chunks per frame). Click one to download from it instead of the chosen source.
- Jobs: below Download, this tab's jobs with their state, segment, progress, errors (for example an expired media link) and a Cancel button. Jobs run in the app, so closing the panel, the popup or the tab does not stop them.

Segments, output and cut are saved per page URL (without the `#hash`) and come back when the page reloads. On sites that change the URL without reloading (single-page apps), the panel switches to the new URL's segments and a pending start is dropped.

Fullscreen: when a player fullscreens its container, a compact panel (timeline, Mark start, Mark end) appears inside it. When a player fullscreens the bare `<video>`, or a page fullscreens the iframe that holds the player, there is no panel: use the keys and see the marks after leaving fullscreen.

### Download segments

1. Open the page and play the video, so the browser loads its media and the extension captures the request.
2. Open the panel: toolbar button → Toggle panel, or Alt+Shift+S.
3. Mark the segments (Mark start / Mark end, or `[` / `]`).
4. Check the Source line: kind, host and file, frame, and how it was chosen. If it is wrong, click another entry in Sources.
5. For an HLS master playlist, pick a Quality (the highest is preselected).
6. Choose Output (Separate or Merged) and Cut (Precise or Fast).
7. Optional: tick "Use yt-dlp (page URL)" to send the page URL to `yt-dlp` instead of the captured media. `yt-dlp` gets only the URL, no captured headers or cookies.
8. Click Download. Follow the progress in the panel's Jobs or in the popup, and cancel a job there.

Files land in `~/Downloads/SegDown/<page title>/`: `<page title> - 01 [0h00m02s-0h00m04s].mp4` per segment, or `<page title> - merged.mp4`. When a file with that name exists, the new one gets ` (2)`, ` (3)`… before the extension. Open them from the SegDown menu bar (Jobs → Show in Finder).

### Keyboard shortcuts

- `[` marks a start, `]` marks an end. They work only while the panel is open, also when the player inside an iframe has focus. They are ignored while you type in a text field, and with Ctrl, Cmd or Alt held. On keyboard layouts where `[` and `]` need Option (for example German on a Mac), use the panel buttons.
- Alt+Shift+S shows or hides the panel. Change it in `chrome://extensions/shortcuts`, or in Safari Settings › Extensions › SegDown.

### Permissions

- `nativeMessaging`: talk to the SegDown app through `segdown-host`: send download jobs, read HLS qualities, and read job progress or cancel a job. Only the service worker uses it. While the panel or the popup shows a running job, progress is read every second over one open connection, which closes a few seconds after nothing needs it.
- `storage`: segments, output and cut choices and the panel position in local storage, which only the service worker reads and writes (the panel asks it for the current page's entry); captured requests and per-tab panel state in session storage, which only the extension's trusted contexts can read.
- `webRequest`: see the page's media requests (mp4, HLS) and their `Referer`, `Origin`, `User-Agent` and `Cookie` headers, so the media can be downloaded later as the browser would. The header values stay in the service worker's session storage; they are never given to pages or content scripts.
- `webNavigation`: clear a tab's captures and panel state when it navigates, notice when a single-page site changes its URL, drop a frame's videos when that frame navigates, and record the top frame's URL for the yt-dlp page source.
- Host access to all sites (`<all_urls>`): capture media requests on any site and run the content scripts in every frame, including cross-origin player iframes.

## How it fits together

The extension talks to `segdown-host` through Chrome native messaging. The host accepts only the SegDown extension's origin and relays each message as one JSON line over a Unix socket, `~/Library/Application Support/SegDown/segdown.sock` (folder 0700, socket 0600; the app serves only processes of the same user). The menu bar app runs the jobs with `ffmpeg` and `yt-dlp`.

## Core package and CLI

Build and test the core package:

```sh
swift build --package-path Packages/SegDownCore
swift test --package-path Packages/SegDownCore
```

Check that the external tools are found (exits 1 if one is missing):

```sh
swift run --package-path Packages/SegDownCore segdown-cli --doctor
```

Usage (`--help` prints it):

```
segdown-cli --doctor
segdown-cli (--media URL [--hls] [--header "Name: value"]... | --page URL)
            --seg A-B [--seg A-B]... [--merged] [--fast] [--out DIR] [--title T]
```

Examples:

```sh
# Two ranges of an mp4 (in seconds), joined into one file
swift run --package-path Packages/SegDownCore segdown-cli \
  --media https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4 \
  --seg 2-4 --seg 6-8 --merged --title "Big Buck Bunny"

# Two ranges of an HLS stream with a Referer header, merged, fast mode
swift run --package-path Packages/SegDownCore segdown-cli \
  --media https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8 --hls \
  --header "Referer: https://test-streams.mux.dev/" \
  --seg 30-40 --seg 60-65 --merged --fast

# One range of a page supported by yt-dlp, into a custom folder
swift run --package-path Packages/SegDownCore segdown-cli \
  --page https://archive.org/details/BigBuckBunny_124 --seg 10-20 --out ~/Movies/SegDown
```

- `--seg A-B` is a range in seconds; repeat it for more ranges (up to 100). A range must end within 7 days (604800 s).
- `--header` accepts only `Referer`, `Origin`, `User-Agent` and `Cookie`, and only with `--media`.
- Files go to `~/Downloads/SegDown/<title>/` (title defaults to `segdown-cli`); `--out DIR` replaces `~/Downloads/SegDown`. Separate files are named `<title> - 01 [0h00m02s-0h00m04s].mp4`, a merged file `<title> - merged.mp4`. With `--page`, a separate file keeps the container yt-dlp picked (for example `.avi`).
- Ctrl+C cancels the running download.

## Troubleshooting

- Progress stays near 0% for a long time on a late segment of an mp4: the server does not support HTTP Range requests, so `ffmpeg` cannot seek and reads the file from the start up to the segment.
- "Media link expired or forbidden (HTTP 403/410). Play the video again and retry.": the captured link was tokenized or timed out. Play the video again and download right away.
- DRM (Widevine, FairPlay) is not supported: there is no media request to capture, or the output is encrypted and does not play.
- Wrong source picked: check the Source line before Download and pick another entry in Sources, or use "Use yt-dlp (page URL)" on sites `yt-dlp` supports.
- "SegDown app not reachable: install browser integration": copy `SegDown.app` to `/Applications` first, then click "Install browser integration" in the SegDown menu. Install again after moving the app. The `ping` check in [Browser integration (Chromium)](#browser-integration-chromium) tests the connection.
- Download disabled with a `brew install …` line: a tool the source needs is missing. Run the line, click Re-check in the SegDown menu, then reopen the panel. The extension caches the app's tool list for 30 seconds, so wait that long if the line stays.
- "The site refused the download (HTTP 403/410)…", or YouTube or another site blocks `yt-dlp`: run `brew upgrade yt-dlp`; YouTube also needs `deno` (`brew install deno`).
- Which hosts get a captured cookie: see the cookie note in [Not supported](#not-supported).

## Not supported

- DRM-protected video (Widevine, FairPlay)
- Live streams
- DASH (`.mpd`) manifests

Some sites (for example YouTube) may block `yt-dlp`; `brew upgrade yt-dlp` often helps.

A captured `Cookie` goes only to the media URL's own origin (scheme, host and port): ffmpeg gets it through `-cookies`, scoped with `domain=` to that host, and only for inputs on that origin, never through `-headers`; SegDown's own playlist request drops it when a redirect leaves the origin. Residual risks: if the server refreshes the cookie with a `Set-Cookie` that has no `Domain`, ffmpeg may send the refreshed cookie to hosts the site's own playlist or redirects point at (segments, keys, CDNs); ffmpeg matches `domain=` as a plain suffix, so such a host whose name ends with the media host's name (`evilexample.com` for `example.com`) gets the captured cookie too; the cookie is visible in `ps` to the same user while ffmpeg runs. `Referer`, `Origin` and `User-Agent` go to every host ffmpeg contacts for the download, as CDNs often require them.
