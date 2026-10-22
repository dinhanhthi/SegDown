#!/usr/bin/env bash
#
# publish-release.sh - Tag + publish a SegDown GitHub Release (docs/RELEASING.md).
#
# Runs after scripts/build-and-notarize.sh, once the notarized + stapled .zip exists.
# Ties four things to ONE source of truth so they can never drift:
#   - version : MARKETING_VERSION in the COMMITTED project.yml at HEAD (= the app's
#               CFBundleShortVersionString, so the tag always matches the app)
#   - tag     : vX.Y.Z, created at HEAD and pushed
#   - notes   : the `## [X.Y.Z]` section of CHANGELOG.md, written to a sibling
#               SegDown-X.Y.Z.md next to the zip and used as the release body
#   - release : `gh release create` with that tag, the zip asset, and the notes;
#               the sibling .dmg (manual-download asset), SegDown-extension-X.Y.Z.zip
#               (Chromium extension, Load unpacked) and SegDown-firefox-X.Y.Z.xpi (signed
#               Firefox add-on, scripts/build-firefox-addon.sh) are uploaded when present
#
# This does NOT build/sign/notarize (build-and-notarize.sh), generate the appcast
# (publish-appcast.sh), or commit anything. It only creates + pushes the tag and the
# GitHub Release. scripts/ship.sh runs the whole chain.
#
# Usage:
#   scripts/publish-release.sh                    # zip = release/export/SegDown-<HEAD version>.zip
#   scripts/publish-release.sh release/export/SegDown-1.0.0.zip
#   scripts/publish-release.sh --yes [<zip>]      # no prompt
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGELOG="$REPO_ROOT/CHANGELOG.md"
GH_REPO="dinhanhthi/SegDown"

# --- 0. Args & tools -------------------------------------------------------
YES=false
ZIP=""
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=true ;;
    -*) echo "usage: scripts/publish-release.sh [--yes|-y] [<notarized-zip>]" >&2; exit 1 ;;
    *) ZIP="$arg" ;;
  esac
done

if [[ -n "$ZIP" ]]; then
  # Resolve the zip before cd so a path relative to the caller's directory still works.
  [[ -f "$ZIP" ]] || { echo "error: zip not found: $ZIP" >&2; exit 1; }
  ZIP="$(cd "$(dirname "$ZIP")" && pwd)/$(basename "$ZIP")"
fi

cd "$REPO_ROOT"

[[ -f "$CHANGELOG" ]] || { echo "error: $CHANGELOG not found" >&2; exit 1; }
command -v gh  >/dev/null || { echo "error: gh CLI not installed (https://cli.github.com)" >&2; exit 1; }
command -v git >/dev/null || { echo "error: git not installed" >&2; exit 1; }

# --- 1. Derive the version from the committed project.yml -------------------
# Read HEAD (the tag is created at HEAD), so an uncommitted bump yields a stale VERSION
# here and then trips the zip-name check below. Accepts quoted or bare values.
VERSION="$(git show HEAD:project.yml \
  | sed -nE 's/^[[:space:]]*MARKETING_VERSION:[[:space:]]*"?([0-9]+\.[0-9]+\.[0-9]+)"?.*/\1/p' \
  | sort -u)"
if [[ -z "$VERSION" ]]; then
  echo "error: no MARKETING_VERSION found in HEAD:project.yml" >&2; exit 1
fi
if [[ "$(printf '%s\n' "$VERSION" | wc -l | tr -d ' ')" != "1" ]]; then
  echo "error: MARKETING_VERSION is ambiguous in HEAD:project.yml:" >&2
  printf '  %s\n' $VERSION >&2
  exit 1
fi
TAG="v$VERSION"

if [[ -z "$ZIP" ]]; then
  ZIP="$REPO_ROOT/release/export/SegDown-$VERSION.zip"
  [[ -f "$ZIP" ]] || { echo "error: zip not found: $ZIP (run scripts/build-and-notarize.sh first)" >&2; exit 1; }
fi

# --- 2. Zip filename must match the version --------------------------------
ZIP_BASE="$(basename "$ZIP")"
if [[ "$ZIP_BASE" != "SegDown-$VERSION.zip" ]]; then
  echo "error: zip name \"$ZIP_BASE\" does not match \"SegDown-$VERSION.zip\" (version from HEAD)." >&2
  echo "       did you forget to commit the version bump, or pass the wrong zip?" >&2
  exit 1
fi

# --- 3. Extract the CHANGELOG section for this version ----------------------
# Capture lines between `## [X.Y.Z]` and the next `## ` header, then trim leading
# and trailing blank lines in the END block (portable to BSD/macOS awk).
NOTES_BODY="$(awk -v ver="$VERSION" '
  BEGIN { gsub(/\./, "\\.", ver) }          # escape dots so 1.0.0 is literal, not wildcard
  capture && /^## / { exit }                # stop at the next section (or a duplicate header)
  $0 ~ ("^## \\[" ver "\\]") { capture=1; next }
  capture { buf[n++]=$0 }
  END {
    start=0;   while (start < n   && buf[start] ~ /^[[:space:]]*$/) start++
    end=n-1;   while (end >= start && buf[end]  ~ /^[[:space:]]*$/) end--
    for (i = start; i <= end; i++) print buf[i]
  }
' "$CHANGELOG")"
if [[ -z "$(printf '%s' "$NOTES_BODY" | tr -d '[:space:]')" ]]; then
  echo "error: no '## [$VERSION] - <date>' section with content found in CHANGELOG.md." >&2
  echo "       add the release notes for $VERSION before publishing." >&2
  exit 1
fi

# Path fixed here (for the confirmation echo); written only after the confirm below
# so an aborted run leaves no stray file behind.
NOTES_FILE="$(dirname "$ZIP")/SegDown-${VERSION}.md"

# --- 4. Pre-flight checks --------------------------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "error: releases must be tagged from 'main' (you are on '$BRANCH')." >&2
  echo "       merge your release commit to main, check it out, then re-run." >&2
  exit 1
fi

gh auth status >/dev/null 2>&1 || { echo "error: gh is not authenticated - run 'gh auth login'." >&2; exit 1; }

# The tag is pushed to origin: origin must be this repo, and HEAD must already be on origin/main.
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
[[ "$ORIGIN_URL" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)dinhanhthi/SegDown(\.git)?/?$ ]] \
  || { echo "error: origin is '${ORIGIN_URL:-unset}', expected github.com/$GH_REPO." >&2; exit 1; }
git fetch -q origin main \
  || { echo "error: git fetch origin main failed" >&2; exit 1; }
git merge-base --is-ancestor HEAD origin/main \
  || { echo "error: HEAD $(git rev-parse --short HEAD) is not on origin/main - push the release commit first." >&2; exit 1; }

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "error: tag $TAG already exists locally. Delete it (git tag -d $TAG) or bump the version." >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists on origin. Bump the version." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "warning: tracked files have uncommitted changes - the tag will point at HEAD, not your working copy." >&2
fi

# --- 5. Confirm ------------------------------------------------------------
echo "About to publish:"
echo "  version : $VERSION"
echo "  tag     : $TAG  (at $(git rev-parse --short HEAD) on branch $BRANCH)"
echo "  zip     : $ZIP"
echo "  notes   : $NOTES_FILE"
echo
if [[ "$YES" == false ]]; then
  read -r -p "Proceed? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "aborted."; exit 1; }
fi

# --- 6. Tag + GitHub Release -----------------------------------------------
printf '%s\n' "$NOTES_BODY" > "$NOTES_FILE"

echo "==> Tagging $TAG"
git tag -a "$TAG" -m "SegDown $VERSION"
git push origin "$TAG"

echo "==> Creating GitHub Release $TAG"
if ! gh release create "$TAG" "$ZIP" \
  --repo "$GH_REPO" \
  --title "SegDown $VERSION" \
  --notes-file "$NOTES_FILE"; then
  echo "error: gh release create failed. The tag $TAG was already pushed." >&2
  echo "       fix the issue, then re-run gh release create, or delete the tag:" >&2
  echo "         git push origin :refs/tags/$TAG && git tag -d $TAG" >&2
  exit 1
fi

# Upload the DMG as the manual-download asset if it exists next to the zip.
# A raw .zip breaks when extracted with third-party unarchivers (._* files pollute
# Sparkle.framework's seal -> Gatekeeper warning); the DMG is always drag-to-install.
DMG="$(dirname "$ZIP")/SegDown-${VERSION}.dmg"
if [[ -f "$DMG" ]]; then
  echo "==> Uploading DMG: $DMG"
  gh release upload "$TAG" "$DMG" --repo "$GH_REPO"
else
  echo "warning: DMG not found at $DMG - attach it manually:" >&2
  echo "         gh release upload \"$TAG\" <path-to-dmg> --repo $GH_REPO" >&2
fi

# Upload the Chromium extension zip (built by build-and-notarize.sh with git archive).
# Missing is only a warning: it can be regenerated from the tag and attached later.
EXT_ZIP="$(dirname "$ZIP")/SegDown-extension-${VERSION}.zip"
if [[ -f "$EXT_ZIP" ]]; then
  echo "==> Uploading extension zip: $EXT_ZIP"
  gh release upload "$TAG" "$EXT_ZIP" --repo "$GH_REPO"
else
  echo "warning: extension zip not found at $EXT_ZIP - attach it manually:" >&2
  echo "         gh release upload $TAG release/export/SegDown-extension-${VERSION}.zip --repo $GH_REPO" >&2
fi

# Upload the signed Firefox add-on (scripts/build-firefox-addon.sh). The app's "Install in Firefox"
# button and firefox-updates.json point at this asset. Missing is only a warning: the signed .xpi is
# kept in release/firefox/ and can be attached later.
XPI="$(dirname "$ZIP")/SegDown-firefox-${VERSION}.xpi"
if [[ -f "$XPI" ]]; then
  echo "==> Uploading Firefox add-on: $XPI"
  gh release upload "$TAG" "$XPI" --repo "$GH_REPO"
else
  echo "warning: Firefox add-on not found at $XPI - run scripts/build-firefox-addon.sh, then:" >&2
  echo "         gh release upload $TAG release/export/SegDown-firefox-${VERSION}.xpi --repo $GH_REPO" >&2
fi

echo
echo "Done. Published $TAG -> https://github.com/$GH_REPO/releases/tag/$TAG"
echo "Next: scripts/publish-appcast.sh $ZIP"
