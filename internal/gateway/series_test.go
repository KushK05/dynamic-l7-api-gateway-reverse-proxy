package gateway

import (
	"context"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newClockMetrics() (*Metrics, *fakeClock) {
	c := &fakeClock{t: time.Unix(1_000_000, 0)}
	m := NewMetrics()
	m.now = c.Now
	return m, c
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestHistogramQuantileInterpolation(t *testing.T) {
	var h histogram
	if h.quantile(.5) != 0 {
		t.Fatal("empty histogram should report 0")
	}
	// 10 samples in the (5,7.5] bucket: median is halfway through it.
	for i := 0; i < 10; i++ {
		h.add(6)
	}
	if got := h.quantile(.5); !near(got, 6.25) {
		t.Fatalf("p50 = %v, want 6.25", got)
	}
	// First bucket interpolates from 0.
	var f histogram
	for i := 0; i < 4; i++ {
		f.add(0.1)
	}
	if got := f.quantile(.5); !near(got, 0.125) {
		t.Fatalf("first bucket p50 = %v, want 0.125", got)
	}
	// +Inf bucket returns the last finite bound.
	var inf histogram
	inf.add(60000)
	if got := inf.quantile(.99); got != 10000 {
		t.Fatalf("inf bucket = %v, want 10000", got)
	}
	// Split across buckets: 5 in (0,0.25], 5 in (0.25,0.5]; p75 is mid second bucket.
	var s histogram
	for i := 0; i < 5; i++ {
		s.add(0.2)
		s.add(0.4)
	}
	if got := s.quantile(.75); !near(got, 0.375) {
		t.Fatalf("p75 = %v, want 0.375", got)
	}
}

func TestSeriesOrderingGapsAndCompletedOnly(t *testing.T) {
	m, c := newClockMetrics()
	base := c.Now().Unix()
	m.observe(1, "catalog", "v1", 200, 2*time.Millisecond, 0, 0)
	m.observe(1, "catalog", "v1", 503, 2*time.Millisecond, 0, 0)
	c.Advance(3 * time.Second) // seconds base+1, base+2 are empty
	m.observe(1, "catalog", "v2", 404, 2*time.Millisecond, 0, 0)
	m.observe(1, "", "", 404, 2*time.Millisecond, 0, 0)
	c.Advance(time.Second) // base+3 is now complete

	s := m.Series(4)
	if len(s) != 4 {
		t.Fatalf("len %d", len(s))
	}
	for i, p := range s {
		if p.TS != base+int64(i) {
			t.Fatalf("point %d ts %d want %d", i, p.TS, base+int64(i))
		}
		if p.Routes == nil || p.Upstreams == nil || p.Edges == nil {
			t.Fatalf("point %d has nil map", i)
		}
	}
	if s[0].Total.RPS != 2 || s[0].Total.ErrorRPS != 1 || s[0].Edges["catalog>v1"].RPS != 2 {
		t.Fatalf("first point %+v", s[0])
	}
	if s[1].Total.RPS != 0 || len(s[1].Routes) != 0 || s[2].Total.RPS != 0 {
		t.Fatalf("gap points not zero: %+v %+v", s[1], s[2])
	}
	last := s[3]
	if last.Total.RPS != 2 || last.Total.ClientErrorRPS != 2 {
		t.Fatalf("last total %+v", last.Total)
	}
	// The unrouted 404 counts only in total.
	if last.Routes["catalog"].RPS != 1 || len(last.Routes) != 1 || last.Upstreams["v2"].RPS != 1 || len(last.Edges) != 1 {
		t.Fatalf("attribution %+v", last)
	}
	// Current (incomplete) second is excluded.
	m.observe(1, "catalog", "v1", 200, time.Millisecond, 0, 0)
	if got := m.Series(1)[0]; got.TS != base+3 || got.Total.RPS != 2 {
		t.Fatalf("incomplete second leaked: %+v", got)
	}
	if n := len(m.Series(0)); n != 1 {
		t.Fatalf("clamp low: %d", n)
	}
	if n := len(m.Series(1000)); n != 300 {
		t.Fatalf("clamp high: %d", n)
	}
}

func TestSeriesWraparoundEvictsOldData(t *testing.T) {
	m, c := newClockMetrics()
	first := c.Now().Unix()
	m.observe(1, "r", "u", 200, time.Millisecond, 0, 0)
	c.Advance(300 * time.Second) // same ring slot as `first`
	m.observe(1, "r", "u", 200, time.Millisecond, 0, 0)
	m.observe(1, "r", "u", 200, time.Millisecond, 0, 0)
	c.Advance(time.Second)
	s := m.Series(300)
	if s[0].TS != first+1 || s[299].TS != first+300 {
		t.Fatalf("range %d..%d", s[0].TS, s[299].TS)
	}
	var sum float64
	for _, p := range s {
		sum += p.Total.RPS
	}
	if sum != 2 {
		t.Fatalf("expected only the 2 new requests, got %v", sum)
	}
	// The old second is out of range and must not bleed into a stale slot read.
	c.Advance(300 * time.Second)
	if w := m.Window(300); w.Total.RPS != 0 {
		t.Fatalf("stale data survived: %+v", w.Total)
	}
}

func TestWindowAggregation(t *testing.T) {
	m, c := newClockMetrics()
	base := c.Now().Unix()
	for i := 0; i < 4; i++ {
		m.observe(1, "r", "u", 200, 6*time.Millisecond, 0, 0)
	}
	c.Advance(time.Second)
	for i := 0; i < 2; i++ {
		m.observe(1, "r", "u", 500, 400*time.Millisecond, 0, 0)
	}
	m.observe(1, "r", "w", 404, 6*time.Millisecond, 0, 0)
	c.Advance(time.Second)
	w := m.Window(2)
	if w.TS != base+1 {
		t.Fatalf("ts %d want %d", w.TS, base+1)
	}
	if !near(w.Total.RPS, 3.5) || !near(w.Total.ErrorRPS, 1) || !near(w.Total.ClientErrorRPS, 0.5) {
		t.Fatalf("total %+v", w.Total)
	}
	if !near(w.Upstreams["u"].RPS, 3) || !near(w.Upstreams["w"].RPS, 0.5) || !near(w.Edges["r>u"].ErrorRPS, 1) {
		t.Fatalf("breakdown %+v", w)
	}
	// 7 samples: 5 near 6ms and 2 near 400ms. p50 is in the 6ms bucket, p99 in the 300-500 bucket.
	if w.Total.P50 <= 5 || w.Total.P50 > 7.5 || w.Total.P99 <= 300 || w.Total.P99 > 500 {
		t.Fatalf("quantiles p50=%v p99=%v", w.Total.P50, w.Total.P99)
	}
	// A wider window averages over the empty seconds too.
	c.Advance(2 * time.Second)
	if w := m.Window(4); !near(w.Total.RPS, 7.0/4) {
		t.Fatalf("wide window rps %v", w.Total.RPS)
	}
}

func TestInFlightBeginEnd(t *testing.T) {
	m := NewMetrics()
	m.begin("a")
	m.begin("a")
	m.begin("b")
	tot, ups := m.InFlight()
	if tot != 3 || ups["a"] != 2 || ups["b"] != 1 {
		t.Fatalf("%d %v", tot, ups)
	}
	m.end("a")
	m.end("a")
	m.end("b")
	tot, ups = m.InFlight()
	if tot != 0 || len(ups) != 0 || ups == nil {
		t.Fatalf("%d %v", tot, ups)
	}
}

func newTestProxy(t *testing.T, routes ...Route) (*Proxy, *Metrics, *fakeClock) {
	t.Helper()
	m, c := newClockMetrics()
	s := &Store{}
	s.Activate(Config{Version: 1, Routes: routes}, 1)
	p := NewProxy(s, nil, NewHealth(m), m, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return p, m, c
}

func TestServeHTTPAttribution(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }))
	defer up.Close()
	p, m, c := newTestProxy(t, Route{ID: "catalog", Priority: 10, Match: Match{PathPrefix: "/api"}, TimeoutMS: 1000, Upstreams: []Upstream{{ID: "v1", URL: up.URL, Weight: 100}}})
	base := c.Now().Unix()
	for _, path := range []string{"/api/x", "/api/y", "/nothing"} {
		w := httptest.NewRecorder()
		p.ServeHTTP(w, httptest.NewRequest("GET", "http://gateway"+path, nil))
	}
	c.Advance(time.Second)
	pt := m.Series(1)[0]
	if pt.TS != base {
		t.Fatalf("ts %d", pt.TS)
	}
	if pt.Total.RPS != 3 || pt.Total.ClientErrorRPS != 1 {
		t.Fatalf("total %+v", pt.Total)
	}
	if pt.Routes["catalog"].RPS != 2 || len(pt.Routes) != 1 {
		t.Fatalf("routes %+v", pt.Routes)
	}
	if pt.Upstreams["v1"].RPS != 2 || pt.Edges["catalog>v1"].RPS != 2 || len(pt.Edges) != 1 {
		t.Fatalf("upstreams/edges %+v %+v", pt.Upstreams, pt.Edges)
	}
}

func TestServeHTTPNoUpstreamCountsRouteOnly(t *testing.T) {
	p, m, c := newTestProxy(t, Route{ID: "r", Priority: 1, Match: Match{PathPrefix: "/"}, TimeoutMS: 1000, Upstreams: []Upstream{{ID: "u", URL: "http://127.0.0.1:1", Weight: 0}}})
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "http://gateway/", nil))
	if w.Code != 503 {
		t.Fatalf("status %d", w.Code)
	}
	c.Advance(time.Second)
	pt := m.Series(1)[0]
	if pt.Total.ErrorRPS != 1 || pt.Routes["r"].ErrorRPS != 1 || len(pt.Upstreams) != 0 || len(pt.Edges) != 0 {
		t.Fatalf("%+v", pt)
	}
}

func TestRetryRecordedOnRetryTarget(t *testing.T) {
	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }))
	defer live.Close()
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := dead.URL
	dead.Close() // connection refused
	route := Route{ID: "r", Priority: 1, Match: Match{Methods: []string{"GET"}, PathPrefix: "/"}, TimeoutMS: 2000, RetryAttempts: 1,
		Upstreams: []Upstream{{ID: "dead", URL: deadURL, Weight: 100}, {ID: "live", URL: live.URL, Weight: 100}}}
	p, m, c := newTestProxy(t, route)
	// Find a request ID that the weighted pick sends to the dead upstream first.
	var id string
	for i := 0; i < 1000; i++ {
		cand := "req-" + string(rune('a'+i%26)) + string(rune('a'+i/26%26))
		if u, _ := p.pick(route, cand); u.ID == "dead" {
			id = cand
			break
		}
	}
	if id == "" {
		t.Fatal("no request id picks the dead upstream")
	}
	r := httptest.NewRequest("GET", "http://gateway/x", nil)
	r.Header.Set("X-Request-ID", id)
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	c.Advance(time.Second)
	pt := m.Series(1)[0]
	if pt.Upstreams["live"].RPS != 1 || pt.Edges["r>live"].RPS != 1 {
		t.Fatalf("retry target not recorded: %+v %+v", pt.Upstreams, pt.Edges)
	}
	if _, ok := pt.Upstreams["dead"]; ok {
		t.Fatalf("first pick must not be recorded: %+v", pt.Upstreams)
	}
}

func TestInFlightReturnsToZeroAfterRequests(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 4)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		<-release
	}))
	defer up.Close()
	p, m, _ := newTestProxy(t, Route{ID: "r", Priority: 1, Match: Match{PathPrefix: "/"}, TimeoutMS: 5000, Upstreams: []Upstream{{ID: "u", URL: up.URL, Weight: 100}}})
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "http://gateway/", nil))
		}()
	}
	for i := 0; i < 3; i++ {
		<-entered
	}
	if tot, ups := m.InFlight(); tot != 3 || ups["u"] != 3 {
		t.Fatalf("in flight during requests: %d %v", tot, ups)
	}
	close(release)
	wg.Wait()
	if tot, ups := m.InFlight(); tot != 0 || len(ups) != 0 {
		t.Fatalf("in flight after requests: %d %v", tot, ups)
	}
}

func TestSeries300KeepsOldestWhenCurrentSecondHasData(t *testing.T) {
	m, c := newClockMetrics()
	oldest := c.Now().Unix()
	m.observe(1, "r", "u", 200, time.Millisecond, 0, 0)
	c.Advance(300 * time.Second) // oldest is now the 300th completed second
	m.observe(1, "r", "u", 200, time.Millisecond, 0, 0)
	s := m.Series(300)
	if s[0].TS != oldest || s[0].Total.RPS != 1 {
		t.Fatalf("oldest second lost: ts=%d rps=%v want ts=%d", s[0].TS, s[0].Total.RPS, oldest)
	}
}

func TestInFlightReturnsToZeroAfterAbortedBody(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		io.WriteString(w, "partial")
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	}))
	defer up.Close()
	p, m, _ := newTestProxy(t, Route{ID: "r", Priority: 1, Match: Match{PathPrefix: "/"}, TimeoutMS: 5000, Upstreams: []Upstream{{ID: "u", URL: up.URL, Weight: 100}}})
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		req := httptest.NewRequest("GET", "http://gateway/", nil)
		// ReverseProxy only panics on a failed body copy when serving under a real http.Server.
		req = req.WithContext(context.WithValue(req.Context(), http.ServerContextKey, &http.Server{}))
		p.ServeHTTP(httptest.NewRecorder(), req)
	}()
	if recovered != http.ErrAbortHandler {
		t.Fatalf("expected ErrAbortHandler panic, got %v", recovered)
	}
	if tot, ups := m.InFlight(); tot != 0 || len(ups) != 0 {
		t.Fatalf("gauge leaked: %d %v", tot, ups)
	}
}
