# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Mark time ranges on a web video with a segment bar on the video itself (Mark start / Mark end, or `[` / `]`) and download only those ranges. Works in Chrome, Chromium, Brave, Edge and Arc, and in Safari with the extension that ships inside the app.
- Direct media (mp4) and HLS streams, including clear-key AES-128, are downloaded with `ffmpeg`. Pages that `yt-dlp` supports are downloaded with `yt-dlp`, and if it fails SegDown can fall back to the media captured on the page.
- Save one file per range, or merge all ranges into one mp4.
- Precise cuts (re-encoded, exact times) or Fast cuts (stream copy, nearest keyframes).
- Optional limits on the total duration and the size of a download.
- Incognito downloads that stay out of the history.
- Optional compression of the files after download.
- A window app with Downloads, Settings, Dependencies, Browsers and About pages, and a menu bar item that shows the number of active downloads.
- The Dependencies page shows any missing tool and the `brew install` line to get it.
- The Browsers page installs the native messaging connection for Chromium browsers and shows the state of the Safari extension.
- Signed with Developer ID and notarized, with in-app updates from "Check for Updates…" in the menu bar and app menus.
