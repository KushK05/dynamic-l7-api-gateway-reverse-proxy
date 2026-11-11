package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeUpstream records fault traffic like cmd/upstream does.
type fakeUpstream struct {
	*httptest.Server
	mu     sync.Mutex
	fault  faultSettings
	resets int
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	f := &fakeUpstream{}
	mux := http.NewServeMux()
	mux.HandleFunc("/admin/fault", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Method == http.MethodPost {
			if err := json.NewDecoder(r.Body).Decode(&f.fault); err != nil {
				http.Error(w, "bad", 400)
				return
			}
		}
		json.NewEncoder(w).Encode(f.fault)
	})
	mux.HandleFunc("/admin/reset", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.fault = faultSettings{}
		f.resets++
		f.mu.Unlock()
		w.WriteHeader(204)
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

type adminEnv struct {
	srv    *Server
	mux    *http.ServeMux
	events *EventLog
	load   *LoadGen
}

// newAdminEnv builds a full Server whose active config points v1 and v2 at the
// given URLs; extra known upstreams are optional.
func newAdminEnv(t *testing.T, v1, v2 string, known []Upstream) *adminEnv {
	t.Helper()
	cfg := validConfig()
	cfg.Routes[0].Upstreams[0].URL = v1
	cfg.Routes[0].Upstreams[1].URL = v2
	cs, err := OpenConfigStore(filepath.Join(t.TempDir(), "config.json"), cfg)
	if err != nil {
		t.Fatal(err)
	}
	m := NewMetrics()
	ev := NewEventLog(100)
	h := NewHealth(m)
	lg := NewLoadGen("http://127.0.0.1:1", cs.Store(), ev, 100, "")
	s := NewServer(ServerDeps{Configs: cs, Keys: NewKeyManager("", time.Minute), Health: h, Metrics: m, Events: ev, Weights: NewAutoWeigher(cs.Store(), m, h, ev), Load: lg, Logger: nil, KnownUpstreams: known})
	s.streamInterval = 50 * time.Millisecond
	mux := http.NewServeMux()
	s.registerAdmin(mux)
	mux.HandleFunc("/admin/v1/config", s.configEndpoint)
	return &adminEnv{srv: s, mux: mux, events: ev, load: lg}
}

func (e *adminEnv) do(method, path, ctype, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, req)
	return w
}

func TestSeriesClampAndBadInput(t *testing.T) {
	e := newAdminEnv(t, "http://127.0.0.1:1", "http://127.0.0.1:2", nil)
	for path, want := range map[string]int{"/admin/v1/series": 120, "/admin/v1/series?seconds=5": 5, "/admin/v1/series?seconds=0": 1, "/admin/v1/series?seconds=9999": 300, "/admin/v1/series?seconds=-4": 1} {
		w := e.do("GET", path, "", "")
		var out struct{ Points []SeriesPoint }
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out.Points) != want {
			t.Fatalf("%s: code %d points %d want %d", path, w.Code, len(out.Points), want)
		}
	}
	if w := e.do("GET", "/admin/v1/series?seconds=abc", "", ""); w.Code != 400 || !strings.Contains(w.Body.String(), "error") {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
}

func TestEventsSince(t *testing.T) {
	e := newAdminEnv(t, "http://127.0.0.1:1", "http://127.0.0.1:2", nil)
	get := func(q string) []Event {
		w := e.do("GET", "/admin/v1/events"+q, "", "")
		var out struct{ Events []Event }
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || out.Events == nil {
			t.Fatalf("%s: %d %s", q, w.Code, w.Body)
		}
		return out.Events
	}
	if len(get("")) != 0 {
		t.Fatal("empty log should return empty list")
	}
	for i := 0; i < 130; i++ {
		e.events.Add(Event{Kind: "config", Level: "info", Message: "m"})
	}
	if n := len(get("")); n != 100 {
		t.Fatalf("default returned %d", n)
	}
	if got := get("?since=128"); len(got) != 2 || got[0].Seq != 129 {
		t.Fatalf("since: %+v", got)
	}
	if w := e.do("GET", "/admin/v1/events?since=x", "", ""); w.Code != 400 {
		t.Fatalf("code %d", w.Code)
	}
}

func TestLoadGetPut(t *testing.T) {
	e := newAdminEnv(t, "http://127.0.0.1:1", "http://127.0.0.1:2", nil)
	w := e.do("GET", "/admin/v1/load", "", "")
	var st LoadStatus
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &st) != nil || st.MaxRPS != 100 {
		t.Fatalf("get: %d %s", w.Code, w.Body)
	}
	body := `{"rps":10,"concurrency":8,"invalid_token_percent":5}`
	if w = e.do("PUT", "/admin/v1/load", "", body); w.Code != 415 {
		t.Fatalf("no content type: %d", w.Code)
	}
	if w = e.do("PUT", "/admin/v1/load", "text/plain", body); w.Code != 415 {
		t.Fatalf("text/plain: %d", w.Code)
	}
	if w = e.do("PUT", "/admin/v1/load", "application/json; charset=utf-8", body); w.Code != 200 {
		t.Fatalf("put: %d %s", w.Code, w.Body)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil || st.Settings.RPS != 10 || st.Settings.Concurrency != 8 {
		t.Fatalf("status %+v", st)
	}
	for _, bad := range []string{`{"rps":101,"concurrency":8}`, `{"rps":1,"concurrency":8,"bogus":1}`, `{not json`, `{"rps":1,"concurrency":8} {}`, `{"rps":1,"concurrency":8,"mix":[{"route":"nope","weight":1}]}`} {
		w = e.do("PUT", "/admin/v1/load", "application/json", bad)
		if w.Code != 400 || !strings.Contains(w.Body.String(), `"error"`) {
			t.Fatalf("%s: %d %s", bad, w.Code, w.Body)
		}
	}
	big := `{"rps":1,"concurrency":8,"mix":[` + strings.Repeat(`{"route":"catalog","weight":1},`, 400) + `{"route":"catalog","weight":1}]}`
	if w = e.do("PUT", "/admin/v1/load", "application/json", big); w.Code != 400 {
		t.Fatalf("oversize: %d", w.Code)
	}
}

func TestUpstreamsListing(t *testing.T) {
	v1 := newFakeUpstream(t)
	v1.fault = faultSettings{DelayMS: 7}
	extra := newFakeUpstream(t)
	e := newAdminEnv(t, v1.URL, "http://127.0.0.1:1", []Upstream{{ID: "aux", URL: extra.URL}})
	e.srv.health.state["v1"] = upstreamHealth{Healthy: true}
	w := e.do("GET", "/admin/v1/upstreams", "", "")
	var out struct{ Upstreams []map[string]any }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out.Upstreams) != 3 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	ids := []string{}
	for _, u := range out.Upstreams {
		ids = append(ids, u["id"].(string))
	}
	if strings.Join(ids, ",") != "aux,v1,v2" {
		t.Fatalf("order %v", ids)
	}
	aux, a, b := out.Upstreams[0], out.Upstreams[1], out.Upstreams[2]
	if aux["in_config"] != false || aux["known"] != true || aux["fault"] == nil || aux["health"] != nil {
		t.Fatalf("aux %v", aux)
	}
	if a["in_config"] != true || a["known"] != false || a["health"] == nil || a["fault"].(map[string]any)["delay_ms"] != float64(7) {
		t.Fatalf("v1 %v", a)
	}
	if b["fault"] != nil || b["health"] != nil {
		t.Fatalf("unreachable v2 should have null fault and health: %v", b)
	}
}

func TestFaultForwardAndReset(t *testing.T) {
	v1 := newFakeUpstream(t)
	e := newAdminEnv(t, v1.URL, "http://127.0.0.1:1", nil)
	body := `{"delay_ms":800,"status":0,"unhealthy":false,"error_rate_percent":0}`
	if w := e.do("POST", "/admin/v1/upstreams/v1/fault", "", body); w.Code != 415 {
		t.Fatalf("415 expected, got %d", w.Code)
	}
	w := e.do("POST", "/admin/v1/upstreams/v1/fault", "application/json", body)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"status":"applied"}` {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if v1.fault.DelayMS != 800 {
		t.Fatalf("not forwarded: %+v", v1.fault)
	}
	if ev := e.events.Recent(1)[0]; ev.Kind != "fault" || ev.Level != "warn" || ev.Message != "Injected 800 ms latency into v1" {
		t.Fatalf("event %+v", ev)
	}
	e.do("POST", "/admin/v1/upstreams/v1/fault", "application/json", `{"delay_ms":0,"status":0,"unhealthy":true,"error_rate_percent":30}`)
	if ev := e.events.Recent(1)[0]; ev.Message != "Injected 30% errors into v1; v1 set to fail health checks and return 503" {
		t.Fatalf("event %+v", ev)
	}
	if w = e.do("POST", "/admin/v1/upstreams/v1/reset", "", ""); w.Code != 415 {
		t.Fatalf("reset 415 expected, got %d", w.Code)
	}
	if w = e.do("POST", "/admin/v1/upstreams/v1/reset", "application/json", ""); w.Code != 200 || v1.resets != 1 {
		t.Fatalf("reset %d resets=%d", w.Code, v1.resets)
	}
	if ev := e.events.Recent(1)[0]; ev.Level != "success" || ev.Message != "Faults cleared on v1" {
		t.Fatalf("event %+v", ev)
	}
}

func TestFaultErrors(t *testing.T) {
	v1 := newFakeUpstream(t)
	e := newAdminEnv(t, v1.URL, "http://127.0.0.1:1", nil)
	if w := e.do("POST", "/admin/v1/upstreams/ghost/fault", "application/json", `{}`); w.Code != 404 {
		t.Fatalf("unknown: %d", w.Code)
	}
	if w := e.do("POST", "/admin/v1/upstreams/ghost/reset", "application/json", ``); w.Code != 404 {
		t.Fatalf("unknown reset: %d", w.Code)
	}
	for _, bad := range []string{`{"delay_ms":30001}`, `{"delay_ms":-1}`, `{"status":200}`, `{"status":600}`, `{"error_rate_percent":101}`, `{"nope":1}`, `junk`} {
		if w := e.do("POST", "/admin/v1/upstreams/v1/fault", "application/json", bad); w.Code != 400 {
			t.Fatalf("%s: %d", bad, w.Code)
		}
	}
	if got := e.do("POST", "/admin/v1/upstreams/v2/fault", "application/json", `{"delay_ms":5}`); got.Code != 502 || !strings.Contains(got.Body.String(), "error") {
		t.Fatalf("down: %d %s", got.Code, got.Body)
	}
	if got := e.do("POST", "/admin/v1/upstreams/v2/reset", "application/json", ``); got.Code != 502 {
		t.Fatalf("down reset: %d", got.Code)
	}
}

func TestConfigPutRequiresJSONContentType(t *testing.T) {
	e := newAdminEnv(t, "http://127.0.0.1:1", "http://127.0.0.1:2", nil)
	put := func(ctype string) int {
		req := httptest.NewRequest("PUT", "/admin/v1/config", strings.NewReader("{}"))
		req.Header.Set("If-Match", `"1"`)
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		w := httptest.NewRecorder()
		e.mux.ServeHTTP(w, req)
		return w.Code
	}
	if c := put(""); c != 415 {
		t.Fatalf("none: %d", c)
	}
	if c := put("text/plain"); c != 415 {
		t.Fatalf("text: %d", c)
	}
	if c := put("application/json; charset=utf-8"); c == 415 {
		t.Fatal("json with charset must pass the type check")
	}
}

func TestParseKnownUpstreams(t *testing.T) {
	got, err := ParseKnownUpstreams(" a = http://h:1 , b=https://x.example:2/ ,")
	if err != nil || len(got) != 2 || got[0] != (Upstream{ID: "a", URL: "http://h:1"}) || got[1].ID != "b" {
		t.Fatalf("%+v %v", got, err)
	}
	if got, err = ParseKnownUpstreams(""); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("empty: %+v %v", got, err)
	}
	for _, bad := range []string{"noequals", "a=ftp://h", "a=http://h?x=1", "a=http://u:p@h", "bad id=http://h", "a=http://h,a=http://h2", "=http://h"} {
		if _, err := ParseKnownUpstreams(bad); err == nil {
			t.Fatalf("%q should fail", bad)
		}
	}
}

func TestStreamHelloThenFrames(t *testing.T) {
	e := newAdminEnv(t, "http://127.0.0.1:1", "http://127.0.0.1:2", nil)
	e.events.Add(Event{Kind: "config", Level: "info", Message: "before"})
	ts := httptest.NewServer(e.mux)
	defer ts.Close()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/admin/v1/stream", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "text/event-stream" || resp.Header.Get("Cache-Control") != "no-cache" || resp.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("headers %v", resp.Header)
	}
	type msg struct {
		name string
		data map[string]json.RawMessage
	}
	msgs := make(chan msg, 16)
	go func() {
		defer close(msgs)
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 8<<20)
		var name string
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				m := msg{name: name}
				_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &m.data)
				msgs <- m
			}
		}
	}()
	next := func() msg {
		select {
		case m, ok := <-msgs:
			if !ok {
				t.Fatal("stream closed")
			}
			return m
		case <-time.After(2500 * time.Millisecond):
			t.Fatal("timed out waiting for stream message")
		}
		return msg{}
	}
	hello := next()
	var series []SeriesPoint
	if hello.name != "hello" || json.Unmarshal(hello.data["series"], &series) != nil || len(series) != 120 || !strings.Contains(string(hello.data["events"]), "before") {
		t.Fatalf("hello %s %v", hello.name, hello.data)
	}
	e.events.Add(Event{Kind: "config", Level: "info", Message: "after"})
	var frame msg
	for i := 0; i < 5; i++ {
		frame = next()
		if frame.name == "frame" && strings.Contains(string(frame.data["events"]), "after") {
			break
		}
	}
	for _, k := range []string{"ts", "revision", "secret_revision", "point", "window", "inflight", "health", "weights", "load", "events", "totals"} {
		if _, ok := frame.data[k]; !ok {
			t.Fatalf("frame missing %q: %v", k, frame.data)
		}
	}
	if !strings.Contains(string(frame.data["events"]), "after") || strings.Contains(string(frame.data["events"]), "before") {
		t.Fatalf("frame events %s", frame.data["events"])
	}
	if string(frame.data["secret_revision"]) != `"unavailable"` {
		t.Fatalf("secret_revision %s", frame.data["secret_revision"])
	}
	cancel()
	// The server handler must return after the client goes away.
	io.Copy(io.Discard, resp.Body)
}

func TestStreamHandlerReturnsOnCancel(t *testing.T) {
	e := newAdminEnv(t, "http://127.0.0.1:1", "http://127.0.0.1:2", nil)
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("GET", "/admin/v1/stream", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { e.mux.ServeHTTP(w, req); close(done) }()
	time.Sleep(150 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not return after cancel")
	}
	if !strings.Contains(w.Body.String(), "event: hello") || !strings.Contains(w.Body.String(), "event: frame") {
		t.Fatalf("body %q", w.Body.String()[:min(200, w.Body.Len())])
	}
}
