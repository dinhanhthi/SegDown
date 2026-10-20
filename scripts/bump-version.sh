#!/usr/bin/env bash
#
# bump-version.sh - Bump SegDown's version for a release (docs/RELEASING.md).
#
# Edits the two version settings in project.yml (the XcodeGen source of truth):
#   MARKETING_VERSION       -> CFBundleShortVersionString (user-facing)
#   CURRENT_PROJECT_VERSION -> CFBundleVersion (build number, Sparkle compare key)
# and keeps the Chromium extension in step:
#   extension/manifest.json top-level "version" -> MARKETING_VERSION
#
# The build number ALWAYS increments by 1. Sparkle ships an update only when
# CFBundleVersion strictly increases - bump it every single release.
#
# Usage:
#   scripts/bump-version.sh 1.1.0     # set marketing version 1.1.0, build +1
#   scripts/bump-version.sh           # keep marketing version, build +1 only
#   PROJECT_YML=/tmp/p.yml MANIFEST_JSON=/tmp/m.json scripts/bump-version.sh 1.0.1   # edit other files (tests)
#
# Review the diff and commit the bump yourself.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_YML="${PROJECT_YML:-$REPO_ROOT/project.yml}"
MANIFEST_JSON="${MANIFEST_JSON:-$REPO_ROOT/extension/manifest.json}"
NEW_MARKETING="${1:-}"

# Each key must appear exactly once, or the edit would be ambiguous.
MARKETING_RE='^[[:space:]]*MARKETING_VERSION:'
BUILD_RE='^[[:space:]]*CURRENT_PROJECT_VERSION:'
# Leading quote: matches "version" but never "manifest_version".
MANIFEST_RE='^[[:space:]]*"version"[[:space:]]*:'

[[ -f "$PROJECT_YML" ]] || { echo "error: $PROJECT_YML not found" >&2; exit 1; }
[[ -f "$MANIFEST_JSON" ]] || { echo "error: $MANIFEST_JSON not found" >&2; exit 1; }

if [[ -n "$NEW_MARKETING" && ! "$NEW_MARKETING" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: marketing version must look like 1.2.3 (got \"$NEW_MARKETING\")" >&2
  exit 1
fi

require_once() { # <file> <regex> <key name>
  local count
  count="$(grep -cE "$2" "$1" || true)"
  [[ "$count" == "1" ]] || { echo "error: expected exactly one $3 in $1 (found $count)" >&2; exit 1; }
}
require_once "$PROJECT_YML" "$MARKETING_RE" MARKETING_VERSION
require_once "$PROJECT_YML" "$BUILD_RE" CURRENT_PROJECT_VERSION
require_once "$MANIFEST_JSON" "$MANIFEST_RE" '"version"'

CURRENT_BUILD="$(grep -E "$BUILD_RE" "$PROJECT_YML" | grep -Eo '[0-9]+"?[[:space:]]*$' | grep -Eo '[0-9]+' || true)"
[[ -n "$CURRENT_BUILD" ]] || { echo "error: CURRENT_PROJECT_VERSION in $PROJECT_YML is not a number" >&2; exit 1; }
NEXT_BUILD=$((CURRENT_BUILD + 1))

CURRENT_MARKETING="$(grep -E "$MARKETING_RE" "$PROJECT_YML" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[[ -n "$CURRENT_MARKETING" ]] || { echo "error: MARKETING_VERSION in $PROJECT_YML is not X.Y.Z" >&2; exit 1; }
MARKETING="${NEW_MARKETING:-$CURRENT_MARKETING}"

perl -i -pe "s/^(\s*CURRENT_PROJECT_VERSION: *)\"?[0-9]+\"?/\${1}${NEXT_BUILD}/" "$PROJECT_YML"
if [[ -n "$NEW_MARKETING" ]]; then
  perl -i -pe "s/^(\s*MARKETING_VERSION: *)\"?[0-9.]+\"?/\${1}${NEW_MARKETING}/" "$PROJECT_YML"
fi
perl -i -pe "s/^(\s*\"version\"\s*:\s*)\"[^\"]*\"/\${1}\"${MARKETING}\"/" "$MANIFEST_JSON"

echo "==> Build number (CFBundleVersion):  ${CURRENT_BUILD} -> ${NEXT_BUILD}"
if [[ -n "$NEW_MARKETING" ]]; then
  echo "==> Marketing version:               set to ${NEW_MARKETING}"
else
  echo "==> Marketing version:               unchanged"
fi
echo "==> Extension manifest version:      ${MARKETING}"
grep -nE 'MARKETING_VERSION|CURRENT_PROJECT_VERSION' "$PROJECT_YML"
grep -nE "$MANIFEST_RE" "$MANIFEST_JSON"
