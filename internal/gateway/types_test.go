package gateway

import (
	"net/http"
	"testing"
)

func validConfig() Config {
	// Shared baseline for tests that need a valid, small two-target route.
	return Config{Version: 1, Routes: []Route{{ID: "catalog", Priority: 1, Match: Match{Methods: []string{"GET"}, PathPrefix: "/api/catalog", Headers: map[string]string{"X-Tenant": "demo"}}, TimeoutMS: 1000, RetryAttempts: 1, Upstreams: []Upstream{{ID: "v1", URL: "http://127.0.0.1:9101", Weight: 80}, {ID: "v2", URL: "http://127.0.0.1:9102", Weight: 20}}}}}
}
func TestValidateRejectsUnsafeRetryAndWeight(t *testing.T) {
	c := validConfig()
	if e := Validate(c); e != nil {
		t.Fatal(e)
	}
	// A retry policy must name allowed methods rather than applying to any method.
	c.Routes[0].Match.Methods = nil
	if e := Validate(c); e == nil {
		t.Fatal("expected retry on wildcard methods to fail")
	}
	c = validConfig()
	c.Routes[0].Upstreams[0].Weight = 79
	if e := Validate(c); e == nil {
		t.Fatal("expected bad weight total to fail")
	}
}

func TestValidateRequiresStableUpstreamIdentity(t *testing.T) {
	c := validConfig()
	second := Route{ID: "other", Priority: 2, Match: Match{PathPrefix: "/other"}, TimeoutMS: 1000, Upstreams: []Upstream{{ID: "v1", URL: "http://127.0.0.1:9999", Weight: 100}}}
	c.Routes = append(c.Routes, second)
	if err := Validate(c); err == nil {
		t.Fatal("same upstream ID pointing at different URLs must fail")
	}
	c = validConfig()
	c.Routes[0].Upstreams[0].URL = "http://127.0.0.1:9101?token=unsafe"
	if err := Validate(c); err == nil {
		t.Fatal("upstream URLs must not include query credentials")
	}
}
func TestMatchUsesPathBoundaryAndHeaders(t *testing.T) {
	m := Match{Methods: []string{"GET"}, PathPrefix: "/api/catalog", Headers: map[string]string{"x-tenant": "demo"}}
	h := http.Header{"X-Tenant": []string{"demo"}}
	headers := normalizedHeaders(h)
	if !m.matches("example.test", "GET", "/api/catalog/item", headers) {
		t.Fatal("expected match")
	}
	if m.matches("example.test", "GET", "/api/catalogue", headers) {
		t.Fatal("prefix boundary should not match")
	}
	if m.matches("example.test", "POST", "/api/catalog/item", headers) {
		t.Fatal("method mismatch should not match")
	}
}
func TestWeightedSelection(t *testing.T) {
	// Deterministic request IDs should approximate the configured weighted split.
	m := NewMetrics()
	h := NewHealth(m)
	p := NewProxy(&Store{}, nil, h, m, nil)
	route := Route{Upstreams: []Upstream{{ID: "v1", Weight: 80}, {ID: "v2", Weight: 20}}}
	counts := map[string]int{}
	for i := 0; i < 10000; i++ {
		u, ok := p.pick(route, string(rune(i)))
		if !ok {
			t.Fatal("no selection")
		}
		counts[u.ID]++
	}
	if counts["v1"] < 7900 || counts["v1"] > 8100 {
		t.Fatalf("expected 80/20 distribution, got %#v", counts)
	}
}
