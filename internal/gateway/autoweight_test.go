package gateway

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func autoConfig(auto bool, w1, w2 int) Config {
	return Config{Version: 1, Routes: []Route{{ID: "catalog", Priority: 1, AutoWeight: auto, Match: Match{Methods: []string{"GET"}, PathPrefix: "/api/catalog"}, TimeoutMS: 1000, Upstreams: []Upstream{{ID: "v1", URL: "http://127.0.0.1:9101", Weight: w1}, {ID: "v2", URL: "http://127.0.0.1:9102", Weight: w2}}}}}
}

type awRig struct {
	store  *Store
	m      *Metrics
	clock  *fakeClock
	h      *Health
	events *EventLog
	a      *AutoWeigher
}

func newAWRig(c Config) *awRig {
	s := &Store{}
	s.Activate(c, 1)
	m, clock := newClockMetrics()
	h := NewHealth(m)
	e := NewEventLog(100)
	return &awRig{s, m, clock, h, e, NewAutoWeigher(s, m, h, e)}
}

// traffic records n requests per second for each upstream over 10 seconds, then
// advances the clock so those seconds are complete.
func (r *awRig) traffic(up string, perSec int, status int, d time.Duration) {
	for sec := 0; sec < 10; sec++ {
		for i := 0; i < perSec; i++ {
			r.m.observe(1, "catalog", up, status, d, 0, 0)
		}
		r.clock.Advance(time.Second)
	}
	r.clock.Advance(-10 * time.Second)
}

func (r *awRig) finish() { r.clock.Advance(10 * time.Second) }

func sum(m map[string]int) int {
	t := 0
	for _, v := range m {
		t += v
	}
	return t
}

func (r *awRig) w() map[string]int { return r.a.Weights()["catalog"] }

func TestAutoWeightShiftsTowardFasterUpstream(t *testing.T) {
	r := newAWRig(autoConfig(true, 50, 50))
	r.traffic("v1", 10, 200, 10*time.Millisecond)
	r.traffic("v2", 10, 200, 400*time.Millisecond)
	r.finish()
	for i := 0; i < 12; i++ {
		r.a.tick()
	}
	w := r.w()
	if w["v1"] <= 80 || w["v2"] != 5 || sum(w) != 100 {
		t.Fatalf("expected v1 to dominate with v2 >= 5, got %v", w)
	}
	if len(r.events.Recent(10)) == 0 {
		t.Fatal("expected a weights event")
	}
	ev := r.events.Recent(1)[0]
	if ev.Kind != "weights" || ev.Level != "info" || ev.Route != "catalog" {
		t.Fatalf("bad event %+v", ev)
	}
}

func TestAutoWeightErrorsLowerScore(t *testing.T) {
	r := newAWRig(autoConfig(true, 50, 50))
	r.traffic("v1", 10, 200, 20*time.Millisecond)
	r.traffic("v2", 9, 500, 20*time.Millisecond)
	r.traffic("v2", 1, 200, 20*time.Millisecond)
	r.finish()
	for i := 0; i < 12; i++ {
		r.a.tick()
	}
	if w := r.w(); w["v1"] < 90 || w["v2"] != 5 || sum(w) != 100 {
		t.Fatalf("erroring upstream should be floored near 5, got %v", w)
	}
}

func TestAutoWeightUnhealthyGetsZero(t *testing.T) {
	r := newAWRig(autoConfig(true, 50, 50))
	r.traffic("v1", 10, 200, 10*time.Millisecond)
	r.traffic("v2", 10, 200, 10*time.Millisecond)
	r.finish()
	r.h.mu.Lock()
	r.h.state["v2"] = upstreamHealth{Healthy: false, EjectedUntil: time.Now().Add(time.Hour)}
	r.h.mu.Unlock()
	r.a.tick()
	if w := r.w(); w["v2"] != 0 || w["v1"] != 100 {
		t.Fatalf("got %v", w)
	}
}

func TestAutoWeightAllUnhealthyFallsBackToConfigured(t *testing.T) {
	r := newAWRig(autoConfig(true, 70, 30))
	r.h.mu.Lock()
	r.h.state["v1"] = upstreamHealth{}
	r.h.state["v2"] = upstreamHealth{}
	r.h.mu.Unlock()
	r.a.tick()
	if w := r.w(); w["v1"] != 70 || w["v2"] != 30 {
		t.Fatalf("got %v", w)
	}
}

func TestAutoWeightNoDataIsNeutral(t *testing.T) {
	r := newAWRig(autoConfig(true, 70, 30))
	for i := 0; i < 12; i++ {
		r.a.tick()
	}
	if w := r.w(); w["v1"] < 50 || w["v1"] > 51 || sum(w) != 100 {
		t.Fatalf("no data should converge to (nearly) an even split, got %v", w)
	}
}

func TestAutoWeightLeavesNonAutoRouteAlone(t *testing.T) {
	r := newAWRig(autoConfig(false, 80, 20))
	r.traffic("v1", 10, 200, 10*time.Millisecond)
	r.traffic("v2", 10, 200, 900*time.Millisecond)
	r.finish()
	for i := 0; i < 5; i++ {
		r.a.tick()
	}
	if w := r.w(); w["v1"] != 80 || w["v2"] != 20 {
		t.Fatalf("got %v", w)
	}
	route := r.store.Load().Config.Routes[0]
	eff := r.a.Effective(route)
	if eff[0].Weight != 80 || eff[1].Weight != 20 {
		t.Fatalf("got %+v", eff)
	}
}

func TestAutoWeightEffectiveCopiesAndNilSafe(t *testing.T) {
	r := newAWRig(autoConfig(true, 50, 50))
	r.traffic("v1", 10, 200, 10*time.Millisecond)
	r.traffic("v2", 10, 200, 400*time.Millisecond)
	r.finish()
	for i := 0; i < 12; i++ {
		r.a.tick()
	}
	route := r.store.Load().Config.Routes[0]
	eff := r.a.Effective(route)
	if route.Upstreams[0].Weight != 50 {
		t.Fatal("Effective must not mutate the route")
	}
	if eff[0].Weight == 50 {
		t.Fatalf("effective weights should differ from configured: %+v", eff)
	}
	var nilA *AutoWeigher
	got := nilA.Effective(route)
	if got[0].Weight != 50 || got[1].Weight != 50 {
		t.Fatalf("nil weigher returns configured, got %+v", got)
	}
	if nilA.Weights() != nil && len(nilA.Weights()) != 0 {
		t.Fatal("nil weigher has no weights")
	}
}

func TestAutoWeightDropsStateOnUpstreamSetChange(t *testing.T) {
	r := newAWRig(autoConfig(true, 50, 50))
	r.traffic("v1", 10, 200, 10*time.Millisecond)
	r.traffic("v2", 10, 200, 400*time.Millisecond)
	r.finish()
	for i := 0; i < 12; i++ {
		r.a.tick()
	}
	if st := r.a.state["catalog"]; st == nil || st.last["v1"] == 100 {
		t.Fatalf("precondition: expected smoothed (non-configured) state, got %+v", st)
	}
	c := autoConfig(true, 100, 0)
	c.Routes[0].Upstreams = c.Routes[0].Upstreams[:1]
	r.store.Activate(c, 2)
	if w := r.w(); len(w) != 1 || w["v1"] != 100 {
		t.Fatalf("stale effective weights leaked into new config: %v", w)
	}
	r.a.tick()
	st := r.a.state["catalog"]
	if st == nil || len(st.ids) != 1 || st.ids[0] != "v1" || len(st.last) != 1 || st.last["v1"] != 100 {
		t.Fatalf("state should be re-seeded for the new upstream set: %+v", st)
	}
	// A route that disappears from the config loses its state.
	c2 := autoConfig(true, 50, 50)
	c2.Routes[0].ID = "other"
	r.store.Activate(c2, 3)
	r.a.tick()
	if _, ok := r.a.state["catalog"]; ok || r.a.state["other"] == nil {
		t.Fatalf("removed route state should be dropped: %+v", r.a.state)
	}
}

func TestProxyRetryUsesEffectiveWeights(t *testing.T) {
	v2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Hit", "v2") }))
	defer v2.Close()
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := dead.URL
	dead.Close()
	c := autoConfig(true, 100, 0)
	c.Routes[0].RetryAttempts = 1
	c.Routes[0].Upstreams[0].URL = deadURL
	c.Routes[0].Upstreams[1].URL = v2.URL
	r := newAWRig(c)
	r.a.tick() // no data: v2 becomes positive (v1 75, v2 25)
	if w := r.w(); w["v2"] == 0 {
		t.Fatalf("precondition: v2 should be positive, got %v", w)
	}
	p := NewProxy(r.store, nil, r.h, r.m, slog.New(slog.NewTextHandler(io.Discard, nil)))
	p.weights = r.a
	for i := 0; i < 20; i++ {
		req := httptest.NewRequest("GET", "http://gateway/api/catalog/x", nil)
		req.Header.Set("X-Request-ID", fmt.Sprint("req-", i))
		w := httptest.NewRecorder()
		p.ServeHTTP(w, req)
		if w.Code != 200 || w.Header().Get("X-Hit") != "v2" {
			t.Fatalf("request %d: code %d hit %q (retry must reach the overlay-positive upstream)", i, w.Code, w.Header().Get("X-Hit"))
		}
	}
}

func TestProxyRoutesToConfiguredZeroUpstreamWhenAutoWeightPositive(t *testing.T) {
	hit := ""
	mk := func(id string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hit = id }))
	}
	u1, u2 := mk("v1"), mk("v2")
	defer u1.Close()
	defer u2.Close()
	c := autoConfig(true, 100, 0)
	c.Routes[0].Upstreams[0].URL = u1.URL
	c.Routes[0].Upstreams[1].URL = u2.URL
	r := newAWRig(c)
	// Make v1 unhealthy so only v2 (configured 0) can serve.
	r.h.mu.Lock()
	r.h.state["v1"] = upstreamHealth{Healthy: false, EjectedUntil: time.Now().Add(time.Hour)}
	r.h.mu.Unlock()
	r.a.tick()
	p := NewProxy(r.store, nil, r.h, r.m, slog.New(slog.NewTextHandler(io.Discard, nil)))
	p.weights = r.a
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "http://gateway/api/catalog/x", nil))
	if w.Code != 200 || hit != "v2" {
		t.Fatalf("code %d hit %q", w.Code, hit)
	}
	// Without the weigher, the configured 0 weight leaves nothing eligible.
	p.weights = nil
	w = httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "http://gateway/api/catalog/x", nil))
	if w.Code != 503 {
		t.Fatalf("expected 503 without auto weight, got %d", w.Code)
	}
}
