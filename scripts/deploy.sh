#!/usr/bin/env bash
# Deploy the updeacon apps to the Jekyll blog (bede.github.io) as standalone
# static apps: the S3 upload app at /updeacon-s3/ and the human-check app
# (sapiometer) at /sapiometer/. No build step — updeacon's pkg/ (Deacon WASM)
# and vendor/ (AWS SDK) are already prebuilt/vendored.
set -euo pipefail

SRC="/Users/bede/Research/git/updeacon"
PAGES_ROOT="/Users/bede/Research/git/bede.github.io"
DEST="$PAGES_ROOT/updeacon-s3"
SAPIO_DEST="$PAGES_ROOT/sapiometer"

SOURCE_HASH="$(git -C "$SRC" rev-parse --short HEAD)"

# Files deployed into updeacon-s3/ (paths relative to both SRC and DEST). This is
# the single source of truth: files copied, staged, and pruned all derive from it,
# so a rename in SRC can't leave an orphaned copy behind in the deployed app.
FILES=(
  index.html
  app.js
  pairing.js
  worker.js
  protocol.js
  vendor/aws-sdk.js
  pkg/deacon_wasm.js
  pkg/deacon_wasm_bg.wasm
)

# sapiometer is served self-contained at /sapiometer/: its index.html lives in
# SRC/sapiometer/ but references the shared root modules (../sapiometer.js). Here we
# flatten those modules in beside it and rewrite ../sapiometer.js -> ./sapiometer.js
# so the deployed dir stands alone. These names are relative to SAPIO_DEST.
SAPIO_FILES=(
  index.html
  sapiometer.js
  worker.js
  protocol.js
  pairing.js
  pkg/deacon_wasm.js
  pkg/deacon_wasm_bg.wasm
)

mkdir -p "$DEST/pkg" "$DEST/vendor"

for f in "${FILES[@]}"; do
  cp "$SRC/$f" "$DEST/$f"
done

# Stamp the deployed app.js with the source commit so the page logs it on load.
sed -i '' "s/const BUILD_COMMIT = \"dev\";/const BUILD_COMMIT = \"$SOURCE_HASH\";/" "$DEST/app.js"

echo "Deployed to $DEST"

mkdir -p "$SAPIO_DEST/pkg"
cp "$SRC/sapiometer/index.html" "$SAPIO_DEST/index.html"
sed -i '' 's#\.\./sapiometer\.js#./sapiometer.js#' "$SAPIO_DEST/index.html"
for f in sapiometer.js worker.js protocol.js pairing.js pkg/deacon_wasm.js pkg/deacon_wasm_bg.wasm; do
  cp "$SRC/$f" "$SAPIO_DEST/$f"
done

echo "Deployed to $SAPIO_DEST"

cd "$PAGES_ROOT"
branch="$(git rev-parse --abbrev-ref HEAD)"
source_hash="$SOURCE_HASH"

# Prune any tracked file under a deployed app dir that is no longer in its deploy
# set (e.g. left behind by a rename), then stage the current set.
prune_and_stage() {
  local dir="$1"; shift
  local set=("$@")
  while IFS= read -r tracked; do
    rel="${tracked#"$dir"/}"
    keep=0
    for f in "${set[@]}"; do [[ "$f" == "$rel" ]] && { keep=1; break; }; done
    [[ "$keep" == 0 ]] && git rm -q "$tracked"
  done < <(git ls-files "$dir/")
  for f in "${set[@]}"; do
    git add "$dir/$f"
  done
}

prune_and_stage updeacon-s3 "${FILES[@]}"
prune_and_stage sapiometer "${SAPIO_FILES[@]}"

if git diff --cached --quiet; then
  echo "No GitHub Pages changes to commit"
  exit 0
fi
git commit -m "updeacon $source_hash"
git push origin "$branch"
echo "Pushed to GitHub Pages"
