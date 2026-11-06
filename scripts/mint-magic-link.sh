#!/usr/bin/env bash
# Mint an updeacon-s3 link with sssender's script and updeacon's page, root and bucket.
# Later flags win, e.g. --bucket or --page.
#
#   scripts/mint-magic-link.sh inrb-batch3 --profile climb --endpoint https://s3.climb.ac.uk
set -euo pipefail
exec python3 "$(dirname "${BASH_SOURCE[0]}")/../sssender/scripts/mint-magic-link.py" \
  --page https://bede.im/updeacon-s3/ \
  --root updeacon/ \
  --bucket cli-artic-drc-co-inrb-uploads \
  "$@"
