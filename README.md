# SegDown
Download video as segments from the internet.

## What it is

SegDown will be a macOS menu bar app plus a browser extension: mark time ranges on a video in the browser, and only those ranges are downloaded. It is a work in progress; for now the repo holds the core package (`Packages/SegDownCore`), a dev CLI (`segdown-cli`), the menu bar app with its native messaging host (`segdown-host`), and a Chromium extension that marks segments on a page's video. The extension does not send the segments to the app yet, so downloads go through `segdown-cli` for now.

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

### Using the panel

The toolbar button or Alt+Shift+S shows or hides a floating panel (drag it by its title bar).

- Video: the panel picks the page's main video across all frames, including players in cross-origin iframes. Videos smaller than 200×112, videos inside ad containers and live streams are not picked automatically (a live stream shows as live and cannot be marked). When the page has several videos, a picker lets you choose another one; small and ad videos are listed with the reason and can still be chosen.
- Timeline: a mini timeline shows the playhead and the segments; click it to seek.
- Mark start / Mark end: mark a range at the video's current time. The end must be after the start.
- Segments: the list is kept sorted. Edit a start or end as `h:mm:ss.s`, `mm:ss.s` or `ss.s`, jump to a segment's start, or delete it. Clear removes all segments after an inline "Clear? Yes / No". Overlapping segments get a warning. At most 100 segments.
- Output: Separate (one file per segment) or Merged (one mp4). Cut: Precise (default) or Fast.
- Sources: the media requests captured in the tab (MP4, HLS, and a count of loaded stream chunks per frame).

Segments, output and cut are saved per page URL (without the `#hash`) and come back when the page reloads. On sites that change the URL without reloading (single-page apps), the panel switches to the new URL's segments and a pending start is dropped.

Fullscreen: when a player fullscreens its container, a compact panel (timeline, Mark start, Mark end) appears inside it. When a player fullscreens the bare `<video>`, or a page fullscreens the iframe that holds the player, there is no panel: use the keys and see the marks after leaving fullscreen.

### Keyboard shortcuts

- `[` marks a start, `]` marks an end. They work only while the panel is open, also when the player inside an iframe has focus. They are ignored while you type in a text field, and with Ctrl, Cmd or Alt held. On keyboard layouts where `[` and `]` need Option (for example German on a Mac), use the panel buttons.
- Alt+Shift+S shows or hides the panel. Change it in `chrome://extensions/shortcuts`.

### Permissions

- `nativeMessaging`: talk to the SegDown app through `segdown-host`. For now only the connection check above uses it.
- `storage`: segments, output and cut choices and the panel position in local storage, which only the service worker reads and writes (the panel asks it for the current page's entry); captured requests and per-tab panel state in session storage, which only the extension's trusted contexts can read.
- `webRequest`: see the page's media requests (mp4, HLS) and their `Referer`, `Origin`, `User-Agent` and `Cookie` headers, so the media can be downloaded later as the browser would. The header values stay in the service worker's session storage; they are never given to pages or content scripts.
- `webNavigation`: clear a tab's captures and panel state when it navigates, notice when a single-page site changes its URL, and drop a frame's videos when that frame navigates.
- `tabs`: send messages to the right tab and frame, and find the active tab for the keyboard shortcut.
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

## Not supported

- DRM-protected video (Widevine, FairPlay)
- Live streams
- DASH (`.mpd`) manifests

Some sites (for example YouTube) may block `yt-dlp`; `brew upgrade yt-dlp` often helps.

A captured `Cookie` goes only to the media URL's own origin (scheme, host and port): ffmpeg gets it through `-cookies`, scoped with `domain=` to that host, and only for inputs on that origin, never through `-headers`; SegDown's own playlist request drops it when a redirect leaves the origin. Residual risks: if the server refreshes the cookie with a `Set-Cookie` that has no `Domain`, ffmpeg may send the refreshed cookie to hosts the site's own playlist or redirects point at (segments, keys, CDNs); ffmpeg matches `domain=` as a plain suffix, so such a host whose name ends with the media host's name (`evilexample.com` for `example.com`) gets the captured cookie too; the cookie is visible in `ps` to the same user while ffmpeg runs. `Referer`, `Origin` and `User-Agent` go to every host ffmpeg contacts for the download, as CDNs often require them.
