#!/usr/bin/env bash
# Deploy the apps to the Jekyll blog (bede.github.io) as standalone static apps:
#   /updeacon-s3/  filter with Deacon, then upload (vendored sssender/ inside)
#   /sapiometer/   human-content check, no upload
# No build step. pkg/ (Deacon WASM) and sssender/ are prebuilt.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAGES_ROOT="${PAGES_ROOT:-/Users/bede/Research/git/bede.github.io}"

SOURCE_HASH="$(git -C "$SRC" rev-parse --short HEAD)"
# We copy the working tree, not HEAD, so don't label uncommitted code with a clean hash
if [[ -n "$(git -C "$SRC" status --porcelain)" ]]; then
  # Repeated dirty deployments may contain different bytes at the same HEAD.
  SOURCE_HASH="$SOURCE_HASH-dirty-$(date -u +%Y%m%d%H%M%S)"
fi

# Each app's file set (paths relative to its deployed dir) is the single source of
# truth: files copied, stamped, staged and pruned all derive from it, so a rename in
# SRC can't leave an orphaned copy behind in the deployed app.

# The vendored sssender, as sync-sssender.sh left it
SSSENDER_LIB=()
while IFS= read -r f; do SSSENDER_LIB+=("sssender/$f"); done < <(
  cd "$SRC/sssender" && find core ui vendor -type f ! -name .DS_Store | sort
)
SSSENDER_FONTS=()
for f in "${SSSENDER_LIB[@]}"; do
  case "$f" in sssender/ui/fonts.css|sssender/ui/fonts/*) SSSENDER_FONTS+=("$f") ;; esac
done

UPDEACON_FILES=(
  index.html
  mint.html
  app.js
  deacon.js
  pairing.js
  version.js
  worker.js
  protocol.js
  pkg/deacon_wasm.js
  pkg/deacon_wasm_bg.wasm
  "${SSSENDER_LIB[@]}"
)

# sapiometer/index.html refers to ../sapiometer.js and ../sssender/. Deployed, both sit beside it
SAPIO_FILES=(
  index.html
  sapiometer.js
  worker.js
  protocol.js
  pairing.js
  sssender/core/select.js
  "${SSSENDER_FONTS[@]}"
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

mkdir -p "$PAGES_ROOT/sapiometer"
cp "$SRC/sapiometer/index.html" "$PAGES_ROOT/sapiometer/index.html"
sed -i '' 's#\.\./sapiometer\.js#./sapiometer.js#; s#\.\./sssender/#./sssender/#' "$PAGES_ROOT/sapiometer/index.html"
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
prune_and_stage sapiometer "${SAPIO_FILES[@]}"

if git diff --cached --quiet; then
  echo "No GitHub Pages changes to commit"
  exit 0
fi
git commit -m "updeacon $SOURCE_HASH"
git push origin "$branch"
echo "Pushed to GitHub Pages"
