#!/usr/bin/env bash
# Run a repeatable load schedule across direct, proxy, JWT, and reload scenarios.
set -euo pipefail

mkdir -p evidence
reload_pid=""
cleanup(){ if [[ -n "$reload_pid" ]]; then kill "$reload_pid" 2>/dev/null || true; fi; }
# Always stop the config writer if the benchmark exits early or receives a signal.
trap cleanup EXIT INT TERM
for rps in 100 500 1000; do
  for scenario in direct proxy-no-jwt proxy-jwt proxy-reload; do
    for repetition in 1 2 3; do
      case "$scenario" in
        direct) url="http://upstream-v1:9101/api/catalog/items"; token="" ;;
        proxy-no-jwt) url="http://gateway:8080/api/catalog/items"; token="" ;;
        proxy-jwt) url="http://gateway:8080/api/secure/items"; token="${JWT_BENCH_TOKEN:?Set a short-lived valid JWT_BENCH_TOKEN}" ;;
        proxy-reload) url="http://gateway:8080/api/catalog/items"; token="" ;;
      esac
      args=(-url "$url" -rps "$rps" -warmup 15 -duration 60)
      if [[ -n "$token" ]]; then args+=(-token "$token"); fi
      if [[ "$scenario" != direct ]]; then args+=(-verify-revision); fi
      reload_pid=""
      if [[ "$scenario" == proxy-reload ]]; then
        # Exercise snapshot replacement while requests remain under load.
        scripts/reload-loop.sh >/dev/null 2>&1 &
        reload_pid=$!
      fi
      echo "scenario=$scenario rps=$rps repetition=$repetition"
      docker compose --progress quiet --profile tools run --rm --no-deps bench \
        "${args[@]}" -out "/evidence/${scenario}-${rps}-run${repetition}.json" \
        >"evidence/${scenario}-${rps}-run${repetition}.stdout.json"
      if [[ -n "$reload_pid" ]]; then kill "$reload_pid" 2>/dev/null || true; reload_pid=""; fi
      docker compose ps --format json >"evidence/${scenario}-${rps}-run${repetition}.containers.json"
      # Capture container resource use adjacent to each raw benchmark result.
      docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}' >"evidence/${scenario}-${rps}-run${repetition}.resources.csv"
      if [[ "$scenario" != direct ]]; then
        python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["revision_mismatches"] == 0, d' "evidence/${scenario}-${rps}-run${repetition}.json"
      fi
    done
  done
done
