# SegDown
Download video as segments from the internet.

## What it is

SegDown will be a macOS menu bar app plus a browser extension: mark time ranges on a video in the browser, and only those ranges are downloaded. It is a work in progress; for now the repo holds the core package (`Packages/SegDownCore`), a dev CLI (`segdown-cli`), the menu bar app with its native messaging host (`segdown-host`), and a Chromium extension skeleton (manifest and an empty service worker; the marking UI comes in a later phase).

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
2. In Chrome, open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the `extension/` folder. The `key` in `extension/manifest.json` fixes the extension ID to `kigkemeomlcgfgnknafeomgglcjeoicb`.
3. In the SegDown menu, click "Install browser integration". It writes `com.math2it.segdown.json` into the `NativeMessagingHosts` folder of each installed Chromium browser (Chrome, Chromium, Brave, Edge, Arc) under `~/Library/Application Support/`, pointing at the app's embedded `segdown-host`.

The manifest holds the app's absolute path, so install again after moving the app; the menu warns when the installed path is stale. When the app is not running, `segdown-host` launches it hidden.

The extension's marking UI is not there yet. To check the connection, open the extension's service worker console (`chrome://extensions` → SegDown → service worker) and run:

```js
chrome.runtime.sendNativeMessage("com.math2it.segdown", {type: "ping"}, console.log)
```

It logs the app version and the missing tools.

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
