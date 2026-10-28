package gateway

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProxyUsesOneRevisionAndForwardsRouteMetadata(t *testing.T) {
	// A real httptest upstream verifies rewrite and revision forwarding end-to-end.
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream-ID", "v1")
		io.WriteString(w, r.URL.Path+"|"+r.Header.Get("X-Gateway-Config-Revision"))
	}))
	defer up.Close()
	c := Config{Version: 1, Routes: []Route{{ID: "catalog", Priority: 10, Match: Match{Methods: []string{"GET"}, PathPrefix: "/api/catalog"}, RewritePrefix: "/v1", TimeoutMS: 1000, Upstreams: []Upstream{{ID: "v1", URL: up.URL, Weight: 100}}}}}
	s := &Store{}
	// Pin revision 3 before serving so the test can check both header and body metadata.
	s.Activate(c, 3)
	m := NewMetrics()
	h := NewHealth(m)
	p := NewProxy(s, nil, h, m, slog.New(slog.NewTextHandler(io.Discard, nil)))
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "http://gateway/api/catalog/items", nil)
	p.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if w.Header().Get("X-Config-Revision") != "3" {
		t.Fatalf("revision header: %s", w.Header().Get("X-Config-Revision"))
	}
	if w.Body.String() != "/v1/items|3" {
		t.Fatalf("unexpected upstream response %q", w.Body.String())
	}
}
