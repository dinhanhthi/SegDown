# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Archive a download from its card to move it out of the list; the Archived button next to Remove All shows the archived downloads.
- Search downloads by name from the header: the search bar spans the header and finds titles even with missing letters or accents.
- New versions download in the background; a green arrow button then shows left of the tabs and installs the update and relaunches in one click.

### Changed

- The card buttons sit on their own row at the bottom of the card.
- Tooltips show sooner, such as a card's full title.

## [0.4.0] - 2026-10-21

### Added

- Hovering a marked segment on the overlay timeline shows a × button that removes it, so a few segments can be dropped before Download without opening the menu.
- Segments you downloaded turn green on the overlay timeline and get a ✓ in the menu, also after you reopen the page (not for incognito or Full clip downloads).
- Download cards keep the page URL and have an Open Page button that opens the page the video came from.
- Download sizes are colored by weight, and the fallback note has an info icon.

### Changed

- Settings uses capsule tabs and flat capsule buttons.
- The page tabs are right-aligned in the window header.
- The download state badges are as tall as the card buttons.
- The app icon glyph is smaller.

## [0.3.0] - 2026-10-21

### Added

- A Full clip button on the overlay downloads the whole video as one file and leaves the marked ranges as they are. It is disabled for live video and for video longer than the Max total duration. Turn it off in Settings › Browser.
- A SegDown icon shows at the top-left of a video while the pointer is over it (not on ads, small or live videos) and opens the overlay for that video. Turn it off in Settings › Browser; a change reaches the browser the next time the overlay opens.
- Settings › Output › Flatten output folder saves every file straight into the output folder instead of one folder per video. Off by default.
- Settings › Output › Snake case names names files and folders like `my_video_title_merged.mp4`, with accents removed (`Học` → `hoc`). Off by default.

### Changed

- Each download card has its own Remove menu. The trash button in the Downloads header now shows only when several downloads are selected.

### Fixed

- A browser connected after you changed the app's settings now gets them on its first page load, instead of only after the overlay was opened once.
- HLS streams whose segments have a non-media file name (such as `file-0000.png`) now download instead of failing with "Invalid data found when processing input". This needs ffmpeg 7.1 or later.
- Pages whose tab title is only the site name (such as Facebook reels) now get the video's real title from yt-dlp for the folder and file names.

## [0.2.1] - 2026-10-21

### Added

- The SegDown logo sits at the left of the window's toolbar, next to the page tabs.

### Changed

- The Downloads header is no longer a card: the title and a count badge sit straight on the window, so it does not read as one of the downloads.

## [0.2.0] - 2026-10-21

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
