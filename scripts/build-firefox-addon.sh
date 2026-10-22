#!/usr/bin/env bash
#
# build-firefox-addon.sh - Build the Firefox add-on from extension/ and sign it on AMO (docs/RELEASING.md).
#
# extension/ stays the single source (Chromium, Safari). This copies it and rewrites manifest.json for
# Firefox: no Chromium `key` or `match_origin_as_fallback`, background scripts instead of a service
# worker, and a gecko block (id, minimum version, data collection, update_url). The id must equal
# ExtensionID.firefox in Packages/SegDownCore and the key of firefox-updates.json.
#
# Default: stage the COMMITTED extension/ (HEAD), lint it, sign it as an unlisted add-on with
# `web-ext sign` and copy SegDown-firefox-<v>.xpi into release/export/ (publish-release.sh uploads
# it, publish-appcast.sh adds it to firefox-updates.json). AMO signs a version only once, so the
# signed .xpi is kept in release/firefox/ (build-and-notarize.sh wipes release/export) and reused.
# The AMO JWT credentials come from the login Keychain (generic passwords segdown-amo-jwt-issuer
# and segdown-amo-jwt-secret) into web-ext's environment only, never its arguments.
#
# --dev: stage the working tree's extension/ into release/firefox/dev/ and stop, for Firefox's
# about:debugging > Load Temporary Add-on. No lint, no signing, no network.
#
# Usage:
#   scripts/build-firefox-addon.sh          # sign (or reuse) release/firefox/SegDown-firefox-<v>.xpi
#   scripts/build-firefox-addon.sh --dev    # release/firefox/dev/ for about:debugging
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GECKO_ID="me@dinhanhthi.com"
UPDATE_URL="https://dinhanhthi.github.io/SegDown/firefox-updates.json"
WEB_EXT="web-ext@10.8.0"
OUT_DIR="release/firefox"
EXPORT_DIR="release/export"

# --- 0. Args & tools -------------------------------------------------------
DEV=false
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=true ;;
    *) echo "usage: scripts/build-firefox-addon.sh [--dev]" >&2; exit 1 ;;
  esac
done

cd "$REPO_ROOT"

command -v jq >/dev/null || { echo "error: jq not found (ships with macOS 15+)" >&2; exit 1; }
if ! $DEV; then
  command -v npx >/dev/null || { echo "error: npx not found (install node >= 20)" >&2; exit 1; }
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  (( NODE_MAJOR >= 20 )) || { echo "error: node >= 20 required for $WEB_EXT (found ${NODE_MAJOR})" >&2; exit 1; }
fi

# Rewrites the staged manifest.json in place for Firefox.
firefox_manifest() {
  local manifest="$1/manifest.json"
  jq --arg id "$GECKO_ID" --arg url "$UPDATE_URL" '
    del(.key)
    | .content_scripts |= map(del(.match_origin_as_fallback))
    | .background = {scripts: ["background.js"]}
    | .browser_specific_settings = {gecko: {
        id: $id,
        strict_min_version: "140.0",
        data_collection_permissions: {required: ["none"]},
        update_url: $url
      }}' "$manifest" > "$manifest.tmp"
  mv "$manifest.tmp" "$manifest"
}

# --- 1. Dev build: the working tree, for about:debugging --------------------
if $DEV; then
  DEV_DIR="$OUT_DIR/dev"
  rm -rf "$DEV_DIR"
  mkdir -p "$DEV_DIR"
  cp -R extension/. "$DEV_DIR/"
  find "$DEV_DIR" -name .DS_Store -delete
  firefox_manifest "$DEV_DIR"
  echo "==> Firefox dev build: $REPO_ROOT/$DEV_DIR"
  echo "    Firefox > about:debugging > This Firefox > Load Temporary Add-on > $DEV_DIR/manifest.json"
  exit 0
fi

# --- 2. Stage the committed extension/ --------------------------------------
VERSION="$(git show HEAD:extension/manifest.json | jq -r .version)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: bad version in HEAD:extension/manifest.json: $VERSION" >&2; exit 1; }
XPI="$OUT_DIR/SegDown-firefox-$VERSION.xpi"
mkdir -p "$OUT_DIR" "$EXPORT_DIR"

if [[ -f "$XPI" ]]; then
  echo "==> Reusing the signed $XPI (AMO signs each version once)"
else
  SRC_DIR="$OUT_DIR/src-$VERSION"
  SIGNED_DIR="$OUT_DIR/signed-$VERSION"
  rm -rf "$SRC_DIR" "$SIGNED_DIR"
  mkdir -p "$SRC_DIR" "$SIGNED_DIR"
  git archive --format=tar HEAD:extension | tar -x -C "$SRC_DIR"
  firefox_manifest "$SRC_DIR"
  echo "==> Staged extension $VERSION for Firefox in $SRC_DIR"

  # --- 3. Lint ---------------------------------------------------------------
  npx --yes "$WEB_EXT" lint --self-hosted --source-dir "$SRC_DIR"
  echo "==> Linted"

  # --- 4. Sign (unlisted) ----------------------------------------------------
  WEB_EXT_API_KEY="$(security find-generic-password -s segdown-amo-jwt-issuer -w)" \
    || { echo "error: Keychain item segdown-amo-jwt-issuer not found (docs/RELEASING.md)" >&2; exit 1; }
  WEB_EXT_API_SECRET="$(security find-generic-password -s segdown-amo-jwt-secret -w)" \
    || { echo "error: Keychain item segdown-amo-jwt-secret not found (docs/RELEASING.md)" >&2; exit 1; }
  export WEB_EXT_API_KEY WEB_EXT_API_SECRET
  npx --yes "$WEB_EXT" sign --channel=unlisted --source-dir "$SRC_DIR" --artifacts-dir "$SIGNED_DIR"
  unset WEB_EXT_API_KEY WEB_EXT_API_SECRET

  SIGNED=("$SIGNED_DIR"/*.xpi)
  [[ ${#SIGNED[@]} -eq 1 && -f "${SIGNED[0]}" ]] \
    || { echo "error: expected one signed .xpi in $SIGNED_DIR" >&2; exit 1; }
  mv "${SIGNED[0]}" "$XPI"
  echo "==> Signed $XPI"
fi

# --- 5. Export -------------------------------------------------------------
cp "$XPI" "$EXPORT_DIR/"
echo "==> Firefox add-on: $REPO_ROOT/$EXPORT_DIR/$(basename "$XPI")"
