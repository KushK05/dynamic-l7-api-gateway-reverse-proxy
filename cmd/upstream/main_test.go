package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testHandler(p profile, rnd func(int) int) http.Handler {
	return newHandler("v1", "orders", p, &fault{}, rnd)
}

func do(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestFaultRoundTripAndReset(t *testing.T) {
	h := testHandler(profile{}, func(n int) int { return 0 })
	if rec := do(h, "POST", "/admin/fault", `{"delay_ms":5,"status":503,"unhealthy":true,"error_rate_percent":40}`); rec.Code != 204 {
		t.Fatalf("post code %d", rec.Code)
	}
	var got map[string]any
	rec := do(h, "GET", "/admin/fault", "")
	if rec.Code != 200 {
		t.Fatalf("get code %d", rec.Code)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["delay_ms"] != float64(5) || got["status"] != float64(503) || got["unhealthy"] != true || got["error_rate_percent"] != float64(40) {
		t.Fatalf("unexpected state %v", got)
	}
	if rec := do(h, "POST", "/admin/reset", ""); rec.Code != 204 {
		t.Fatalf("reset code %d", rec.Code)
	}
	rec = do(h, "GET", "/admin/fault", "")
	got = nil
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["delay_ms"] != float64(0) || got["status"] != float64(0) || got["unhealthy"] != false || got["error_rate_percent"] != float64(0) {
		t.Fatalf("not cleared %v", got)
	}
}

func TestErrorRate(t *testing.T) {
	h := testHandler(profile{}, func(n int) int { return 99 })
	do(h, "POST", "/admin/fault", `{"error_rate_percent":100}`)
	if rec := do(h, "GET", "/x", ""); rec.Code != 500 {
		t.Fatalf("rate 100 should fail, got %d", rec.Code)
	}
	do(h, "POST", "/admin/fault", `{"error_rate_percent":0}`)
	if rec := do(h, "GET", "/x", ""); rec.Code != 200 {
		t.Fatalf("rate 0 should pass, got %d", rec.Code)
	}
}

func TestBaseDelayAndServiceField(t *testing.T) {
	h := testHandler(profile{base: 30 * time.Millisecond, jitter: 10 * time.Millisecond}, func(n int) int { return 5 * int(time.Millisecond) })
	start := time.Now()
	rec := do(h, "GET", "/orders", "")
	if el := time.Since(start); el < 35*time.Millisecond {
		t.Fatalf("expected base+jitter delay, got %v", el)
	}
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["service"] != "orders" || got["upstream"] != "v1" || rec.Header().Get("X-Upstream-ID") != "v1" {
		t.Fatalf("unexpected response %v", got)
	}
}

func TestInvalidFaultAndResetMethod(t *testing.T) {
	h := testHandler(profile{}, func(n int) int { return 0 })
	for _, b := range []string{`{`, `{"delay_ms":-1}`, `{"delay_ms":30001}`, `{"error_rate_percent":101}`} {
		if rec := do(h, "POST", "/admin/fault", b); rec.Code != 400 {
			t.Fatalf("%s: got %d", b, rec.Code)
		}
	}
	if rec := do(h, "GET", "/admin/reset", ""); rec.Code != 405 {
		t.Fatalf("reset GET got %d", rec.Code)
	}
}
