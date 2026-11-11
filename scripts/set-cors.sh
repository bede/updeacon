#!/usr/bin/env bash
# Apply sssender/cors.json to the upload bucket. Endpoint from the profile or AWS_ENDPOINT_URL
set -euo pipefail
aws --profile=climb s3api put-bucket-cors --bucket cli-artic-drc-co-inrb-uploads \
  --cors-configuration "file://$(dirname "${BASH_SOURCE[0]}")/../sssender/cors.json"
