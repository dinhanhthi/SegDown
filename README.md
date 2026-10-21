<div align="center">

<img src="assets/logo_512.png" width="128" alt="SegDown icon">

# SegDown

**Mark time ranges on a video in your browser. Only those ranges are downloaded.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![macOS 15+](https://img.shields.io/badge/macOS-15%2B-blue)

<img src="assets/poster.jpg" width="100%" alt="SegDown: three ranges marked on a video's timeline, each saved as its own mp4">

</div>

## What it does

- Mark the parts of a video you want, right on the page. SegDown downloads only those parts.
- Works in Chrome, Brave, Edge, Arc and Safari, on YouTube and most video sites.
- One file per part, or all parts merged into one file.
- Pick the quality per video, or set a preferred resolution once.

## Install

1. Install the tools SegDown uses, with [Homebrew](https://brew.sh):

   ```sh
   brew install yt-dlp ffmpeg deno
   ```

2. Download `SegDown-X.Y.Z.dmg` from the [latest release](https://github.com/dinhanhthi/SegDown/releases/latest), drag SegDown to Applications and open it. It lives in the menu bar.

Needs macOS 15 or later. SegDown updates itself; its Dependencies page shows a missing or outdated tool and updates it in one click.

## Add it to your browser

**Chrome, Brave, Edge, Arc** (once)

1. In SegDown, open **Browsers** and click **Install**. Then click **Show in Finder** next to **Extension folder**.
2. In your browser, open the extensions page (`chrome://extensions`), turn on **Developer mode**, click **Load unpacked** and choose that folder.
3. Reload the pages that were already open.

The extension comes with the app: each SegDown update also updates the extension. Just reload the pages that were open. The `SegDown-extension-X.Y.Z.zip` on the release page is only a spare copy; you don't need it.

**Safari**

Open SegDown once. In Safari › Settings › Extensions, tick SegDown and allow it on every website.

## Use

1. Play the video.
2. Click the SegDown icon on the video, the SegDown toolbar button, or press Alt+Shift+S.
3. Mark the parts with **Mark start** and **Mark end** (or the `[` and `]` keys).
4. Click **Download**. The ▾ menu has more choices: separate or merged files, quality, incognito. **Full clip** downloads the whole video.

If the buttons hide the player's controls, drag them by their ⋮⋮ handle.

Files go to `Downloads/SegDown/`. Change this and more in SegDown's Settings.

## Not supported

Protected video (DRM, such as Netflix), live streams and DASH. If a site stops working, update yt-dlp on SegDown's Dependencies page.

## Build from source

Needs Xcode with Swift 6 and `brew install xcodegen`:

```sh
xcodegen generate
xcodebuild -project SegDown.xcodeproj -scheme SegDown -configuration Debug build
```

To sign with your own team, change `DEVELOPMENT_TEAM` and `CODE_SIGN_IDENTITY` in `project.yml`. While developing the extension, load `extension/` from the clone instead.

## License

[MIT](LICENSE)
