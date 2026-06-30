#!/usr/bin/env bash
# Deploy updeacon-s3 to the Jekyll blog (bede.github.io) as a standalone static app
# served at /updeacon-s3/. Mirrors lightfield/scripts/deploy-wasm.sh. No build step —
# updeacon's pkg/ (Deacon WASM) and vendor/ (AWS SDK) are already prebuilt/vendored.
set -euo pipefail

SRC="/Users/bede/Research/git/updeacon"
PAGES_ROOT="/Users/bede/Research/git/bede.github.io"
DEST="$PAGES_ROOT/updeacon-s3"

SOURCE_HASH="$(git -C "$SRC" rev-parse --short HEAD)"

mkdir -p "$DEST/pkg" "$DEST/vendor"

cp "$SRC/index.html"              "$DEST/"
cp "$SRC/app.js"                  "$DEST/"
cp "$SRC/pairing.js"              "$DEST/"
cp "$SRC/worker.js"               "$DEST/"
cp "$SRC/protocol.js"             "$DEST/"
cp "$SRC/vendor/aws-sdk.js"       "$DEST/vendor/"
cp "$SRC/pkg/deacon_wasm.js"      "$DEST/pkg/"
cp "$SRC/pkg/deacon_wasm_bg.wasm" "$DEST/pkg/"

# Stamp the deployed app.js with the source commit so the page logs it on load.
sed -i '' "s/const BUILD_COMMIT = \"dev\";/const BUILD_COMMIT = \"$SOURCE_HASH\";/" "$DEST/app.js"

echo "Deployed to $DEST"

cd "$PAGES_ROOT"
branch="$(git rev-parse --abbrev-ref HEAD)"
source_hash="$SOURCE_HASH"
git add updeacon-s3/index.html updeacon-s3/app.js updeacon-s3/pairing.js updeacon-s3/worker.js updeacon-s3/protocol.js
git add updeacon-s3/vendor/aws-sdk.js
git add updeacon-s3/pkg/deacon_wasm.js updeacon-s3/pkg/deacon_wasm_bg.wasm
if git diff --cached --quiet; then
  echo "No GitHub Pages changes to commit"
  exit 0
fi
git commit -m "updeacon-s3 $source_hash"
git push origin "$branch"
echo "Pushed to GitHub Pages"
