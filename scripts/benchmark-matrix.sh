#!/usr/bin/env bash
# Run a repeatable load schedule sized either for the EC2 demo or a larger host.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"
source "$SCRIPT_DIR/lib/docker.sh"

BENCH_PROFILE=${BENCH_PROFILE:-demo}
case "$BENCH_PROFILE" in
  demo)
    # Keep the default run modest enough to share a 1 GiB t3.micro with the app.
    DEFAULT_RPS="5 10 20"
    DEFAULT_WARMUP=2
    DEFAULT_DURATION=10
    DEFAULT_REPETITIONS=1
    ;;
  performance)
    # Preserve the original schedule for a larger, dedicated benchmark host.
    DEFAULT_RPS="100 500 1000"
    DEFAULT_WARMUP=15
    DEFAULT_DURATION=60
    DEFAULT_REPETITIONS=3
    ;;
  *)
    echo "BENCH_PROFILE must be demo or performance" >&2
    exit 2
    ;;
esac

read -r -a rps_values <<<"${BENCH_RPS:-$DEFAULT_RPS}"
warmup=${BENCH_WARMUP:-$DEFAULT_WARMUP}
duration=${BENCH_DURATION:-$DEFAULT_DURATION}
repetitions=${BENCH_REPETITIONS:-$DEFAULT_REPETITIONS}
if (( ${#rps_values[@]} == 0 || warmup < 0 || duration < 1 || repetitions < 1 )); then
  echo "Invalid benchmark schedule" >&2
  exit 2
fi
if [[ "$BENCH_PROFILE" == demo && -z "${BENCH_RPS:-}" && -z "${BENCH_DURATION:-}" ]]; then
  echo "Demo profile: ${rps_values[*]} RPS, ${warmup}s warm-up, ${duration}s measured, ${repetitions} repetition(s)."
fi

mkdir -p evidence
for rps in "${rps_values[@]}"; do
  if ! [[ "$rps" =~ ^[0-9]+$ ]] || (( rps < 1 )); then
    echo "Invalid request rate: $rps" >&2
    exit 2
  fi
done

scenarios=(direct proxy-no-jwt proxy-jwt proxy-reload)
if [[ -z "${JWT_BENCH_TOKEN:-}" && -t 0 ]]; then
  read -r -s -p 'Paste a short-lived JWT_BENCH_TOKEN: ' JWT_BENCH_TOKEN
  echo
  export JWT_BENCH_TOKEN
fi
if [[ -z "${JWT_BENCH_TOKEN:-}" ]]; then
  echo "Set JWT_BENCH_TOKEN to a short-lived valid token before running the matrix." >&2
  exit 2
fi

# Check both sides of token delivery before creating benchmark artifacts. This
# avoids reporting a misleading revision failure when an expired token, wrong
# key, or sudo environment boundary turns every protected request into a 401.
token_status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
  -H "Authorization: Bearer $JWT_BENCH_TOKEN" http://127.0.0.1:8080/api/secure/benchmark-preflight)
if [[ "$token_status" != 200 ]]; then
  echo "JWT preflight returned HTTP $token_status. Generate a fresh token from the workstation key and verify it before rerunning." >&2
  exit 1
fi
if ! gateway_docker compose --profile tools run --rm --no-deps --entrypoint /bin/sh bench -c 'test -n "${JWT_BENCH_TOKEN:-}"'; then
  echo "JWT preflight could not pass the token into the bench container." >&2
  exit 1
fi

reload_pid=""
cleanup(){
  if [[ -n "$reload_pid" ]]; then kill "$reload_pid" 2>/dev/null || true; wait "$reload_pid" 2>/dev/null || true; fi
}
# Always stop the config writer if a benchmark exits early or receives a signal.
trap cleanup EXIT
trap 'exit 130' INT TERM

for rps in "${rps_values[@]}"; do
  for scenario in "${scenarios[@]}"; do
    for repetition in $(seq 1 "$repetitions"); do
      case "$scenario" in
        direct) url="http://upstream-v1:9101/api/catalog/items" ;;
        proxy-no-jwt) url="http://gateway:8080/api/catalog/items" ;;
        proxy-jwt) url="http://gateway:8080/api/secure/items" ;;
        proxy-reload) url="http://gateway:8080/api/catalog/items" ;;
      esac
      args=(-url "$url" -rps "$rps" -warmup "$warmup" -duration "$duration")
      if [[ "$scenario" != direct ]]; then args+=(-verify-revision); fi
      reload_pid=""
      if [[ "$scenario" == proxy-reload ]]; then
        # Exercise atomic snapshot replacement while a small request stream is active.
        scripts/reload-loop.sh >/dev/null 2>&1 &
        reload_pid=$!
      fi
      report="evidence/${BENCH_PROFILE}-${scenario}-${rps}-run${repetition}.json"
      echo "profile=$BENCH_PROFILE scenario=$scenario rps=$rps repetition=$repetition"
      gateway_docker compose --progress quiet --profile tools run --rm --no-deps \
        --user "$(id -u):$(id -g)" bench "${args[@]}" -out "/$report" \
        >"${report%.json}.stdout.json"
      if [[ -n "$reload_pid" ]]; then kill "$reload_pid" 2>/dev/null || true; wait "$reload_pid" 2>/dev/null || true; reload_pid=""; fi
      gateway_docker compose ps --format json >"${report%.json}.containers.json"
      # Save adjacent resource snapshots so the small host's contention is visible.
      gateway_docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}' >"${report%.json}.resources.csv"
      if [[ "$scenario" != direct ]]; then
        python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["revision_mismatches"] == 0, d' "$report"
      fi
    done
  done
done
