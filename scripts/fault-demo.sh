#!/usr/bin/env bash
# Exercise injected latency, probe ejection, complete process loss, and recovery.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"
source "$SCRIPT_DIR/lib/docker.sh"

# Use a low, steady request stream so the dashboard shows the faults without
# consuming the small EC2 instance like the larger load profiles do.
traffic_pid=""
traffic() {
  for _ in $(seq 1 120); do
    curl -fsS --max-time 2 http://127.0.0.1:8080/api/catalog/fault-demo >/dev/null || true
    sleep 0.25
  done
}
# Route all control actions through the internal Compose-only fault client.
fault(){ gateway_docker compose --profile tools run --rm --no-deps --entrypoint /usr/local/bin/faultctl bench "$@"; }
show_v2(){ curl -fsS http://127.0.0.1:9090/admin/v1/status | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["upstreams"].get("v2",{}), indent=2))'; }
cleanup(){
  fault -upstream http://upstream-v2:9102 -reset || true
  gateway_docker compose start upstream-v2 >/dev/null 2>&1 || true
  if [[ -n "$traffic_pid" ]]; then kill "$traffic_pid" 2>/dev/null || true; wait "$traffic_pid" 2>/dev/null || true; fi
}

# A canary makes v2 part of ordinary catalog traffic while preserving a known
# healthy v1 target for the failover portion of the demonstration.
initial_config="$(mktemp)"
curl -fsS http://127.0.0.1:9090/admin/v1/config | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["config"]))' >"$initial_config"
restore_config(){
  revision=$(curl -fsS http://127.0.0.1:9090/admin/v1/config | sed -n 's/.*"revision":[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  curl -fsS -X PUT http://127.0.0.1:9090/admin/v1/config -H "If-Match: \"$revision\"" -H 'Content-Type: application/json' --data-binary "@$initial_config" >/dev/null || true
  rm -f "$initial_config"
}
finish(){ cleanup; restore_config; }
trap finish EXIT
trap 'exit 130' INT TERM
revision=$(curl -fsS http://127.0.0.1:9090/admin/v1/config | sed -n 's/.*"revision":[[:space:]]*\([0-9][0-9]*\).*/\1/p')
curl -fsS -X PUT http://127.0.0.1:9090/admin/v1/config -H "If-Match: \"$revision\"" -H 'Content-Type: application/json' --data-binary @config/catalog-80-20.json >/dev/null
traffic & traffic_pid=$!

fault -upstream http://upstream-v2:9102 -delay-ms 900
echo 'Injected 900 ms latency into v2. Watch latency and request traffic on the dashboard.'
sleep 5
fault -upstream http://upstream-v2:9102 -status 503 -unhealthy true
echo 'Injected 503 responses and failed health probes. Watch v2 move to EJECTED.'
sleep 4
show_v2
fault -upstream http://upstream-v2:9102 -reset
sleep 4
echo 'Cleared the application fault; v2 can recover after its cooldown.'
gateway_docker compose stop upstream-v2
echo 'Stopped the complete v2 process. Watch v1 continue serving traffic.'
sleep 4
show_v2
gateway_docker compose start upstream-v2
for _ in $(seq 1 12); do
  if curl -fsS http://127.0.0.1:9090/admin/v1/status | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["upstreams"].get("v2",{}).get("healthy",False) else 1)'; then break; fi
  sleep 1
done
echo 'v2 restarted and health probes are recovering.'
