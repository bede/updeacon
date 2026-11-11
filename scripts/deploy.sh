#!/usr/bin/env bash
# Deploy both apps to the bede.github.io Jekyll site:
#   /updeacon-s3/  filter, then upload
#   /sapiometer/   human-content check
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAGES_ROOT="${PAGES_ROOT:-/Users/bede/Research/git/bede.github.io}"

SOURCE_HASH="$(git -C "$SRC" rev-parse --short HEAD)"
# The working tree is copied, so mark it dirty, timestamped as dirty deploys can differ at one HEAD
if [[ -n "$(git -C "$SRC" status --porcelain)" ]]; then
  SOURCE_HASH="$SOURCE_HASH-dirty-$(date -u +%Y%m%d%H%M%S)"
fi

# Each app's file set drives copy, stamp, stage and prune

SSSENDER_LIB=()
while IFS= read -r f; do SSSENDER_LIB+=("sssender/$f"); done < <(
  cd "$SRC/sssender" && find core ui vendor -type f ! -name .DS_Store | sort
)
SSSENDER_FONTS=()
for f in "${SSSENDER_LIB[@]}"; do
  case "$f" in sssender/ui/fonts.css|sssender/ui/fonts/*) SSSENDER_FONTS+=("$f") ;; esac
done

# Shared by both apps
DEACON_FILES=(
  deacon.js
  index-cache.js
  pairing.js
  protocol.js
  version.js
  worker.js
  pkg/deacon_wasm.js
  pkg/deacon_wasm_bg.wasm
)

UPDEACON_FILES=(
  index.html
  mint.html
  app.js
  "${DEACON_FILES[@]}"
  "${SSSENDER_LIB[@]}"
)

# sapiometer/index.html refers to ../, but deploys beside its files
SAPIO_FILES=(
  index.html
  sapiometer.js
  "${DEACON_FILES[@]}"
  sssender/core/format.js
  sssender/core/select.js
  "${SSSENDER_FONTS[@]}"
)

# copy_app <src> <dest> <files…>
copy_app() {
  local from="$1" to="$2"; shift 2
  for f in "$@"; do
    mkdir -p "$(dirname "$to/$f")"
    cp "$from/$f" "$to/$f"
  done
}

# Stamp cache tokens and BUILD_COMMIT with the source hash
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

# Remove tracked files no longer in the set, then stage it
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
