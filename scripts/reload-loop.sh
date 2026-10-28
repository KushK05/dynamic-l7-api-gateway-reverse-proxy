#!/usr/bin/env bash
# Alternate two known-valid route sets until stopped to generate reload traffic.
set -euo pipefail

ADMIN_URL=${ADMIN_URL:-http://127.0.0.1:9090}
CONFIG_A=${CONFIG_A:-config/catalog-100-0.json}
CONFIG_B=${CONFIG_B:-config/catalog-80-20.json}
while true; do
  revision=$(curl -fsS "$ADMIN_URL/admin/v1/config" | sed -n 's/.*"revision":[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  [[ -n "$revision" ]] || { echo "could not read current revision" >&2; exit 1; }
  for config in "$CONFIG_A" "$CONFIG_B"; do
	# Read the latest revision immediately before PUT so only this loop's own
	# concurrent update can create a conflict.
    curl -fsS "$ADMIN_URL/admin/v1/config" >/dev/null
    revision=$(curl -fsS "$ADMIN_URL/admin/v1/config" | sed -n 's/.*"revision":[[:space:]]*\([0-9][0-9]*\).*/\1/p')
    curl -fsS -X PUT "$ADMIN_URL/admin/v1/config" -H "If-Match: \"$revision\"" -H 'Content-Type: application/json' --data-binary "@$config" >/dev/null || true
    sleep 1
  done
done
