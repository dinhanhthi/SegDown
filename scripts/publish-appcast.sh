#!/usr/bin/env bash
#
# publish-appcast.sh - Generate + commit + push the Sparkle appcast (docs/RELEASING.md).
#
# Finds Sparkle's generate_appcast in DerivedData, runs it over a FRESH
# release/appcast-archives/ that holds only the new zip plus a copy of the repo-root
# appcast.xml (so older items keep their original download URLs, and the history
# survives a deleted release/ folder), copies the result back to the repo root,
# commits, and pushes to main (the Pages workflow then deploys it to
# https://dinhanhthi.github.io/SegDown/appcast.xml).
#
# The zip must already be notarized + stapled (build-and-notarize.sh) and the GitHub
# Release must exist (publish-release.sh), since the appcast points at its asset URL.
#
# generate_appcast signs whatever bytes it is given, so the zip is verified first:
#   - if release/export/SegDown-X.Y.Z.zip exists and is not the zip passed in (e.g. a copy
#     downloaded from the GitHub Release), both must have the same SHA-256;
#   - always: the app inside is signed by team 86H6CNLN4C (codesign), passes
#     `codesign --verify --deep --strict`, is "Notarized Developer ID" (spctl), and its
#     CFBundleShortVersionString equals the X.Y.Z of the zip name.
#
# Prereqs (one-time - docs/RELEASING.md):
#   - Sparkle EdDSA key in the login Keychain under the account "SegDown"
#     (generate_keys --account SegDown); click "Always Allow" on the Keychain prompt
#   - one build of the project, so DerivedData holds the Sparkle tools
#
# Usage:
#   scripts/publish-appcast.sh release/export/SegDown-1.0.0.zip
#   scripts/publish-appcast.sh release/download/SegDown-1.0.0.zip   # recovery (docs/RELEASING.md)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GH_REPO="dinhanhthi/SegDown"
TEAM_ID="86H6CNLN4C"
ARCHIVES="release/appcast-archives"

ZIP="${1:-}"
[[ -n "$ZIP" ]] || { echo "usage: scripts/publish-appcast.sh <notarized-zip>" >&2; exit 1; }
# Resolve the zip before cd so a path relative to the caller's directory still works.
[[ -f "$ZIP" ]] || { echo "error: zip not found: $ZIP" >&2; exit 1; }
ZIP="$(cd "$(dirname "$ZIP")" && pwd)/$(basename "$ZIP")"

cd "$REPO_ROOT"

# Version from the zip name, which must be exactly SegDown-X.Y.Z.zip: the app inside is
# checked against it below.
VERSION="$(basename "$ZIP" | sed -nE 's/^SegDown-([0-9]+\.[0-9]+\.[0-9]+)\.zip$/\1/p' | head -1)"
[[ -n "$VERSION" ]] \
  || { echo "error: zip name must be SegDown-X.Y.Z.zip (got $(basename "$ZIP"))" >&2; exit 1; }

# Commit + `git push origin main` below: make sure the commit lands on main.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] \
  || { echo "error: the appcast must be committed on 'main' (you are on '$BRANCH')." >&2; exit 1; }

# generate_appcast ships inside the Sparkle SPM binary artifact.
G="$(find ~/Library/Developer/Xcode/DerivedData/SegDown-*/SourcePackages/artifacts \
  -name generate_appcast -type f 2>/dev/null | head -1 || true)"
[[ -n "$G" ]] || {
  echo "error: generate_appcast not found in DerivedData." >&2
  echo "       Build the project first (in Xcode, or scripts/build-and-notarize.sh)." >&2
  exit 1
}

SPARKLE_VER="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  "$(dirname "$G")/../Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework/Resources/Info.plist" \
  2>/dev/null || true)"

# --- Verify the zip before signing it ---------------------------------------
LOCAL_ZIP="$REPO_ROOT/release/export/SegDown-$VERSION.zip"
if [[ -f "$LOCAL_ZIP" && "$LOCAL_ZIP" != "$ZIP" ]]; then
  ZIP_SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
  LOCAL_SHA="$(shasum -a 256 "$LOCAL_ZIP" | awk '{print $1}')"
  [[ -n "$ZIP_SHA" && "$ZIP_SHA" == "$LOCAL_SHA" ]] \
    || { echo "error: $ZIP differs from the local notarized build $LOCAL_ZIP (SHA-256)." >&2
         echo "       Refusing to sign it. Check the GitHub Release assets (docs/RELEASING.md section 2)." >&2
         exit 1; }
  echo "==> SHA-256 matches the local build ($ZIP_SHA)"
fi

VERIFY_DIR="$(mktemp -d -t segdown-appcast)"
trap 'rm -rf "$VERIFY_DIR"' EXIT
ditto -x -k "$ZIP" "$VERIFY_DIR" \
  || { echo "error: cannot unzip $ZIP" >&2; exit 1; }
VAPP="$VERIFY_DIR/SegDown.app"
[[ -d "$VAPP" && ! -L "$VAPP" ]] || { echo "error: $ZIP does not contain SegDown.app at its root" >&2; exit 1; }
# Nothing else at the root: a symlinked or extra top-level entry could point the checks at other bytes.
[[ "$(ls -A "$VERIFY_DIR")" == "SegDown.app" ]] || { echo "error: $ZIP must contain only SegDown.app at its root" >&2; exit 1; }
grep -qx "TeamIdentifier=$TEAM_ID" <<<"$(codesign -dvvv "$VAPP" 2>&1 || true)" \
  || { echo "error: SegDown.app in $ZIP is not signed by team $TEAM_ID - refusing to sign it" >&2; exit 1; }
codesign --verify --deep --strict "$VAPP" \
  || { echo "error: SegDown.app in $ZIP fails codesign --verify --deep --strict" >&2; exit 1; }
SPCTL_OUT="$(spctl -a -t exec -vv "$VAPP" 2>&1 || true)"
grep -q ": accepted" <<<"$SPCTL_OUT" && grep -q "source=Notarized Developer ID" <<<"$SPCTL_OUT" \
  || { echo "$SPCTL_OUT" >&2
       echo "error: SegDown.app in $ZIP is not a notarized Developer ID app - refusing to sign it" >&2
       exit 1; }
APP_VER="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$VAPP/Contents/Info.plist" 2>/dev/null || true)"
[[ "$APP_VER" == "$VERSION" ]] \
  || { echo "error: SegDown.app in $ZIP is version '${APP_VER:-unset}', expected $VERSION (zip name)" >&2; exit 1; }
echo "==> Verified $ZIP: team $TEAM_ID, notarized, version $VERSION"

echo "==> Generating appcast for v$VERSION"
echo "    generate_appcast: $G (Sparkle ${SPARKLE_VER:-unknown})"

rm -rf "$ARCHIVES"
mkdir -p "$ARCHIVES"
# Zip only - no .md notes file (keeps the in-app update prompt compact; full release
# notes live in CHANGELOG.md via --full-release-notes-url).
cp "$ZIP" "$ARCHIVES/"
[[ -f appcast.xml ]] && cp appcast.xml "$ARCHIVES/"
# --maximum-deltas 0: deltas would be listed in the appcast but never uploaded.
# --maximum-versions 0: keep every item (the default prunes to the last 3 versions).
"$G" --account SegDown \
  --maximum-versions 0 \
  --maximum-deltas 0 \
  --full-release-notes-url "https://github.com/$GH_REPO/blob/main/CHANGELOG.md" \
  --download-url-prefix "https://github.com/$GH_REPO/releases/download/v$VERSION/" \
  "$ARCHIVES"

# The new item must point at this release's GitHub asset and carry an EdDSA signature.
xmllint --noout "$ARCHIVES/appcast.xml" \
  || { echo "error: generate_appcast wrote an invalid appcast.xml" >&2; exit 1; }
ITEM_URL="$(xmllint --xpath "string(//item/enclosure[substring(@url, string-length(@url) - string-length('/SegDown-$VERSION.zip') + 1) = '/SegDown-$VERSION.zip']/@url)" "$ARCHIVES/appcast.xml" 2>/dev/null || true)"
ITEM_SIG="$(xmllint --xpath "string(//item/enclosure[@url = '$ITEM_URL']/@*[local-name() = 'edSignature'])" "$ARCHIVES/appcast.xml" 2>/dev/null || true)"
[[ "$ITEM_URL" == "https://github.com/$GH_REPO/releases/download/v$VERSION/SegDown-$VERSION.zip" ]] \
  || { echo "error: appcast item url for v$VERSION is '${ITEM_URL:-missing}', expected https://github.com/$GH_REPO/releases/download/v$VERSION/SegDown-$VERSION.zip" >&2; exit 1; }
[[ -n "$ITEM_SIG" ]] \
  || { echo "error: appcast item for v$VERSION has no sparkle:edSignature - check the SegDown Keychain key" >&2; exit 1; }
cp "$ARCHIVES/appcast.xml" appcast.xml

echo "==> Committing and pushing appcast.xml"
git add -- appcast.xml
git commit -m "chore(release): appcast v$VERSION" -- appcast.xml
git push origin main

echo
echo "Done. appcast.xml pushed - Pages deploy triggered (~1 min to go live)."
echo "  Verify: curl -fsSL https://dinhanhthi.github.io/SegDown/appcast.xml | grep shortVersionString"
