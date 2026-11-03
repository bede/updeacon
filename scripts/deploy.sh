#!/usr/bin/env bash
# Deploy the apps to the Jekyll blog (bede.github.io) as standalone static apps:
#   /updeacon-s3/  filter with Deacon, then upload (keeps seq2bucket/ as a subdir)
#   /seq2bucket/   upload without filtering (seq2bucket/ flattened)
#   /sapiometer/   human-content check, no upload
# No build step — pkg/ (Deacon WASM) and seq2bucket/vendor/ (AWS SDK) are prebuilt.
set -euo pipefail

SRC="/Users/bede/Research/git/updeacon"
PAGES_ROOT="${PAGES_ROOT:-/Users/bede/Research/git/bede.github.io}"

SOURCE_HASH="$(git -C "$SRC" rev-parse --short HEAD)"
# We copy the working tree, not HEAD, so don't label uncommitted code with a clean hash
if [[ -n "$(git -C "$SRC" status --porcelain)" ]]; then
  # Repeated dirty deployments may contain different bytes at the same HEAD.
  SOURCE_HASH="$SOURCE_HASH-dirty-$(date -u +%Y%m%d%H%M%S)"
fi

# Self-hosted fonts and their licenses, shared by all three apps
SEQ2BUCKET_FONTS=(
  fonts.css
  fonts/geist-latin.woff2
  fonts/geist-latin-ext.woff2
  fonts/geist-mono-latin.woff2
  fonts/geist-mono-latin-ext.woff2
  fonts/fraunces-latin.woff2
  fonts/fraunces-latin-ext.woff2
  fonts/OFL.txt
)

# Each app's file set (paths relative to its deployed dir) is the single source of
# truth: files copied, stamped, staged and pruned all derive from it, so a rename in
# SRC can't leave an orphaned copy behind in the deployed app.
SEQ2BUCKET_LIB=(
  link.js
  post.js
  spool.js
  uploaders.js
  pairing.js
  pipeline.js
  ui.js
  version.js
  style.css
  mint.js
  mint-page.js
  "${SEQ2BUCKET_FONTS[@]}"
)

UPDEACON_FILES=(
  index.html
  mint.html
  app.js
  deacon.js
  worker.js
  protocol.js
  pkg/deacon_wasm.js
  pkg/deacon_wasm_bg.wasm
  "${SEQ2BUCKET_LIB[@]/#/seq2bucket/}"
  seq2bucket/vendor/aws-sdk.js
)

SEQ2BUCKET_FILES=(
  index.html
  mint.html
  page.js
  "${SEQ2BUCKET_LIB[@]}"
  vendor/aws-sdk.js
)

# sapiometer/index.html references ../sapiometer.js and ../seq2bucket/; deployed, both sit beside it
SAPIO_FILES=(
  index.html
  sapiometer.js
  worker.js
  protocol.js
  seq2bucket/pairing.js
  "${SEQ2BUCKET_FONTS[@]/#/seq2bucket/}"
  pkg/deacon_wasm.js
  pkg/deacon_wasm_bg.wasm
)

# copy_app <src dir> <dest dir> <files…>: each file keeps its path relative to both
copy_app() {
  local from="$1" to="$2"; shift 2
  for f in "$@"; do
    mkdir -p "$(dirname "$to/$f")"
    cp "$from/$f" "$to/$f"
  done
}

# One deployment is one coherent module graph. Stamp every cache token with the
# revision so a new entry point can never import an older dependency, and stamp
# the build commit the pages log and record.
stamp() {
  local dir="$1"; shift
  for f in "$@"; do
    case "$f" in *.js|*.html|*.css) ;; *) continue ;; esac
    sed -i '' -E "s/(ASSET_VERSION = \"|[?]v=)[0-9]{8}-[0-9]{6}/\\1$SOURCE_HASH/g" "$dir/$f"
    sed -i '' "s/const BUILD_COMMIT = \"dev\";/const BUILD_COMMIT = \"$SOURCE_HASH\";/" "$dir/$f"
  done
}

copy_app "$SRC" "$PAGES_ROOT/updeacon-s3" "${UPDEACON_FILES[@]}"
stamp "$PAGES_ROOT/updeacon-s3" "${UPDEACON_FILES[@]}"
echo "Deployed to $PAGES_ROOT/updeacon-s3"

copy_app "$SRC/seq2bucket" "$PAGES_ROOT/seq2bucket" "${SEQ2BUCKET_FILES[@]}"
stamp "$PAGES_ROOT/seq2bucket" "${SEQ2BUCKET_FILES[@]}"
echo "Deployed to $PAGES_ROOT/seq2bucket"

mkdir -p "$PAGES_ROOT/sapiometer"
cp "$SRC/sapiometer/index.html" "$PAGES_ROOT/sapiometer/index.html"
sed -i '' 's#\.\./sapiometer\.js#./sapiometer.js#; s#\.\./seq2bucket/#./seq2bucket/#' "$PAGES_ROOT/sapiometer/index.html"
copy_app "$SRC" "$PAGES_ROOT/sapiometer" "${SAPIO_FILES[@]:1}"
stamp "$PAGES_ROOT/sapiometer" "${SAPIO_FILES[@]}"
echo "Deployed to $PAGES_ROOT/sapiometer"

cd "$PAGES_ROOT"
branch="$(git rev-parse --abbrev-ref HEAD)"

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

prune_and_stage updeacon-s3 "${UPDEACON_FILES[@]}"
prune_and_stage seq2bucket "${SEQ2BUCKET_FILES[@]}"
prune_and_stage sapiometer "${SAPIO_FILES[@]}"

if git diff --cached --quiet; then
  echo "No GitHub Pages changes to commit"
  exit 0
fi
git commit -m "updeacon $SOURCE_HASH"
git push origin "$branch"
echo "Pushed to GitHub Pages"
