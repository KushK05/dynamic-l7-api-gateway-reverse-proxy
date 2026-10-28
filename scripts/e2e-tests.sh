#!/usr/bin/env bash
# Exercise authentication, routing reloads under traffic, and upstream recovery.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"
source "$SCRIPT_DIR/lib/docker.sh"

BASE_URL=${BASE_URL:-http://127.0.0.1:8080}
ADMIN_URL=${ADMIN_URL:-http://127.0.0.1:9090}
E2E_PROFILE=${E2E_PROFILE:-demo}
OUT=${OUT:-evidence/e2e-$(date -u +%Y%m%dT%H%M%SZ)}
if [[ "$OUT" != evidence/* ]]; then echo "OUT must remain under evidence/" >&2; exit 2; fi
mkdir -p "$OUT"
case "$E2E_PROFILE" in
  demo)
    # Modest load keeps this end-to-end run usable on the deployed t3.micro.
    CANARY_RPS=${E2E_CANARY_RPS:-20}
    CANARY_SECONDS=${E2E_CANARY_SECONDS:-15}
    LOAD_RPS=${E2E_LOAD_RPS:-10}
    LOAD_SECONDS=${E2E_LOAD_SECONDS:-20}
    RELOAD_ITERATIONS=${E2E_RELOAD_ITERATIONS:-10}
    ;;
  full)
    # Preserve the longer acceptance schedule for a dedicated larger host.
    CANARY_RPS=${E2E_CANARY_RPS:-500}
    CANARY_SECONDS=${E2E_CANARY_SECONDS:-20}
    LOAD_RPS=${E2E_LOAD_RPS:-200}
    LOAD_SECONDS=${E2E_LOAD_SECONDS:-45}
    RELOAD_ITERATIONS=${E2E_RELOAD_ITERATIONS:-100}
    ;;
  *) echo "E2E_PROFILE must be demo or full" >&2; exit 2 ;;
esac
initial_config=$(mktemp)
# Preserve the starting routes so cleanup can return the running gateway to baseline.
curl -fsS "$ADMIN_URL/admin/v1/config" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["config"]))' >"$initial_config"
bench_pid=""
# Restore routes and clear injected faults even if a run is interrupted.
cleanup(){
  if [[ -n "$bench_pid" ]]; then kill "$bench_pid" 2>/dev/null || true; wait "$bench_pid" 2>/dev/null || true; fi
  gateway_docker compose --profile tools run --rm --no-deps --entrypoint /usr/local/bin/faultctl bench -upstream http://upstream-v2:9102 -reset >/dev/null 2>&1 || true
  gateway_docker compose start upstream-v2 >/dev/null 2>&1 || true
  revision=$(curl -fsS "$ADMIN_URL/admin/v1/config" | sed -n 's/.*"revision":[[:space:]]*\([0-9][0-9]*\).*/\1/p' || true)
  if [[ -n "$revision" ]]; then curl -fsS -X PUT "$ADMIN_URL/admin/v1/config" -H "If-Match: \"$revision\"" -H 'Content-Type: application/json' --data-binary "@$initial_config" >/dev/null || true; fi
  rm -f "$initial_config"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

valid=${JWT_VALID_TOKEN:-}
if [[ -z "$valid" && -t 0 ]]; then
  read -r -s -p 'Paste a short-lived JWT_VALID_TOKEN: ' valid
  echo
fi
if [[ -z "$valid" ]]; then echo "Set JWT_VALID_TOKEN from jwtgen token." >&2; exit 2; fi
JWT_PRIVATE_KEY=${JWT_PRIVATE_KEY:-${HOME}/.config/dynamic-l7/review-signing-private.pem}
export JWT_BENCH_TOKEN=${JWT_BENCH_TOKEN:-$valid}
jwtgen(){
  # Prefer the local Go toolchain, with a container fallback for Docker-only hosts.
  if command -v go >/dev/null 2>&1; then
    go run ./cmd/jwtgen token -private "$JWT_PRIVATE_KEY" "$@"
  else
    key_dir=$(dirname "$JWT_PRIVATE_KEY")
    key_name=$(basename "$JWT_PRIVATE_KEY")
    gateway_docker run --rm -v "$PWD:/workspace" -v "$key_dir:/keys:ro" -w /workspace golang:1.23-alpine go run ./cmd/jwtgen token -private "/keys/$key_name" "$@"
  fi
}
status(){ curl -sS -o /dev/null -w '%{http_code}' "$@"; }
[[ $(status "$BASE_URL/api/secure/probe") == 401 ]]
[[ $(status -H 'Authorization: Bearer forged.token.value' "$BASE_URL/api/secure/probe") == 401 ]]
[[ $(status -H "Authorization: Bearer $valid" "$BASE_URL/api/secure/probe") == 200 ]]
if [[ -r "$JWT_PRIVATE_KEY" ]]; then
  expired=$(jwtgen -expires-in=-1m)
  wrong_aud=$(jwtgen -audience wrong-audience)
  wrong_issuer=$(jwtgen -issuer wrong-issuer)
  unknown_kid=$(jwtgen -kid unknown-key)
  [[ $(status -H "Authorization: Bearer $expired" "$BASE_URL/api/secure/probe") == 401 ]]
  [[ $(status -H "Authorization: Bearer $wrong_aud" "$BASE_URL/api/secure/probe") == 401 ]]
  [[ $(status -H "Authorization: Bearer $wrong_issuer" "$BASE_URL/api/secure/probe") == 401 ]]
  [[ $(status -H "Authorization: Bearer $unknown_kid" "$BASE_URL/api/secure/probe") == 401 ]]
  # Change the declared algorithm to verify algorithm substitution is rejected.
  disallowed=$(python3 - "$valid" <<'PY'
import base64,json,sys
token=sys.argv[1].split('.')
header=json.loads(base64.urlsafe_b64decode(token[0]+'==='))
header['alg']='HS256'
token[0]=base64.urlsafe_b64encode(json.dumps(header,separators=(',',':')).encode()).decode().rstrip('=')
print('.'.join(token))
PY
)
  [[ $(status -H "Authorization: Bearer $disallowed" "$BASE_URL/api/secure/probe") == 401 ]]
  echo 'JWT rejection matrix passed, including signed claim attacks.'
else
  echo 'JWT checks passed for missing, forged, and valid tokens; private signing key remains on the workstation.'
fi

rev=$(curl -fsS "$ADMIN_URL/admin/v1/config" | sed -n 's/.*"revision":[[:space:]]*\([0-9][0-9]*\).*/\1/p')
# Install the canary route, then check both its split and the revision echoed per response.
curl -fsS -X PUT "$ADMIN_URL/admin/v1/config" -H "If-Match: \"$rev\"" -H 'Content-Type: application/json' --data-binary @config/catalog-80-20.json >/dev/null
canary_report="${OUT#evidence/}/canary-80-20.json"
canary_min=$((CANARY_RPS * CANARY_SECONDS * 8 / 10))
gateway_docker compose --progress quiet --profile tools run --rm --no-deps --user "$(id -u):$(id -g)" bench \
  -url http://gateway:8080/api/catalog/canary -rps "$CANARY_RPS" -warmup 0 -duration "$CANARY_SECONDS" \
  -verify-revision -out "/evidence/$canary_report" >"$OUT/canary.stdout.json"
python3 - "$OUT/canary-80-20.json" "$canary_min" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]));n=d['requests'];v1=d['upstream_counts'].get('v1',0)
if n < int(sys.argv[2]) or d['errors'] or d['revision_mismatches'] or not (.75 <= v1/n <= .85):
    raise SystemExit(f"canary acceptance failed: {d}")
print(f"80/20 canary sample: {v1}/{n} requests to v1 ({v1/n:.1%})")
PY

load_report="${OUT#evidence/}/reload-load.json"
gateway_docker compose --progress quiet --profile tools run --rm --no-deps --user "$(id -u):$(id -g)" bench \
  -url http://gateway:8080/api/catalog/load -rps "$LOAD_RPS" -warmup 0 -duration "$LOAD_SECONDS" \
  -verify-revision -out "/evidence/$load_report" >"$OUT/load.stdout.json" & bench_pid=$!
# While requests are flowing, alternate accepted configs and assert malformed
# payloads and stale revisions are rejected every cycle.
for i in $(seq 1 "$RELOAD_ITERATIONS"); do
  rev=$(curl -fsS "$ADMIN_URL/admin/v1/config" | sed -n 's/.*"revision":[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  file=config/catalog-100-0.json
  (( i % 2 == 0 )) && file=config/catalog-80-20.json
  code=$(curl -sS -o "$OUT/reload-response.json" -w '%{http_code}' -X PUT "$ADMIN_URL/admin/v1/config" -H "If-Match: \"$rev\"" -H 'Content-Type: application/json' --data-binary "@$file")
  [[ $code == 200 ]]
  rev=$(curl -fsS "$ADMIN_URL/admin/v1/config" | sed -n 's/.*"revision":[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$ADMIN_URL/admin/v1/config" -H "If-Match: \"$rev\"" -H 'Content-Type: application/json' --data-binary '{"version":1,"routes":[]}')
  [[ $code == 400 ]]
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$ADMIN_URL/admin/v1/config" -H "If-Match: \"$((rev-1))\"" -H 'Content-Type: application/json' --data-binary "@config/catalog-100-0.json")
  [[ $code == 412 ]]
done
wait "$bench_pid"
bench_pid=""
python3 - "$OUT/load.stdout.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
if d['errors'] or d['revision_mismatches']:
    raise SystemExit(f"load had {d['errors']} errors and {d['revision_mismatches']} revision mismatches")
print(f"concurrent load had {d['requests']} responses with no errors or mixed revisions")
PY
echo "$RELOAD_ITERATIONS accepted, invalid, and stale reloads completed while load was active"

gateway_docker compose --profile tools run --rm --no-deps --entrypoint /usr/local/bin/faultctl bench -upstream http://upstream-v2:9102 -delay-ms 500 -status 503
# Stop the upstream process as well as injecting application faults, exercising
# complete target loss and subsequent probe-driven recovery.
gateway_docker compose stop upstream-v2
for i in $(seq 1 6); do
  if curl -fsS "$ADMIN_URL/admin/v1/status" | python3 -c 'import json,sys; sys.exit(0 if not json.load(sys.stdin)["upstreams"].get("v2",{}).get("healthy",False) else 1)'; then break; fi
  sleep 0.5
done
curl -fsS "$ADMIN_URL/admin/v1/status" | python3 -c 'import json,sys; assert not json.load(sys.stdin)["upstreams"].get("v2",{}).get("healthy",False), "v2 was not ejected within 3 seconds"'
for i in $(seq 1 8); do curl -fsS "$BASE_URL/api/catalog/failover" >/dev/null; done
gateway_docker compose start upstream-v2
for i in $(seq 1 20); do
  if curl -fsS "$ADMIN_URL/admin/v1/status" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["upstreams"].get("v2",{}).get("healthy",False) else 1)'; then break; fi
  sleep 1
done
curl -fsS "$ADMIN_URL/admin/v1/status" | python3 -c 'import json,sys; assert json.load(sys.stdin)["upstreams"].get("v2",{}).get("healthy",False), "v2 did not recover"'
echo 'upstream fault, failover, recovery, and reset completed'
