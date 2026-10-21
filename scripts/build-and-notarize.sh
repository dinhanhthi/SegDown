#!/usr/bin/env bash
#
# build-and-notarize.sh - Build -> sign -> notarize -> staple a release locally (docs/RELEASING.md).
#
# Releases are built locally only (there is no CI release workflow).
#
# Produces, under release/export/:
#   - SegDown-<version>.zip             notarized + stapled -> Sparkle auto-update asset
#   - SegDown-<version>.dmg             notarized + stapled -> manual-download asset
#   - SegDown-extension-<version>.zip   Chromium extension (git archive of HEAD:extension) -> Load unpacked
# Then hand the .zip to scripts/publish-release.sh to tag + create the GitHub Release
# (scripts/ship.sh runs the whole chain).
#
# SegDown ships universal (arm64 + x86_64): the archive is built with
# -destination 'generic/platform=macOS' (a plain Release build picks "My Mac" and comes out
# arm64 only). The lipo guard below checks the app, segdown-host and the Safari appex.
#
# Prereqs (one-time - see docs/RELEASING.md):
#   - "Developer ID Application" cert in the login Keychain
#   - notarytool credential profile (default "apple-notary")
#   - Sparkle EdDSA public key pasted into SUPublicEDKey (App/Info.plist)
#   - Xcode 27+ selected - REQUIRED to compile the Icon Composer .icon icon (blank-icon guard below)
#   - xcodegen (brew install xcodegen)
#
# Notarization talks to Apple, so this needs network - "local" means your machine, not offline.
#
# Usage:
#   scripts/build-and-notarize.sh
#   SEGDOWN_NOTARY_PROFILE=my-profile scripts/build-and-notarize.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROJECT="SegDown.xcodeproj"
INFO_PLIST="App/Info.plist"
MANIFEST_JSON="extension/manifest.json"
ARCHIVE="release/SegDown.xcarchive"
EXPORT_DIR="release/export"
APP="$EXPORT_DIR/SegDown.app"
APPEX="$APP/Contents/PlugIns/SegDownSafari.appex"
MIN_MACOS="15.0"   # SegDown's hard minimum (project.yml) - guarded below
PROFILE="${SEGDOWN_NOTARY_PROFILE:-apple-notary}"
SIGN_ID="Developer ID Application"
TEAM_ID="86H6CNLN4C"
# The only update feed the app may use. If the feed ever moves, change it here AND in
# SUFeedURL (App/Info.plist) in the same reviewed commit.
EXPECTED_FEED_URL="https://dinhanhthi.github.io/SegDown/appcast.xml"

# Submit to Apple and FAIL the script on anything other than "Accepted". notarytool exits 0
# even when the status is Invalid, so without this an Invalid result sails on into stapler and
# surfaces as a confusing "Error 65" instead of a clear stop. On failure, print the log command.
notarize() {  # $1 = file to submit (zip or dmg)
  local out sid
  if ! out="$(xcrun notarytool submit "$1" --keychain-profile "$PROFILE" --wait 2>&1)"; then
    echo "$out" >&2
    echo "error: notarytool submit failed" >&2
    exit 1
  fi
  echo "$out"
  grep -q "status: Accepted" <<<"$out" && return 0
  sid="$(grep -m1 '  id:' <<<"$out" | awk '{print $2}' || true)"
  echo "error: notarization not Accepted for $1 - pull the log to see which binary failed:" >&2
  echo "       xcrun notarytool log $sid --keychain-profile $PROFILE" >&2
  exit 1
}

# True when $1 (a Mach-O file) is the main executable of its bundle, so signing that bundle
# signs it too: <bundle>/Contents/MacOS/<CFBundleExecutable> or <X>.framework/Versions/<v>/<X>.
is_main_executable() {
  local f="$1" dir name exe fw
  dir="$(dirname "$f")"
  name="$(basename "$f")"
  if [[ "$(basename "$dir")" == MacOS ]]; then
    exe="$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$dir/../Info.plist" 2>/dev/null || true)"
    [[ "$name" == "$exe" ]]
  elif [[ "$(basename "$(dirname "$dir")")" == Versions ]]; then
    fw="$(dirname "$(dirname "$dir")")"
    [[ "$fw" == *.framework && "$name" == "$(basename "$fw" .framework)" ]]
  else
    return 1
  fi
}

# Every nested code object of the app, deepest first (inside-out signing order): bundles
# (Sparkle's XPC services + Updater.app + framework, the SegDownSafari.appex) plus loose
# Mach-O files that are not a bundle's main executable (Sparkle's Autoupdate, segdown-host
# in Contents/MacOS, dylibs).
# find never follows symlinks, so a framework's Versions/Current aliases are not listed twice.
nested_code() {
  {
    find "$APP/Contents" -type d \( -name '*.xpc' -o -name '*.app' -o -name '*.appex' \
      -o -name '*.framework' -o -name '*.bundle' -o -name '*.plugin' \)
    find "$APP/Contents" -type f -name '*.dylib'
    find "$APP/Contents" -type f -perm -u+x | while IFS= read -r f; do
      [[ "$(file -b "$f")" == *Mach-O* ]] || continue
      [[ "$f" == "$APP/Contents/MacOS/SegDown" ]] && continue
      is_main_executable "$f" || printf '%s\n' "$f"
    done
  } | sort -u | awk -F/ '{ print NF "\t" $0 }' | sort -t $'\t' -k1,1rn | cut -f2-
}

# --- 0. Tools & prereqs (all before the slow archive) -----------------------
command -v xcodebuild >/dev/null || { echo "error: xcodebuild not found" >&2; exit 1; }
command -v xcodegen >/dev/null \
  || { echo "error: xcodegen not found - brew install xcodegen (docs/RELEASING.md)." >&2; exit 1; }
[[ -f project.yml && -f "$INFO_PLIST" && -f "$MANIFEST_JSON" ]] \
  || { echo "error: project.yml / $INFO_PLIST / $MANIFEST_JSON not found - run from the SegDown repo" >&2; exit 1; }

# Xcode 27+ is REQUIRED (project.yml xcodeVersion; compiles the Icon Composer .icon app icon,
# older toolchains silently ship a blank icon). Fail loudly if not on 27+.
XCODE_VER="$(xcodebuild -version | sed -n '1s/^Xcode //p')"
XCODE_MAJOR="${XCODE_VER%%.*}"
if ! [[ "$XCODE_MAJOR" =~ ^[0-9]+$ ]] || (( XCODE_MAJOR < 27 )); then
  echo "error: Xcode 27+ required to build SegDown and compile the .icon app icon (have ${XCODE_VER:-unknown})." >&2
  echo "       sudo xcode-select -s /Applications/Xcode.app   (docs/RELEASING.md)" >&2
  exit 1
fi

# Pin the signing identity to the team: exactly one "Developer ID Application: ... (TEAM_ID)"
# identity, used by its SHA-1 hash so codesign never picks another team's certificate. Capture
# first (grep -q in a pipe trips pipefail, see step 3). The same cert in two keychains lists twice,
# hence sort -u on the hash.
IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
SIGN_HASHES="$(grep -F "\"$SIGN_ID: " <<<"$IDENTITIES" | grep -F "($TEAM_ID)\"" \
  | awk '{print $2}' | sort -u || true)"
SIGN_COUNT="$(grep -c . <<<"$SIGN_HASHES" || true)"
if [[ "$SIGN_COUNT" == 0 ]]; then
  echo "error: no '$SIGN_ID: ... ($TEAM_ID)' identity in the keychain." >&2
  echo "       Create it in Xcode > Settings > Accounts > Manage Certificates (docs/RELEASING.md)." >&2
  exit 1
elif [[ "$SIGN_COUNT" != 1 ]]; then
  echo "error: $SIGN_COUNT '$SIGN_ID: ... ($TEAM_ID)' identities in the keychain - ambiguous." >&2
  echo "       Keep only the current one (security find-identity -v -p codesigning)." >&2
  exit 1
fi
SIGN_HASH="$SIGN_HASHES"

# Sparkle refuses unsigned updates: an empty (or missing) SUPublicEDKey would ship an app that
# can never verify (and so never install) an update.
ED_KEY="$(/usr/libexec/PlistBuddy -c "Print :SUPublicEDKey" "$INFO_PLIST" 2>/dev/null | tr -d '[:space:]' || true)"
[[ -n "$ED_KEY" ]] \
  || { echo "error: SUPublicEDKey is empty or missing in $INFO_PLIST - Sparkle could never verify an update." >&2
       echo "       Run Sparkle's generate_keys --account SegDown and paste the public key (docs/RELEASING.md)." >&2
       exit 1; }
# Same rule as Updater.swift: a base64 Ed25519 public key decodes to exactly 32 bytes.
ED_KEY_BYTES="$(printf '%s' "$ED_KEY" | base64 -D 2>/dev/null | wc -c | tr -d ' ' || true)"
[[ "$ED_KEY_BYTES" == "32" ]] \
  || { echo "error: SUPublicEDKey in $INFO_PLIST is not a base64 32-byte Ed25519 key - the updater would stay off." >&2
       exit 1; }

FEED_URL="$(/usr/libexec/PlistBuddy -c "Print :SUFeedURL" "$INFO_PLIST" 2>/dev/null | tr -d '[:space:]' || true)"
[[ "$FEED_URL" == "$EXPECTED_FEED_URL" ]] \
  || { echo "error: SUFeedURL in $INFO_PLIST is '${FEED_URL:-unset}', expected '$EXPECTED_FEED_URL'." >&2
       echo "       Point it back at $EXPECTED_FEED_URL; if the feed really moved, change EXPECTED_FEED_URL" >&2
       echo "       in scripts/build-and-notarize.sh in the same reviewed commit (docs/RELEASING.md)." >&2
       exit 1; }

xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
  || { echo "error: notarytool credential profile '$PROFILE' is missing or invalid." >&2
       echo "       Create it: xcrun notarytool store-credentials $PROFILE --apple-id <id> --team-id $TEAM_ID" >&2
       echo "       or reuse a profile of the same team: SEGDOWN_NOTARY_PROFILE=<profile-name> scripts/build-and-notarize.sh" >&2
       echo "       (docs/RELEASING.md)" >&2
       exit 1; }

# --- 1. Generate the project and guard its Release settings ----------------
# SegDown.xcodeproj is generated from project.yml (gitignored), so regenerate it first.
# Check signing / min OS, don't override them: a command-line override would apply to every
# target, including the SPM packages.
xcodegen generate
if ! APP_SETTINGS="$(xcodebuild -project "$PROJECT" -target SegDown -configuration Release -showBuildSettings 2>/dev/null)"; then
  echo "error: xcodebuild -showBuildSettings failed - run it by hand to see why:" >&2
  echo "       xcodebuild -project $PROJECT -target SegDown -configuration Release -showBuildSettings" >&2
  exit 1
fi
APP_SIGN_ID="$(sed -n 's/^ *CODE_SIGN_IDENTITY = //p' <<<"$APP_SETTINGS" | head -1)"
APP_MIN_OS="$(sed -n 's/^ *MACOSX_DEPLOYMENT_TARGET = //p' <<<"$APP_SETTINGS" | head -1)"
APP_ENTITLEMENTS="$(sed -n 's/^ *CODE_SIGN_ENTITLEMENTS = //p' <<<"$APP_SETTINGS" | head -1)"
VERSION="$(sed -n 's/^ *MARKETING_VERSION = //p' <<<"$APP_SETTINGS" | head -1)"
[[ "$APP_SIGN_ID" == "$SIGN_ID" ]] \
  || { echo "error: SegDown Release CODE_SIGN_IDENTITY is '${APP_SIGN_ID:-unset}', expected '$SIGN_ID' (fix project.yml)." >&2; exit 1; }
[[ "$APP_MIN_OS" == "$MIN_MACOS" ]] \
  || { echo "error: SegDown Release MACOSX_DEPLOYMENT_TARGET is '${APP_MIN_OS:-unset}', expected '$MIN_MACOS' (fix project.yml)." >&2; exit 1; }
[[ -n "$APP_ENTITLEMENTS" && -f "$APP_ENTITLEMENTS" ]] \
  || { echo "error: SegDown Release CODE_SIGN_ENTITLEMENTS '${APP_ENTITLEMENTS:-unset}' not found (fix project.yml)." >&2; exit 1; }
if grep -q "get-task-allow" "$APP_ENTITLEMENTS"; then
  echo "error: $APP_ENTITLEMENTS carries get-task-allow (Debug entitlement) - instant notarization reject" >&2; exit 1
fi
[[ -n "$VERSION" ]] || { echo "error: no MARKETING_VERSION in the Release build settings" >&2; exit 1; }
# The Chromium extension ships with the same version (scripts/bump-version.sh keeps them in step).
MANIFEST_VERSION="$(plutil -extract version raw "$MANIFEST_JSON" 2>/dev/null || true)"
[[ "$MANIFEST_VERSION" == "$VERSION" ]] \
  || { echo "error: $MANIFEST_JSON version is '${MANIFEST_VERSION:-unset}', expected MARKETING_VERSION '$VERSION'." >&2
       echo "       Run scripts/bump-version.sh $VERSION (docs/RELEASING.md)." >&2
       exit 1; }

echo "==> Building SegDown $VERSION (universal, notary profile: $PROFILE)"

# --- 2. Archive ------------------------------------------------------------
# Default DerivedData (no -derivedDataPath), so Xcode reuses it and publish-appcast.sh finds
# Sparkle's generate_appcast under DerivedData/SegDown-*. -destination 'generic/platform=macOS'
# makes the archive universal (arm64 + x86_64); without it xcodebuild picks "My Mac" (arm64 only).
rm -rf "$ARCHIVE" "$EXPORT_DIR"
xcodebuild -project "$PROJECT" -scheme SegDown \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -archivePath "$ARCHIVE" \
  archive
# segdown-host is SKIP_INSTALL, so the archive must stay an application archive.
[[ -d "$ARCHIVE/Products/Applications/SegDown.app" ]] \
  || { echo "error: $ARCHIVE/Products/Applications/SegDown.app missing - not an application archive (check SKIP_INSTALL in project.yml)" >&2; exit 1; }

# --- 3. Extract the Developer-ID-signed app from the archive ---------------
# The Release config signs directly with Developer ID + hardened runtime + a secure timestamp,
# so the archived app is already distribution-ready; no `xcodebuild -exportArchive` needed.
# Copy the app out with ditto (preserves bundle structure + signatures; never cp -R, which would
# copy nested symlinks verbatim and dangle).
mkdir -p "$EXPORT_DIR"
ditto "$ARCHIVE/Products/Applications/SegDown.app" "$APP"
# Sanity-gate the extracted app before the (slow) notarization round-trip. Capture codesign
# output into a var first: piping `codesign | grep -q` trips `set -o pipefail` - grep -q exits
# on first match, SIGPIPEs codesign (exit 141), and the pipeline is wrongly seen as failed.
# lipo prints "x86_64 arm64" (order not guaranteed), so check each arch as a word.
for bin in "$APP/Contents/MacOS/SegDown" "$APP/Contents/MacOS/segdown-host" \
    "$APPEX/Contents/MacOS/SegDownSafari"; do
  BUILT_ARCHS="$(lipo -archs "$bin" 2>/dev/null || true)"
  grep -qw arm64 <<<"$BUILT_ARCHS" && grep -qw x86_64 <<<"$BUILT_ARCHS" \
    || { echo "error: ${bin#"$APP"/} architectures are '${BUILT_ARCHS:-unknown}', expected arm64 + x86_64" >&2; exit 1; }
done
SIGN_INFO="$(codesign -dvvv "$APP" 2>&1)"
grep -q "Authority=$SIGN_ID" <<<"$SIGN_INFO" \
  || { echo "error: extracted app is not Developer ID signed" >&2; exit 1; }
grep -q "flags=.*runtime" <<<"$SIGN_INFO" \
  || { echo "error: extracted app lacks the hardened runtime - notarization will reject it" >&2; exit 1; }
for item in "$APP" "$APPEX"; do
  ENTITLEMENTS="$(codesign -d --entitlements - "$item" 2>/dev/null || true)"
  if grep -q "get-task-allow" <<<"$ENTITLEMENTS"; then
    echo "error: ${item#"$EXPORT_DIR"/} carries get-task-allow (Debug entitlement) - instant notarization reject" >&2; exit 1
  fi
done
BUILT_MIN_OS="$(/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" "$APP/Contents/Info.plist" 2>/dev/null || true)"
[[ "$BUILT_MIN_OS" == "$MIN_MACOS" ]] \
  || { echo "error: built app LSMinimumSystemVersion is '${BUILT_MIN_OS:-unset}', expected '$MIN_MACOS'" >&2; exit 1; }
# Safari refuses an extension whose versions differ from its containing app's.
for key in CFBundleShortVersionString CFBundleVersion; do
  APP_VAL="$(/usr/libexec/PlistBuddy -c "Print :$key" "$APP/Contents/Info.plist" 2>/dev/null || true)"
  APPEX_VAL="$(/usr/libexec/PlistBuddy -c "Print :$key" "$APPEX/Contents/Info.plist" 2>/dev/null || true)"
  [[ -n "$APP_VAL" && "$APPEX_VAL" == "$APP_VAL" ]] \
    || { echo "error: SegDownSafari.appex $key is '${APPEX_VAL:-unset}', app has '${APP_VAL:-unset}' - Safari needs them equal" >&2; exit 1; }
done
BUILT_ED_KEY="$(/usr/libexec/PlistBuddy -c "Print :SUPublicEDKey" "$APP/Contents/Info.plist" 2>/dev/null | tr -d '[:space:]' || true)"
[[ -n "$BUILT_ED_KEY" ]] \
  || { echo "error: built app has an empty SUPublicEDKey - the Info.plist merge dropped it" >&2; exit 1; }
BUILT_FEED_URL="$(/usr/libexec/PlistBuddy -c "Print :SUFeedURL" "$APP/Contents/Info.plist" 2>/dev/null | tr -d '[:space:]' || true)"
[[ "$BUILT_FEED_URL" == "$EXPECTED_FEED_URL" ]] \
  || { echo "error: built app SUFeedURL is '${BUILT_FEED_URL:-unset}', expected '$EXPECTED_FEED_URL'" >&2; exit 1; }
[[ -d "$APP/Contents/Frameworks/Sparkle.framework" ]] \
  || { echo "error: Sparkle.framework missing from the app - it could never update" >&2; exit 1; }
SPARKLE_VER="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  "$APP/Contents/Frameworks/Sparkle.framework/Resources/Info.plist" 2>/dev/null || true)"
echo "==> Sparkle (embedded): ${SPARKLE_VER:-unknown}"
echo "==> Extracted Developer-ID-signed universal app from archive"

# --- 3b. Guard against a blank-icon build ----------------------------------
# assets/logo.icon is compiled by actool (ASSETCATALOG_COMPILER_APPICON_NAME logo) into Assets.car
# + <CFBundleIconFile>.icns (logo.icns). If it did not compile, the raw .icon folder ships instead.
ICON_NAME="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIconName" "$APP/Contents/Info.plist" 2>/dev/null || true)"
ICON_FILE="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" "$APP/Contents/Info.plist" 2>/dev/null || true)"
[[ -n "$ICON_NAME" && -n "$ICON_FILE" ]] \
  || { echo "error: CFBundleIconName / CFBundleIconFile missing from the built Info.plist - the .icon did not compile (need Xcode 27+)." >&2; exit 1; }
[[ "$ICON_FILE" == *.icns ]] || ICON_FILE="$ICON_FILE.icns"
test -f "$APP/Contents/Resources/$ICON_FILE" \
  || { echo "error: $ICON_FILE missing - the .icon app icon did not compile (need Xcode 27+)." >&2; exit 1; }
test -f "$APP/Contents/Resources/Assets.car" \
  || { echo "error: Assets.car missing - the .icon app icon did not compile (need Xcode 27+)." >&2; exit 1; }
[[ -z "$(find "$APP/Contents/Resources" -maxdepth 1 -name '*.icon')" ]] \
  || { echo "error: raw .icon copied unprocessed into Resources." >&2; exit 1; }
echo "==> App icon compiled OK ($ICON_NAME, $ICON_FILE)"

# --- 4. Re-sign nested code inside-out with Developer ID + secure timestamp ----
# The archive leaves some nested code ADHOC-signed with no secure timestamp (Sparkle's
# Updater.app, Autoupdate and XPC services); notarization rejects it. Sign inside-out
# (deepest first -> outer app last; touching nested code breaks every seal above it).
# --preserve-metadata=entitlements keeps each helper's entitlements (the appex keeps its
# sandbox + temporary-exception.sbpl) while adding Developer ID + secure timestamp + hardened
# runtime; segdown-host is signed as a loose Mach-O the same way.
NESTED="$(nested_code)"
while IFS= read -r item; do
  [[ -n "$item" ]] || continue
  echo "    signing ${item#"$APP"/}"
  codesign --force --options runtime --timestamp --preserve-metadata=entitlements \
    --sign "$SIGN_HASH" "$item"
done <<<"$NESTED"
codesign --force --options runtime --timestamp --entitlements "$APP_ENTITLEMENTS" \
  --sign "$SIGN_HASH" "$APP"
codesign --verify --deep --strict "$APP" \
  || { echo "error: deep signature verification failed after re-signing nested code" >&2; exit 1; }
# Every signed object (nested code + app) must carry our team.
while IFS= read -r item; do
  [[ -n "$item" ]] || continue
  grep -qx "TeamIdentifier=$TEAM_ID" <<<"$(codesign -dvvv "$item" 2>&1 || true)" \
    || { echo "error: ${item#"$REPO_ROOT"/} is not signed with team $TEAM_ID" >&2; exit 1; }
done <<<"$NESTED
$APP"
for item in "$APP" "$APPEX"; do
  ENTITLEMENTS="$(codesign -d --entitlements - "$item" 2>/dev/null || true)"
  if grep -q "get-task-allow" <<<"$ENTITLEMENTS"; then
    echo "error: re-signed ${item#"$EXPORT_DIR"/} carries get-task-allow - instant notarization reject" >&2; exit 1
  fi
done
# Safari only loads a sandboxed extension: the re-sign must have kept the appex's sandbox.
APPEX_ENTITLEMENTS="$(codesign -d --entitlements - "$APPEX" 2>/dev/null || true)"
grep -q "com.apple.security.app-sandbox" <<<"$APPEX_ENTITLEMENTS" \
  || { echo "error: re-signed SegDownSafari.appex lost com.apple.security.app-sandbox - Safari would refuse it" >&2; exit 1; }
echo "==> Re-signed nested code + app (Developer ID + timestamp)"

# --- 5. Notarize + staple the app, then ship-zip it ------------------------
# The first zip is a THROWAWAY upload for notarytool; the file we ship is the re-zip AFTER
# stapling (the staple writes the ticket into the .app, not the zip).
( cd "$EXPORT_DIR" && ditto -c -k --keepParent SegDown.app "SegDown-$VERSION.zip" )
notarize "$EXPORT_DIR/SegDown-$VERSION.zip"
( cd "$EXPORT_DIR" \
  && xcrun stapler staple SegDown.app \
  && rm -f "SegDown-$VERSION.zip" \
  && ditto -c -k --keepParent SegDown.app "SegDown-$VERSION.zip" )
spctl -a -vv -t exec "$APP"
echo "==> Notarized + stapled the app"

# --- 6. Build the notarized DMG (manual-download asset) --------------------
# A raw .zip breaks when users extract it with a third-party unarchiver (._* files pollute
# Sparkle.framework's seal -> Gatekeeper malware warning). A DMG is drag-to-install: Finder
# copies the bundle verbatim, so the seal always survives. Built from the already-stapled app.
( cd "$EXPORT_DIR"
  rm -rf dmg-stage && mkdir dmg-stage
  ditto SegDown.app dmg-stage/SegDown.app
  ln -s /Applications dmg-stage/Applications
  hdiutil create -volname "SegDown" -srcfolder dmg-stage -ov -format UDZO "SegDown-$VERSION.dmg"
  rm -rf dmg-stage
  # A DMG is a container, not an executable: --timestamp, no hardened runtime.
  codesign --force --timestamp --sign "$SIGN_HASH" "SegDown-$VERSION.dmg"
  notarize "SegDown-$VERSION.dmg"
  xcrun stapler staple "SegDown-$VERSION.dmg"
  spctl -a -t open --context context:primary-signature -v "SegDown-$VERSION.dmg"
  xcrun stapler validate "SegDown-$VERSION.dmg" )
echo "==> Notarized + stapled the DMG"

# --- 7. Zip the Chromium extension (Load unpacked asset) -------------------
# git archive of the committed extension/ only: no .DS_Store or untracked files, and the same
# zip can be regenerated from the tag (vX.Y.Z:extension) if the local file is lost.
git archive --format=zip --prefix=SegDown-extension/ \
  -o "$EXPORT_DIR/SegDown-extension-$VERSION.zip" HEAD:extension
echo "==> Zipped the Chromium extension"

# --- 8. Done ---------------------------------------------------------------
echo
echo "Done. Notarized + stapled artifacts:"
echo "  zip : $EXPORT_DIR/SegDown-$VERSION.zip"
echo "  dmg : $EXPORT_DIR/SegDown-$VERSION.dmg"
echo "Chromium extension:"
echo "  ext : $EXPORT_DIR/SegDown-extension-$VERSION.zip"
echo
echo "Next: scripts/publish-release.sh $EXPORT_DIR/SegDown-$VERSION.zip"
echo "      then scripts/publish-appcast.sh $EXPORT_DIR/SegDown-$VERSION.zip"
