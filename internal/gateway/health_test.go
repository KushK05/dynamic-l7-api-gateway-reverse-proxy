package gateway

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestHealthEjectionHonorsCooldownAndRequiresRecovery(t *testing.T) {
	// Flip probe responses deterministically to cover ejection, cooldown, and recovery.
	var unhealthy atomic.Bool
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if unhealthy.Load() {
			http.Error(w, "unhealthy", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer up.Close()
	m := NewMetrics()
	h := NewHealth(m)
	h.cooldown = 25 * time.Millisecond
	h.Check("v1", up.URL)
	if !h.Allowed("v1") {
		t.Fatal("healthy upstream should start allowed")
	}
	unhealthy.Store(true)
	// Two consecutive failures should eject; a single failed probe is tolerated.
	h.Check("v1", up.URL)
	h.Check("v1", up.URL)
	if h.Allowed("v1") {
		t.Fatal("two failed probes should eject upstream")
	}
	state := h.Snapshot()["v1"]
	if state.EjectedUntil.IsZero() {
		t.Fatal("ejected upstream must have a cooldown")
	}
	unhealthy.Store(false)
	h.Check("v1", up.URL)
	// A healthy target stays ejected until the cooldown expires.
	if h.Allowed("v1") {
		t.Fatal("successful probe must not bypass cooldown")
	}
	h.mu.Lock()
	state = h.state["v1"]
	state.EjectedUntil = time.Now().Add(-time.Millisecond)
	h.state["v1"] = state
	h.mu.Unlock()
	unhealthy.Store(false)
	h.Check("v1", up.URL)
	if !h.Allowed("v1") {
		t.Fatal("healthy probe after cooldown should restore upstream")
	}
	unhealthy.Store(true)
	h.mu.Lock()
	h.state["v1"] = upstreamHealth{Healthy: false, Failures: 3, EjectedUntil: time.Now().Add(-time.Millisecond)}
	h.mu.Unlock()
	h.Check("v1", up.URL)
	if h.Allowed("v1") {
		t.Fatal("failed probe after cooldown must not restore upstream")
	}
	unhealthy.Store(false)
	h.Check("v1", up.URL)
	if !h.Allowed("v1") {
		t.Fatal("healthy probe after expired cooldown should restore upstream")
	}
}
