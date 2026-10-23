# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.8] - 2026-10-23

### Changed

- The overlay's Mark start and Mark end buttons are now icons (`[` and `]`, like the keys), with tooltips. The next step to take is green.
- While a start is marked, Mark start turns into a red Cancel button that drops the start, so a start marked by mistake no longer needs a Mark end.
- Full clip asks to confirm before it downloads the whole video. Turn this off in Settings › Browser › Confirm Full clip.
- The Move to Trash and Clear history confirmations, and the message about files not moved to the Trash, now have the same capsule buttons as the rest of the window.

## [0.6.7] - 2026-10-22

### Added

- Turn SegDown off for a site right from the browser. Choose "Ignore this site" in the overlay's ▾ menu, or right-click the SegDown toolbar button and pick "Turn off SegDown on ...". The site shows up under Settings › Browser › Ignored sites at once. Right-click the toolbar button again to turn it back on. Needs the updated app.

## [0.6.6] - 2026-10-22

### Added

- Ignored sites. Settings › Browser › Ignored sites lists the websites where SegDown stays off: no video detection, no button on players, and the toolbar button shows "off". Subdomains are included.

## [0.6.5] - 2026-10-22

### Added

- Firefox add-on. Browsers › Firefox › Install in Firefox sets up the connection to SegDown and opens the signed add-on, which then updates itself.

### Changed

- The buttons on the Browsers and Dependencies pages (Re-check, Install, Reinstall, Open Safari Settings, Upgrade) now have the same capsule look as the rest of Settings.

## [0.6.4] - 2026-10-22

### Changed

- Browsers › Extension folder now explains how to reach the hidden Library folder when you load the extension.

### Fixed

- The Dependencies page no longer runs Homebrew every time it opens. Updates are checked when a download fails with "The site refused the download (HTTP 403/410)", or with Re-check.

## [0.6.3] - 2026-10-22

### Added

- Finished downloads have a Play button on their card that opens the video or audio files in your default player. Other file types are never opened.

## [0.6.2] - 2026-10-21

### Added

- SegDown now carries its Chrome extension. Load the folder from Browsers › Extension folder (Show in Finder) once; after that, every app update also updates the extension, which reloads itself. The extension zip on the release page is no longer needed.

## [0.6.1] - 2026-10-21

### Added

- Settings › Browser › Preferred resolution (360p, 480p, 720p, 1080p, 2K or 4K): the overlay's Quality starts on the tallest quality up to it, for yt-dlp downloads and HLS streams alike, and picking another one in the ▾ menu still wins for that video. Update the app and the extension together.
- Drag the overlay's buttons by their ⋮⋮ grip to move them anywhere on the video, so they no longer cover the player's own controls. The spot is kept until the page reloads.

## [0.6.0] - 2026-10-21

### Added

- The menu bar icon shows a red dot while downloads are active.
- The Dependencies page checks Homebrew for newer yt-dlp, deno and ffmpeg and upgrades each one with an Upgrade button (disabled while downloads run). An old yt-dlp is the usual cause of "The site refused the download (HTTP 403/410)".
- For downloads that go through yt-dlp, such as YouTube, the overlay's ▾ menu has a Quality section with the video's resolutions: Best (the default) or a height such as 720p, and the download takes the tallest format up to that height. Pages with a multi-variant HLS stream keep their Quality list as before. Update the app and the extension together.

### Changed

- A failed download shows its error on its own row, above the card's buttons.

### Fixed

- On a Facebook feed, SegDown downloads the video you selected instead of facebook.com.

## [0.5.1] - 2026-10-21

### Changed

- Searching keeps the "Downloads" title and its count on the left; the search field fills the rest of the header and is focused right away, so you can type at once.
- The header's buttons and the search field are taller and easier to hit.

## [0.5.0] - 2026-10-21

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
