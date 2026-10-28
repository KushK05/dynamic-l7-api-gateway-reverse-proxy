#!/usr/bin/env bash
# Stage latency, HTTP failures, and probe failures, then demonstrate recovery.
set -euo pipefail

compose=(docker compose --profile tools)
# Route all control actions through the internal Compose-only fault client.
fault(){ "${compose[@]}" run --rm --no-deps --entrypoint /usr/local/bin/faultctl bench "$@"; }
# Always clear injected state even if the operator interrupts the demo.
cleanup(){ fault -upstream http://upstream-v2:9102 -reset || true; }
trap cleanup EXIT INT TERM
fault -upstream http://upstream-v2:9102 -delay-ms 1200
echo 'Injected 1.2s latency into v2. Observe p95 and timeout handling.'
sleep 5
fault -upstream http://upstream-v2:9102 -status 503 -unhealthy true
echo 'Injected 503 and failed probes. Observe ejection/status counters.'
sleep 5
fault -upstream http://upstream-v2:9102 -reset
echo 'Fault cleared. Observe health probe recovery.'
