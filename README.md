<div align="center">

<img src="assets/logo_512.png" width="128" alt="SegDown icon">

# SegDown

**Mark time ranges on a video in your browser. Only those ranges are downloaded.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![macOS 15+](https://img.shields.io/badge/macOS-15%2B-blue)

<img src="assets/poster.jpg" width="100%" alt="SegDown: three ranges marked on a video's timeline, each saved as its own mp4">

</div>

## Features

- A browser extension (Chrome, Chromium, Brave, Edge, Arc and Safari) puts a segment bar on the page's video: mark ranges with Mark start / Mark end or `[` / `]`.
- The SegDown app on your Mac downloads only those ranges: direct mp4 and HLS (including clear-key AES-128) with `ffmpeg`, and pages that `yt-dlp` supports with `yt-dlp`.
- One file per range, or all ranges merged into one mp4.
- Precise cuts (re-encoded, exact times) or Fast cuts (no re-encoding, nearest keyframes).
- Optional compression, size and duration limits, and incognito downloads that stay out of the history.

## Install

Requires macOS 15 or later, Xcode with Swift 6, and:

```sh
brew install yt-dlp ffmpeg deno xcodegen
```

Build the app:

```sh
xcodegen generate
xcodebuild -project SegDown.xcodeproj -scheme SegDown -configuration Debug build
xcodebuild -project SegDown.xcodeproj -scheme SegDown -configuration Debug -showBuildSettings | grep -m1 BUILT_PRODUCTS_DIR
```

Copy `SegDown.app` from that folder to `/Applications` and open it. It lives in the menu bar; its Dependencies page shows any missing tool.

## Connect a browser

**Chrome, Chromium, Brave, Edge, Arc**

1. Open the browser's extensions page (`chrome://extensions` in Chrome), turn on Developer mode, click Load unpacked and pick the `extension/` folder.
2. In SegDown, open Browsers and click Install. Click Reinstall after moving the app.
3. Reload the pages that were already open.

**Safari** (the extension ships inside `SegDown.app`)

1. Safari Settings › Advanced: turn on "Show features for web developers".
2. Settings › Developer: turn on "Allow unsigned extensions". Safari turns it off each time it quits.
3. Settings › Extensions: tick SegDown, then "Always Allow on Every Website…".

## Use

1. Play the video, so the extension sees its media.
2. Click the SegDown toolbar button, or press Alt+Shift+S.
3. Mark the ranges: Mark start / Mark end, or `[` / `]`.
4. Click Download. The ▾ menu picks separate or merged files, incognito, quality, source or video.
5. Follow the progress on the overlay or in the app's Downloads page.

Files land in `~/Downloads/SegDown/<page title>/` (change it in Settings).

## Not supported

DRM-protected video (Widevine, FairPlay), live streams and DASH (`.mpd`). If a site blocks `yt-dlp`, run `brew upgrade yt-dlp`.

## License

[MIT](LICENSE)
