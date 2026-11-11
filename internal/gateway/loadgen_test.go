package gateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func loadStore(routes ...Route) *Store {
	s := &Store{}
	s.Activate(Config{Version: 1, Routes: routes}, 1)
	return s
}

func TestLoadApplyValidation(t *testing.T) {
	g := NewLoadGen("http://127.0.0.1:1", loadStore(Route{ID: "a"}), nil, 500, "")
	cases := map[string]LoadSettings{
		"negative rps":    {RPS: -1, Concurrency: 10},
		"rps over max":    {RPS: 501, Concurrency: 10},
		"concurrency 0":   {RPS: 1, Concurrency: 0},
		"concurrency big": {RPS: 1, Concurrency: 1025},
		"unknown route":   {RPS: 1, Concurrency: 10, Mix: []LoadMix{{Route: "zzz", Weight: 5}}},
		"weight over 100": {RPS: 1, Concurrency: 10, Mix: []LoadMix{{Route: "a", Weight: 101}}},
		"negative weight": {RPS: 1, Concurrency: 10, Mix: []LoadMix{{Route: "a", Weight: -1}}},
		"invalid pct":     {RPS: 1, Concurrency: 10, InvalidTokenPercent: 101},
	}
	for name, s := range cases {
		if _, err := g.Apply(s); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	got, err := g.Apply(LoadSettings{RPS: 500, Concurrency: 1024, Mix: []LoadMix{{Route: "a", Weight: 100}}, InvalidTokenPercent: 100})
	if err != nil || got.RPS != 500 {
		t.Fatalf("valid apply: %v %+v", err, got)
	}
}

func TestLoadDefaultsAndEvents(t *testing.T) {
	ev := NewEventLog(10)
	g := NewLoadGen("http://127.0.0.1:1", loadStore(Route{ID: "a"}), ev, 100, "tok")
	st := g.Status()
	if st.Settings.Concurrency != 256 || st.Settings.InvalidTokenPercent != 10 || st.MaxRPS != 100 || !st.HasToken || st.Settings.RPS != 0 {
		t.Fatalf("defaults: %+v", st)
	}
	if _, err := g.Apply(LoadSettings{RPS: 80, Concurrency: 5}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Apply(LoadSettings{RPS: 0, Concurrency: 5}); err != nil {
		t.Fatal(err)
	}
	evs := ev.Since(0)
	if len(evs) != 2 || evs[0].Kind != "load" || evs[0].Message != "Traffic generator set to 80 rps" || evs[1].Message != "Traffic generator stopped" {
		t.Fatalf("events: %+v", evs)
	}
}

func TestLoadRate100(t *testing.T) {
	var n atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { n.Add(1) }))
	defer srv.Close()
	g := NewLoadGen(srv.URL, loadStore(Route{ID: "a", Match: Match{PathPrefix: "/x"}}), nil, 1000, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go g.Run(ctx)
	if _, err := g.Apply(LoadSettings{RPS: 100, Concurrency: 64}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	got := n.Load()
	if got < 60 || got > 140 {
		t.Fatalf("expected about 100 requests, got %d", got)
	}
}

func TestLoadLowRate(t *testing.T) {
	var n atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { n.Add(1) }))
	defer srv.Close()
	g := NewLoadGen(srv.URL, loadStore(Route{ID: "a", Match: Match{PathPrefix: "/x"}}), nil, 1000, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go g.Run(ctx)
	if _, err := g.Apply(LoadSettings{RPS: 5, Concurrency: 8}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	cancel()
	got := n.Load()
	if got < 3 || got > 7 {
		t.Fatalf("expected about 5 requests, got %d", got)
	}
}

func TestLoadShedsAtConcurrencyOne(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	defer srv.Close()
	defer once.Do(func() { close(release) })
	g := NewLoadGen(srv.URL, loadStore(Route{ID: "a", Match: Match{PathPrefix: "/x"}}), nil, 1000, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go g.Run(ctx)
	if _, err := g.Apply(LoadSettings{RPS: 200, Concurrency: 1}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && g.Status().TotalShed < 10 {
		time.Sleep(20 * time.Millisecond)
	}
	st := g.Status()
	if st.TotalShed < 10 || st.InFlight != 1 || st.TotalSent != 1 {
		t.Fatalf("expected shedding with one in flight: %+v", st)
	}
	// Raising concurrency takes effect without restarting Run.
	if _, err := g.Apply(LoadSettings{RPS: 200, Concurrency: 50}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if g.Status().InFlight < 2 {
		t.Fatalf("concurrency increase not applied: %+v", g.Status())
	}
	once.Do(func() { close(release) })
}

func TestLoadBuildRequest(t *testing.T) {
	routes := []Route{
		{ID: "plain", Match: Match{PathPrefix: "/api/", Methods: []string{"POST", "GET"}, Hosts: []string{"demo.local"}, Headers: map[string]string{"X-Tenant": "t1"}}},
		{ID: "jwt", Match: Match{PathPrefix: "/secure"}, JWT: &JWTPolicy{Required: true}},
	}
	g := NewLoadGen("http://127.0.0.1:9", loadStore(routes...), nil, 100, "good")
	req, err := g.buildRequest(context.Background(), routes[0])
	if err != nil {
		t.Fatal(err)
	}
	if req.Method != "POST" || req.Host != "demo.local" || req.Header.Get("X-Tenant") != "t1" || req.Header.Get("X-Load-Generator") != "dashboard" || req.Header.Get("Content-Type") != "application/json" || req.Header.Get("Authorization") != "" {
		t.Fatalf("bad request: %+v", req)
	}
	if !strings.HasPrefix(req.URL.Path, "/api/item-") || strings.Contains(req.URL.Path, "//") {
		t.Fatalf("path %q", req.URL.Path)
	}
	b, _ := io.ReadAll(req.Body)
	if len(b) == 0 {
		t.Fatal("expected a body")
	}
	req, _ = g.buildRequest(context.Background(), routes[1])
	if req.Method != "GET" || req.Header.Get("Authorization") != "Bearer good" || req.URL.Path[:len("/secure/item-")] != "/secure/item-" || req.Body != nil && req.Body != http.NoBody {
		t.Fatalf("bad jwt request: %+v", req)
	}
	// All invalid.
	if _, err := g.Apply(LoadSettings{RPS: 0, Concurrency: 1, InvalidTokenPercent: 100}); err != nil {
		t.Fatal(err)
	}
	req, _ = g.buildRequest(context.Background(), routes[1])
	if req.Header.Get("Authorization") != "Bearer invalid.token.value" {
		t.Fatalf("auth %q", req.Header.Get("Authorization"))
	}
	// No token: no header.
	g2 := NewLoadGen("http://127.0.0.1:9", loadStore(routes...), nil, 100, "")
	req, _ = g2.buildRequest(context.Background(), routes[1])
	if req.Header.Get("Authorization") != "" {
		t.Fatalf("unexpected auth %q", req.Header.Get("Authorization"))
	}
	// Prefix without trailing slash and root prefix.
	r3 := Route{ID: "r", Match: Match{PathPrefix: "/"}}
	req, _ = g.buildRequest(context.Background(), r3)
	if !strings.HasPrefix(req.URL.Path, "/item-") {
		t.Fatalf("root path %q", req.URL.Path)
	}
}

func TestLoadPickRoute(t *testing.T) {
	st := loadStore(Route{ID: "a"}, Route{ID: "b"}, Route{ID: "c"})
	g := NewLoadGen("http://x", st, nil, 100, "")
	if _, ok := NewLoadGen("http://x", &Store{}, nil, 1, "").pickRoute(); ok {
		t.Fatal("no snapshot should pick nothing")
	}
	if _, ok := NewLoadGen("http://x", loadStore(), nil, 1, "").pickRoute(); ok {
		t.Fatal("no routes should pick nothing")
	}
	if _, err := g.Apply(LoadSettings{RPS: 1, Concurrency: 1, Mix: []LoadMix{{Route: "a", Weight: 0}, {Route: "b", Weight: 10}}}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 200; i++ {
		r, ok := g.pickRoute()
		if !ok || r.ID != "b" {
			t.Fatalf("expected only b, got %q", r.ID)
		}
	}
	// All-zero mix falls back to uniform over active routes.
	if _, err := g.Apply(LoadSettings{RPS: 1, Concurrency: 1, Mix: []LoadMix{{Route: "a", Weight: 0}}}); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		r, _ := g.pickRoute()
		seen[r.ID] = true
	}
	if len(seen) != 3 {
		t.Fatalf("uniform fallback saw %v", seen)
	}
	// Mix route vanished from config: fall back to uniform.
	st.Activate(Config{Version: 1, Routes: []Route{{ID: "c"}}}, 2)
	if _, err := g.Apply(LoadSettings{RPS: 1, Concurrency: 1, Mix: []LoadMix{{Route: "c", Weight: 1}}}); err != nil {
		t.Fatal(err)
	}
	st.Activate(Config{Version: 1, Routes: []Route{{ID: "d"}}}, 3)
	if r, ok := g.pickRoute(); !ok || r.ID != "d" {
		t.Fatalf("vanished mix fallback: %q %v", r.ID, ok)
	}
}

func TestLoadPerSecondCounters(t *testing.T) {
	g := NewLoadGen("http://x", loadStore(Route{ID: "a"}), nil, 100, "")
	base := time.Unix(1000, 0)
	g.record(base, false)
	g.record(base.Add(100*time.Millisecond), false)
	g.record(base.Add(200*time.Millisecond), true)
	sent, shed := g.lastSecond(base.Add(1500 * time.Millisecond))
	if sent != 2 || shed != 1 {
		t.Fatalf("got %v %v", sent, shed)
	}
	sent, shed = g.lastSecond(base.Add(3 * time.Second))
	if sent != 0 || shed != 0 {
		t.Fatalf("stale second should read zero, got %v %v", sent, shed)
	}
}
