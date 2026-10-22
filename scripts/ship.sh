#!/usr/bin/env bash
#
# ship.sh - End-to-end local release: build -> sign -> notarize -> GitHub Release -> appcast.
#
# Run this AFTER the version-bump commit (project.yml + extension/manifest.json + CHANGELOG.md)
# is pushed to main.
# It chains the four release scripts in sequence with no interactive prompts.
# Before building it requires: branch main, HEAD == origin/main (only pushed commits ship),
# a clean tree of tracked files, gh authenticated, extension/manifest.json "version" ==
# MARKETING_VERSION, a `## [X.Y.Z]` CHANGELOG.md section, no existing tag vX.Y.Z, the AMO
# Keychain items, jq, npx and node >= 20.
# The notary profile env (SEGDOWN_NOTARY_PROFILE) passes through to build-and-notarize.sh.
#
# Prereqs (one-time - docs/RELEASING.md):
#   - "Developer ID Application" cert in the login Keychain
#   - notarytool credential profile (default "apple-notary")
#   - Sparkle EdDSA key (generate_keys --account SegDown) + SUPublicEDKey in Info.plist
#   - Xcode 27+ selected (required for the Icon Composer .icon) and xcodegen installed
#   - gh CLI authenticated
#   - AMO API key in the login Keychain (segdown-amo-jwt-issuer, segdown-amo-jwt-secret), jq and
#     node >= 20 (npx) for the Firefox add-on (scripts/build-firefox-addon.sh)
#
# Usage:
#   scripts/ship.sh
#   SEGDOWN_NOTARY_PROFILE=my-profile scripts/ship.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] \
  || { echo "error: releases ship from 'main' (you are on '$BRANCH')." >&2; exit 1; }

# Only what is already on origin/main ships: the release commit is pushed before this runs, and
# publish-appcast.sh later pushes on top of HEAD (a stale HEAD would fail after the Release exists).
git fetch -q origin main || { echo "error: git fetch origin main failed" >&2; exit 1; }
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "error: HEAD ($(git rev-parse --short HEAD)) is not origin/main ($(git rev-parse --short origin/main))." >&2
  echo "       push the release commit (or fast-forward to origin/main), then re-run." >&2
  exit 1
fi

gh auth status >/dev/null 2>&1 || { echo "error: gh is not authenticated - run 'gh auth login'." >&2; exit 1; }

# Tracked files only: untracked files are ignored.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "error: commit or discard changes to tracked files before building a release" >&2
  exit 1
fi
release_sha="$(git rev-parse HEAD)"

# Version from the committed project.yml (tree is clean, so HEAD == working copy).
VERSION="$(git show HEAD:project.yml \
  | sed -nE 's/^[[:space:]]*MARKETING_VERSION:[[:space:]]*"?([0-9]+\.[0-9]+\.[0-9]+)"?.*/\1/p' \
  | head -1)"
[[ -n "$VERSION" ]] || { echo "error: no MARKETING_VERSION found in project.yml" >&2; exit 1; }

# The Chromium extension ships with the same version: check now, not after a notarization.
MANIFEST_VERSION="$(git show HEAD:extension/manifest.json | plutil -extract version raw -o - - 2>/dev/null || true)"
if [[ "$MANIFEST_VERSION" != "$VERSION" ]]; then
  echo "error: extension/manifest.json version is '${MANIFEST_VERSION:-unset}', expected MARKETING_VERSION '$VERSION'." >&2
  echo "       run scripts/bump-version.sh $VERSION, commit and push, then re-run." >&2
  exit 1
fi

# publish-release.sh needs the release notes: check now, not after a notarization.
grep -qE "^## \[$(sed 's/\./\\./g' <<<"$VERSION")\]" CHANGELOG.md 2>/dev/null \
  || { echo "error: no '## [$VERSION]' section in CHANGELOG.md - add the release notes first." >&2; exit 1; }

# Refuse before building: a re-run must never overwrite release/export/ or spend a notarization.
TAG="v$VERSION"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
   || git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists; resume with /cf-ship (Resume) or see docs/RELEASING.md (rollback)" >&2
  exit 1
fi

# The Firefox add-on is signed after notarization: check its credentials and tools now.
for item in segdown-amo-jwt-issuer segdown-amo-jwt-secret; do
  security find-generic-password -s "$item" >/dev/null 2>&1 \
    || { echo "error: Keychain item $item not found (AMO API key, docs/RELEASING.md)." >&2; exit 1; }
done
command -v jq >/dev/null && command -v npx >/dev/null \
  || { echo "error: jq and npx (node >= 20) are required for the Firefox add-on." >&2; exit 1; }
(( $(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) >= 20 )) \
  || { echo "error: node >= 20 is required for the Firefox add-on (web-ext)." >&2; exit 1; }

ZIP="release/export/SegDown-$VERSION.zip"

echo "========================================"
echo "  Shipping SegDown v$VERSION"
echo "========================================"
echo

# Step 1 - Build, sign, notarize, DMG (Keychain prompt -> Always Allow)
echo "==> Step 1/4: build + notarize"
scripts/build-and-notarize.sh

if [[ "$(git rev-parse HEAD)" != "$release_sha" || -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "error: source changed during build; release was not published" >&2
  exit 1
fi
# Step 1 and the guard passed: the Firefox step may now fail without spending another notarization
# (docs/RELEASING.md and the /cf-ship guide resume from here when this holds HEAD).
echo "$release_sha" > release/export/.ship-built

# Step 2 - Sign the Firefox add-on on AMO (unlisted) into release/export/
echo "==> Step 2/4: Firefox add-on"
scripts/build-firefox-addon.sh

# Step 3 - Tag + GitHub Release (zip, DMG, extension zip and Firefox .xpi uploaded)
echo "==> Step 3/4: tag + GitHub Release"
scripts/publish-release.sh --yes "$ZIP"

# Step 4 - Generate + commit + push the appcast and firefox-updates.json
echo "==> Step 4/4: appcast"
scripts/publish-appcast.sh "$ZIP"

echo
echo "========================================"
echo "  SegDown v$VERSION shipped!"
echo "  GitHub : https://github.com/dinhanhthi/SegDown/releases/tag/v$VERSION"
echo "  Appcast: https://dinhanhthi.github.io/SegDown/appcast.xml (live in ~1 min)"
echo "========================================"
