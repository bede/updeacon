#!/usr/bin/env bash
# Vendor sssender's library (core/, ui/, vendor/, mint scripts) into sssender/ and
# restamp the cache token. Change sssender upstream, never here.
#
#   scripts/sync-sssender.sh                      # ../sssender's working tree
#   scripts/sync-sssender.sh v0.6.0               # a tag or commit
#   SSSENDER_REPO=/path/to/sssender scripts/sync-sssender.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_REPO="${SSSENDER_REPO:-$ROOT/../sssender}"
DEST="$ROOT/sssender"
REF="${1:-}"

[[ -d "$SRC_REPO/core" ]] || { echo "sssender not found at $SRC_REPO (set SSSENDER_REPO)" >&2; exit 1; }

# Library only. sssender's own page stays upstream
PARTS=(core ui vendor scripts/mint-magic-link.py scripts/check-upload-link.py cors.json)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if [[ -n "$REF" ]]; then
  # Exactly what was committed
  git -C "$SRC_REPO" archive "$REF" "${PARTS[@]}" | tar -x -C "$tmp"
  hash="$(git -C "$SRC_REPO" rev-parse --short "$REF^{commit}")"
else
  for p in "${PARTS[@]}"; do
    mkdir -p "$tmp/$(dirname "$p")"
    cp -R "$SRC_REPO/$p" "$tmp/$p"
  done
  hash="$(git -C "$SRC_REPO" rev-parse --short HEAD)"
  if [[ -n "$(git -C "$SRC_REPO" status --porcelain -- "${PARTS[@]}")" ]]; then
    hash="$hash-dirty"
    echo "warning: $SRC_REPO has uncommitted changes; vendoring them as $hash" >&2
  fi
fi
find "$tmp" -name .DS_Store -delete

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$tmp/." "$DEST/"
sed -i '' "s/const SSSENDER_COMMIT = \"dev\";/const SSSENDER_COMMIT = \"$hash\";/" "$DEST/core/version.js"
version="$(sed -n 's/^export const SSSENDER_VERSION = "\(.*\)";/\1/p' "$DEST/core/version.js")"
cat > "$DEST/VENDORED.txt" <<TXT
Vendored copy of sssender. Do not edit here: change sssender, then rerun
scripts/sync-sssender.sh.

version  $version
commit   $hash
TXT
echo "  vendored sssender $version ($hash) into sssender/"

"$ROOT/scripts/stamp-cache-token.sh"
echo "Review and commit:  git -C \"$ROOT\" status sssender/"
