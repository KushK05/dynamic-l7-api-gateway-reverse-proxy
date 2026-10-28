#!/usr/bin/env bash
# Check the key review paths and write a timestamped pass/fail artifact.
set -euo pipefail

BASE_URL=${BASE_URL:-http://127.0.0.1:8080}
ADMIN_URL=${ADMIN_URL:-http://127.0.0.1:9090}
OUT=${OUT:-evidence/review-$(date -u +%Y%m%dT%H%M%SZ).md}
STARTUP_TIMEOUT_SECONDS=${STARTUP_TIMEOUT_SECONDS:-30}
mkdir -p "$(dirname "$OUT")"
failures=0
check(){ local name=$1;shift;if "$@";then printf 'PASS - %s\n' "$name" | tee -a "$OUT";else printf 'FAIL - %s\n' "$name" | tee -a "$OUT";failures=$((failures+1));fi; }
wait_for(){
	# Compose may still be starting after a rebuild; wait for the service rather
	# than reporting every endpoint as failed during the same startup window.
  local name=$1 url=$2 deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
  until curl -fsS --max-time 2 -o /dev/null "$url" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      printf 'FAIL - %s did not become available within %ss\n' "$name" "$STARTUP_TIMEOUT_SECONDS" | tee -a "$OUT"
      failures=$((failures+1))
      return 1
    fi
    sleep 1
  done
  printf 'PASS - %s became available\n' "$name" | tee -a "$OUT"
}
printf '# Review smoke evidence\n\nUTC: %s\n\n' "$(date -u +%FT%TZ)" >"$OUT"
if ! wait_for 'data plane startup' "$BASE_URL/healthz"; then
  printf '\nFailures: %s\n' "$failures" | tee -a "$OUT"
  exit 1
fi
if ! wait_for 'admin plane startup' "$ADMIN_URL/admin/v1/status"; then
  printf '\nFailures: %s\n' "$failures" | tee -a "$OUT"
  exit 1
fi
# These checks start only after both listeners answer, keeping failures specific.
check 'data plane health' curl -fsS -o /dev/null "$BASE_URL/healthz"
check 'readiness' curl -fsS -o /dev/null "$BASE_URL/readyz"
check 'metrics endpoint' curl -fsS -o /dev/null "$BASE_URL/metrics"
check 'admin status' curl -fsS -o /dev/null "$ADMIN_URL/admin/v1/status"
check 'dashboard serves HTML' bash -c 'html=$(curl -fsS "$1/dashboard") && [[ "$html" == *"Dynamic L7 Gateway"* ]]' _ "$ADMIN_URL"
check 'proxy forwards to upstream v1' bash -c 'curl -fsS -o /dev/null -D - "$1/api/catalog/items" | grep -qi "X-Upstream-Id: v1"' _ "$BASE_URL"
if [[ $failures -ne 0 ]];then printf '\nFailures: %s\n' "$failures" | tee -a "$OUT";exit 1;fi
printf '\nAll review smoke checks passed.\n' | tee -a "$OUT"
