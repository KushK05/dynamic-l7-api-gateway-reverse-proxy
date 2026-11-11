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

func TestHealthEmitsOneEventPerTransition(t *testing.T) {
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
	ev := NewEventLog(50)
	h.SetEvents(ev)
	h.Check("v2", up.URL)
	h.Check("v2", up.URL)
	if n := len(ev.Recent(10)); n != 0 {
		t.Fatalf("healthy probes must not emit, got %d", n)
	}
	unhealthy.Store(true)
	for i := 0; i < 4; i++ {
		h.Check("v2", up.URL)
	}
	got := ev.Recent(10)
	if len(got) != 1 || got[0].Kind != "health" || got[0].Level != "error" || got[0].Upstream != "v2" || got[0].Message != "Upstream v2 ejected after 2 failed probes" {
		t.Fatalf("ejection events: %+v", got)
	}
	unhealthy.Store(false)
	h.Check("v2", up.URL) // inside cooldown: no event
	if n := len(ev.Recent(10)); n != 1 {
		t.Fatalf("cooldown probe must not emit, got %d", n)
	}
	// Probe until the cooldown has elapsed and recovery is reported, rather than
	// betting on a fixed sleep; extra healthy probes emit nothing.
	for deadline := time.Now().Add(5 * time.Second); len(ev.Recent(10)) < 2 && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
		h.Check("v2", up.URL)
	}
	h.Check("v2", up.URL)
	got = ev.Recent(10)
	if len(got) != 2 || got[1].Level != "success" || got[1].Message != "Upstream v2 recovered" {
		t.Fatalf("recovery events: %+v", got)
	}
}
