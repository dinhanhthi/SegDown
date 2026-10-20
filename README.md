# SegDown
Download video as segments from the internet.

## What it is

SegDown is a macOS app plus a browser extension: mark time ranges on a video in the browser, and only those ranges are downloaded. The repo holds the core package (`Packages/SegDownCore`), a dev CLI (`segdown-cli`), the app (one window and a menu bar item) with its native messaging host (`segdown-host`), and a browser extension (Chromium, and Safari through the app's embedded Safari Web Extension) that puts a segment bar on a page's video and sends the marked ranges to the app as download jobs.

- Direct media (mp4) and HLS streams, including clear-key AES-128 HLS, are cut with `ffmpeg`. Pages that `yt-dlp` supports go through `yt-dlp`; when the extension also captured the page's media, the app tries `yt-dlp` first and falls back to the captured media.
- Each range is saved as its own file, or all ranges are joined into one merged mp4.
- Precise mode (default) re-encodes, so cuts land exactly on the marked times. Fast mode copies the streams without re-encoding, so cuts land on the nearest keyframes. The mode is an app setting and applies to every job.
- Optional limits on a job's total duration and size, and incognito downloads that are not kept in the history.

## Requirements

- macOS 15 or later
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

## The app

SegDown has one window with its pages as tabs in the toolbar (Downloads, Settings, Dependencies, Browsers, About) and a menu bar item (the SegDown logo) whose menu shows the number of active (queued or running) downloads, then Open SegDown, Settings…, About SegDown and Quit SegDown. The Dock icon shows only while the window is open, with the number of active downloads in a red badge; closing the window keeps the app running in the menu bar, and jobs go on. When a browser needs the app and it is not running, `segdown-host` or the Safari extension launches it hidden (`--background`): no window and no Dock icon.

- Downloads: one card per job, newest first: title, Reveal in Finder, state (Queued, Running, Done, Failed, Cancelled), segment, total duration, size, a progress bar while it runs, "Switched to the captured media" when it fell back, the app's message and, until the job ends, Cancel. An incognito job has an eye icon. Click a card to select it, ⌘-click to add or remove one, ⇧-click to select a range, ⌘A to select all. The trash menu has Remove from List (or ⌫): running jobs are cancelled, the jobs leave the list and the history, and the files stay on disk; and Move to Trash…, which asks first, then does the same and moves the files to the Trash.
- Settings, saved on each change:
  - Output folder: `~/Downloads/SegDown` by default; Choose… picks another one.
  - Default output: Separate or Merged (default). The extension starts with it; the Download menu can change it per download.
  - Default precision: Precise (default) or Fast, for every job.
  - Auto fallback: on by default. If `yt-dlp` fails on a page, download the captured media instead.
  - Compress after download: off by default. On, each finished file (the merged file in Merged) is re-encoded with `ffmpeg` (H.264 CRF 28, AAC 128k) to make it smaller; it takes longer. If compression fails, the files are kept uncompressed.
  - Limit size: off by default. On, it sets Max size in MB or GB (1 GB when first turned on).
  - Limit total duration: off by default. On, it sets Max total duration as `h:mm:ss` or `m:ss`, for all the segments of a job (1:00:00 when first turned on).
  - Incognito by default: off by default. Jobs are not kept in history; the browser does not keep their segments.
  - History: Clear history… removes every finished download from the list and the history. Files stay on disk.
- Dependencies: whether `yt-dlp`, `ffmpeg`, `ffprobe` and `deno` are found (with their path) or Missing, a `brew install …` line for the missing ones, and a Re-check button.
- Browsers: for each Chromium browser (Chrome, Chromium, Brave, Edge, Arc), Installed, Not installed, or a Re-install warning when the app moved since the browser integration was installed, with "Last connected …" or "Not connected yet". The Browser integration row has the Install button (Reinstall once installed); Re-check refreshes the list. Under Safari, the SegDown extension shows On, Off or Unknown, with its last connection, and Open Safari Settings opens Safari's extension settings.
- About: the version, the license (MIT) and a link to the GitHub repository.

While the window is open, the app menu also has About SegDown, Settings… (⌘,), Hide SegDown and Quit SegDown.

## Browser integration (Chromium)

1. Copy `SegDown.app` to `/Applications` and open it from there.
2. In Chrome, open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the `extension/` folder. The `key` in `extension/manifest.json` fixes the extension ID to `kigkemeomlcgfgnknafeomgglcjeoicb`. Reload the pages that were open before you loaded or reloaded the extension: Chrome does not inject content scripts into tabs that are already open.
3. In the SegDown window, open Browsers and click Install. It writes `com.math2it.segdown.json` into the `NativeMessagingHosts` folder of each installed Chromium browser (Chrome, Chromium, Brave, Edge, Arc) under `~/Library/Application Support/`, pointing at the app's embedded `segdown-host`.

The manifest holds the app's absolute path, so click Reinstall after moving the app; the Browsers page warns when the installed path is stale. When the app is not running, `segdown-host` launches it hidden. To use SegDown in an Incognito window, also turn on "Allow in Incognito" in the extension's details.

To check the connection to the app, open the extension's service worker console (`chrome://extensions` → SegDown → service worker) and run:

```js
chrome.runtime.sendNativeMessage("com.math2it.segdown", {type: "ping"}, console.log)
```

It logs the app version, the missing tools, the protocol version and the settings the extension reads.

## Browser integration (Safari)

The same extension ships inside `SegDown.app` as a Safari Web Extension (`SegDownSafari.appex`, built from `extension/`). It is ad-hoc signed, so Safari treats it as unsigned:

1. Copy `SegDown.app` to `/Applications` and open it once, so macOS registers the extension.
2. In Safari, open Settings › Advanced and turn on "Show features for web developers".
3. In Settings › Developer, turn on "Allow unsigned extensions" (asks for your password). Safari turns this off again every time it quits, so repeat this step after each Safari restart.
4. In Settings › Extensions, tick SegDown (the Browsers page's Open Safari Settings goes there). If it is not listed, close and reopen the Settings window, or quit and reopen `SegDown.app`. After replacing `SegDown.app` with a new build, untick and tick SegDown once, so Safari reloads the extension.
5. Grant website access: in the same pane, "Always Allow on Every Website…" (or allow sites one by one from the toolbar button). Without it the extension sees no media requests and runs no content scripts.

The Browsers page shows the extension as On or Off (Unknown when Safari does not say). The Safari extension talks to the app directly, without `segdown-host`: each `sendNativeMessage` goes to the appex, which relays it over the same Unix socket and launches the app hidden when it is not running. The appex is sandboxed; a `com.apple.security.temporary-exception.sbpl` entitlement allows it to connect to `~/Library/Application Support/SegDown/segdown.sock` and nothing else.

To check the connection, open Develop › Web Extension Background Content › SegDown and run:

```js
await browser.runtime.sendNativeMessage("com.math2it.segdown", {type: "ping"})
```

Known limits in Safari:

- Usually no `Cookie` header: Safari's `webRequest` has no `extraHeaders` option, so the captured headers normally lack cookies and sites that need a login cookie for their media links fail with HTTP 403. On sites `yt-dlp` supports, leave Source and Quality in the Download menu as they are, so the page URL goes to `yt-dlp` first.
- Media capture is best effort; when a source is missing, play the video again. Without a captured source, the page URL goes to `yt-dlp`.
- Content scripts can read the extension's local storage (saved segments per page URL): Safari has no `storage.local.setAccessLevel`.
- Single-page sites that change the URL without reloading keep the previous URL's segments (no `webNavigation.onHistoryStateUpdated` in Safari).
- Job progress is read with one native call per second instead of one open connection.

### Using the overlay

Click the SegDown toolbar button, or press Alt+Shift+S, to show or hide the overlay on the page's main video; there is no popup. The overlay sits on the selected video, also inside cross-origin player iframes and in fullscreen. It closes when the page loads again or its video goes away, and × closes it. When no video is found yet, the button shows "none" for a moment: play the video and try again.

- Video: the extension picks the page's main video across all frames. Videos smaller than 200×112, videos inside ad containers and live streams are not picked (a live stream cannot be marked). When the page has several videos, the Video section of the Download menu lets you choose another one.
- Bar: a thin bar along the video's bottom edge shows the segments, a pending start and the playhead; click it to seek. The overlay hides after about 2 seconds without mouse movement over the video, unless a start is pending, the menu is open or a download runs; move the mouse over the video to bring it back.
- Mark start / Mark end: mark a range at the video's current time. Only one of them is enabled at a time: Mark start until a start is pending, then Mark end. The end must be after the start. At most 100 segments, kept sorted.
- Download: sends the marked segments to the app. It is disabled, with the reason under the buttons, when there is no segment, when the total is over the max total duration, when a tool is missing, or when the app does not answer.
- Download menu (▾ next to Download):
  - Output: "Separate files" or "Merged into one file"; it starts at the app's Default output.
  - Privacy: Incognito for this tab; it starts at Incognito by default. In a browser private window it shows as "Incognito (private window)" and stays on.
  - Quality: for an HLS master playlist, its variants by size and bitrate; the highest is preselected.
  - Source: when the tab captured several media requests (kind, host and file). Click one to download from it instead.
  - Video: when the page has several videos, by size and duration.
  - Segments: each segment's start and end, with × to delete it, and "Clear all segments".
- Status line: the number of segments and their total duration, the pending start, or the last error.
- Progress line: while a job of this tab runs, its segment, percentage and size ("Segment 2/3 · 40% · 12.5 MB"), "Switched to the captured media" when it fell back, and the app's message; then Done, Failed or Cancelled. Jobs run in the app, so closing the overlay or the tab does not stop them; cancel them on the app's Downloads page.

Segments are saved per page URL (without the `#hash`) and come back when the page reloads, except in incognito (see [How it fits together](#how-it-fits-together)). On sites that change the URL without reloading (single-page apps), the overlay switches to the new URL's segments and a pending start is dropped.

### Download segments

1. Open the page and play the video, so the browser loads its media and the extension captures the request.
2. Open the overlay: toolbar button, or Alt+Shift+S.
3. Mark the segments (Mark start / Mark end, or `[` / `]`).
4. Optional, in the Download menu (▾): Output, Incognito, a Quality for an HLS master playlist, or another Source or Video.
5. Click Download. Follow the progress in the overlay's progress line or on the app's Downloads page, and cancel a job there.

Which source the app uses: when the extension captured the page's media and you picked neither a Source nor a Quality, the app first gives the page URL to `yt-dlp` (without its generic extractor). When `yt-dlp` has no extractor for the site or is missing, or fails another way while Auto fallback is on, the app downloads the captured media with `ffmpeg` instead and says "Switched to the captured media". A picked Source or Quality is downloaded as is. Without captured media, the page URL goes to `yt-dlp`. `yt-dlp` gets only the URL, no captured headers or cookies.

Files land in `<Output folder>/<page title>/` (Settings › Output folder, `~/Downloads/SegDown` by default): `<page title> - 01 [0h00m02s-0h00m04s].mp4` per segment, or `<page title> - merged.mp4`. When a file with that name exists, the new one gets ` (2)`, ` (3)`… before the extension. Open them with Show in Finder on the job's card.

### Keyboard shortcuts

- `[` marks a start, `]` marks an end. They work only while the overlay is open, also when the player inside an iframe has focus. They are ignored while you type in a text field, and with Ctrl, Cmd or Alt held. On keyboard layouts where `[` and `]` need Option (for example German on a Mac), use the overlay's buttons.
- Alt+Shift+S shows or hides the overlay. Change it in `chrome://extensions/shortcuts`, or in Safari Settings › Extensions › SegDown.
- Esc closes the Download menu.
- In the app: ⌘, opens Settings; on the Downloads page, ⌘A selects all cards and ⌫ removes the selected ones.

### Permissions

- `nativeMessaging`: talk to the SegDown app through `segdown-host`: read the app's settings and missing tools, send download jobs, read HLS qualities, and read job progress. Only the service worker uses it. While the overlay shows a running job, progress is read every second over one open connection, which closes a few seconds after nothing needs it.
- `storage`: segments per page URL in local storage, which only the service worker reads and writes, never for an incognito tab and only once the app has answered (so the Incognito by default setting is known); captured requests, per-tab overlay state, segments, the Incognito choice and job ids in session storage, which only the extension's trusted contexts can read. Job titles are kept only for jobs that are not incognito.
- `webRequest`: see the page's media requests (mp4, HLS) and their `Referer`, `Origin`, `User-Agent` and `Cookie` headers, so the media can be downloaded later as the browser would. The header values stay in the service worker's session storage; they are never given to pages or content scripts.
- `webNavigation`: clear a tab's captures and overlay state when it navigates, notice when a single-page site changes its URL, drop a frame's videos when that frame navigates, and record the top frame's URL for the page source and the saved segments.
- Host access to all sites (`<all_urls>`): capture media requests on any site and run the content scripts in every frame, including cross-origin player iframes.

## How it fits together

The extension talks to `segdown-host` through Chrome native messaging (Safari: through the appex). The host accepts only the SegDown extension's origin and relays each message as one JSON line over a Unix socket, `~/Library/Application Support/SegDown/segdown.sock` (folder 0700, socket 0600; the app serves only processes of the same user). The app runs the jobs with `ffmpeg` and `yt-dlp`.

- Settings: the app keeps them in `settings.json` in the socket's folder. The extension gets the ones it needs in the app's `ping` answer (`protocol: 2` and `settings`: default output, incognito by default, max total duration) and reuses that answer for 10 seconds. The app applies the others (output folder, precision, auto fallback, max size) itself and checks the max total duration again for every job.
- History: finished jobs go to `history.json` in the same folder (mode 0600, the newest 500): id, title, state, start and end times, segment count, total duration, size, output paths, the message with every URL replaced by `<link>`, and whether the job fell back. Never the request, its URLs or its headers. The Downloads page lists the newest 50 at launch.
- Incognito: Settings › Incognito by default is the default for every tab, and the overlay's Incognito item changes it for one tab. A tab in a browser private window is always incognito. An incognito job is never written to `history.json`, so its card is gone when the app quits; the extension keeps its segments and job id only in session storage (no title, nothing in local storage), and turning Incognito on deletes the page's saved segments. The output files are still written, in a folder named after the page title.

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
- The app's settings and limits do not apply to the CLI.
- Ctrl+C cancels the running download.

## Troubleshooting

- Progress stays near 0% for a long time on a late segment of an mp4: the server does not support HTTP Range requests, so `ffmpeg` cannot seek and reads the file from the start up to the segment.
- "Media link expired or forbidden (HTTP 403/410). Play the video again and retry.": the captured link was tokenized or timed out. Play the video again and download right away.
- DRM (Widevine, FairPlay) is not supported: there is no media request to capture, or the output is encrypted and does not play.
- Wrong source picked: in the Download menu (▾), pick another entry in Source or another Video. On sites `yt-dlp` supports, leaving Source and Quality as they are sends the page URL to `yt-dlp` first.
- "SegDown app not reachable: install browser integration": copy `SegDown.app` to `/Applications` first, then click Install on the app's Browsers page. Click Reinstall after moving the app. The `ping` check in [Browser integration (Chromium)](#browser-integration-chromium) tests the connection.
- Download disabled with "ffmpeg is not installed: see Dependencies in the SegDown app" (or `yt-dlp`): a tool the source needs is missing. Run the `brew install …` line from the Dependencies page and click Re-check. The extension reuses the app's tool list for 10 seconds, so wait that long if the message stays.
- Download disabled with "Total … is over the … limit (Max total duration in SegDown Settings).": the marked segments last longer than Settings › Max total duration. Delete segments, or raise the limit or turn off Limit total duration. The app refuses such a job too: "Total duration … exceeds the max duration (…)".
- "Estimated … exceeds the max size (…)": before downloading media, the app estimates the job's size (HLS: the variant's bandwidth × the total duration; mp4: the file's size × the share of the video marked) and refuses it when over Settings › Max size. HLS bandwidth is a peak rate, so the estimate runs high; raise the limit if needed. Without an estimate (for example a page source) the job runs and stops once its download passes the limit: "Exceeds the max size (…)", the job ends Failed and its temporary files are removed.
- "Switched to the captured media" on a card or in the progress line: `yt-dlp` could not download the page (no extractor for the site, `yt-dlp` missing, or another failure with Auto fallback on), so the app downloaded the captured media instead. Turn off Auto fallback to get `yt-dlp`'s error for the other failures.
- "Update the SegDown app to download incognito": the Chromium extension is newer than the app, and an older app would keep the job in its history. Install the current `SegDown.app`.
- "The site refused the download (HTTP 403/410)…", or YouTube or another site blocks `yt-dlp`: run `brew upgrade yt-dlp`; YouTube also needs `deno` (`brew install deno`).
- Which hosts get a captured cookie: see the cookie note in [Not supported](#not-supported).

## Not supported

- DRM-protected video (Widevine, FairPlay)
- Live streams
- DASH (`.mpd`) manifests

Some sites (for example YouTube) may block `yt-dlp`; `brew upgrade yt-dlp` often helps.

A captured `Cookie` goes only to the media URL's own origin (scheme, host and port): ffmpeg gets it through `-cookies`, scoped with `domain=` to that host, and only for inputs on that origin, never through `-headers`; SegDown's own playlist request drops it when a redirect leaves the origin. Residual risks: if the server refreshes the cookie with a `Set-Cookie` that has no `Domain`, ffmpeg may send the refreshed cookie to hosts the site's own playlist or redirects point at (segments, keys, CDNs); ffmpeg matches `domain=` as a plain suffix, so such a host whose name ends with the media host's name (`evilexample.com` for `example.com`) gets the captured cookie too; the cookie is visible in `ps` to the same user while ffmpeg runs. `Referer`, `Origin` and `User-Agent` go to every host ffmpeg contacts for the download, as CDNs often require them.
