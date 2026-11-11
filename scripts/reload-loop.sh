#!/usr/bin/env bash
# Toggle the catalog route's canary weights (100/0 then 80/20) on the live config
# until stopped, to generate reload traffic. Every other route is left untouched,
# and the starting config is restored on exit so the persisted routes survive.
set -euo pipefail

ADMIN_URL=${ADMIN_URL:-http://127.0.0.1:9090}
ROUTE_ID=${ROUTE_ID:-catalog}
INTERVAL=${INTERVAL:-1}
MAX_ITERATIONS=${MAX_ITERATIONS:-0} # 0 means run until stopped

current_revision(){ curl -fsS "$ADMIN_URL/admin/v1/config" | sed -n 's/.*"revision":[[:space:]]*\([0-9][0-9]*\).*/\1/p'; }
put_config(){ # $1 = file holding the config object
  local revision
  revision=$(current_revision)
  [[ -n "$revision" ]] || return 1
  curl -fsS -X PUT "$ADMIN_URL/admin/v1/config" -H "If-Match: \"$revision\"" -H 'Content-Type: application/json' --data-binary "@$1" >/dev/null
}

initial_config=$(mktemp)
work_config=$(mktemp)
# Snapshot the live config (not a checked-in file) so any demo routes come back.
curl -fsS "$ADMIN_URL/admin/v1/config" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["config"]))' >"$initial_config"
[[ -s "$initial_config" ]] || { echo "could not read current config" >&2; exit 1; }
cleanup(){
  put_config "$initial_config" || echo "warning: could not restore the starting config" >&2
  rm -f "$initial_config" "$work_config"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Rewrite only the first two upstream weights of the target route.
toggle(){ python3 - "$initial_config" "$ROUTE_ID" "$1" "$2" >"$work_config" <<'PY'
import json,sys
cfg=json.load(open(sys.argv[1]))
route=next(r for r in cfg["routes"] if r["id"]==sys.argv[2])
route["upstreams"][0]["weight"]=int(sys.argv[3])
route["upstreams"][1]["weight"]=int(sys.argv[4])
print(json.dumps(cfg))
PY
}

n=0
while [[ "$MAX_ITERATIONS" -eq 0 || "$n" -lt "$MAX_ITERATIONS" ]]; do
  for weights in "100 0" "80 20"; do
    # shellcheck disable=SC2086
    toggle $weights
    # A concurrent writer can win the revision race; skip and try the next toggle.
    put_config "$work_config" || true
    sleep "$INTERVAL"
  done
  n=$((n + 1))
done
