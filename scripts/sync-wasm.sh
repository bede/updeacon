#!/usr/bin/env bash
# Rebuild the Deacon WASM bundle in ../deacon and sync it into pkg/ (--no-build to skip the rebuild).
set -euo pipefail

SRC_REPO="${DEACON_REPO:-/Users/bede/Research/git/deacon}"
SRC_PKG="$SRC_REPO/deacon-wasm/pkg"
DEST_PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pkg"

build=1
[[ "${1:-}" == "--no-build" ]] && build=0

if [[ ! -d "$SRC_REPO/deacon-wasm" ]]; then
  echo "deacon-wasm not found at $SRC_REPO/deacon-wasm (set DEACON_REPO to override)" >&2
  exit 1
fi

if [[ "$build" == 1 ]]; then
  echo "Building WASM in $SRC_REPO ..."
  "$SRC_REPO/scripts/build-wasm.sh"
fi

# Files updeacon consumes from the wasm-pack bundle.
FILES=(
  deacon_wasm.js
  deacon_wasm_bg.wasm
  deacon_wasm.d.ts
  deacon_wasm_bg.wasm.d.ts
  package.json
)

for f in "${FILES[@]}"; do
  [[ -f "$SRC_PKG/$f" ]] || { echo "Missing source asset: $SRC_PKG/$f" >&2; exit 1; }
  cp "$SRC_PKG/$f" "$DEST_PKG/$f"
  echo "  synced $f"
done

# Fresh cache token, so browsers never serve a stale worker or WASM
"$(dirname "${BASH_SOURCE[0]}")/stamp-cache-token.sh"

SRC_HASH="$(git -C "$SRC_REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "Synced Deacon WASM from $SRC_REPO (deacon @ $SRC_HASH) into $DEST_PKG"
echo "Review and commit pkg/ if it changed:  git -C \"$(dirname "$DEST_PKG")\" status pkg/"
