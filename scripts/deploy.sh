#!/usr/bin/env bash
# Deploy updeacon-s3 to the Jekyll blog (bede.github.io) as a standalone static app
# served at /updeacon-s3/ (upload app at index.html, host-check at check.html).
# Mirrors lightfield/scripts/deploy-wasm.sh. No build step —
# updeacon's pkg/ (Deacon WASM) and vendor/ (AWS SDK) are already prebuilt/vendored.
set -euo pipefail

SRC="/Users/bede/Research/git/updeacon"
PAGES_ROOT="/Users/bede/Research/git/bede.github.io"
DEST="$PAGES_ROOT/updeacon-s3"

SOURCE_HASH="$(git -C "$SRC" rev-parse --short HEAD)"

# Files deployed into updeacon-s3/ (paths relative to both SRC and DEST). This is
# the single source of truth: files copied, staged, and pruned all derive from it,
# so a rename in SRC can't leave an orphaned copy behind in the deployed app.
FILES=(
  index.html
  app.js
  check.html
  check.js
  pairing.js
  worker.js
  protocol.js
  vendor/aws-sdk.js
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

cd "$PAGES_ROOT"
branch="$(git rev-parse --abbrev-ref HEAD)"
source_hash="$SOURCE_HASH"

# Prune any file tracked under updeacon-s3/ that is no longer in the deploy set
# (e.g. left behind by a rename), then stage the current set.
while IFS= read -r tracked; do
  rel="${tracked#updeacon-s3/}"
  keep=0
  for f in "${FILES[@]}"; do [[ "$f" == "$rel" ]] && { keep=1; break; }; done
  [[ "$keep" == 0 ]] && git rm -q "$tracked"
done < <(git ls-files updeacon-s3/)

for f in "${FILES[@]}"; do
  git add "updeacon-s3/$f"
done
if git diff --cached --quiet; then
  echo "No GitHub Pages changes to commit"
  exit 0
fi
git commit -m "updeacon-s3 $source_hash"
git push origin "$branch"
echo "Pushed to GitHub Pages"
