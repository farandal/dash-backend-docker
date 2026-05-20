#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed. Install Node.js first." >&2
  exit 1
fi

exec node "${SCRIPT_DIR}/cloudflare-tunnel.js" "$@"
