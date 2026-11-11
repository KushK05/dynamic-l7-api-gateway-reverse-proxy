package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// Real upstream traffic verifies the playground takes the normal routing path,
// logs failures too, and does not become an arbitrary outbound HTTP client.
func TestPlaygroundRoutingAndPrivacy(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(strings.Repeat("x", 70000))) }))
	defer up.Close()
	e := newAdminEnv(t, up.URL, up.URL, nil)
	cfg := e.srv.configs.Store().Load().Config
	path := cfg.Routes[0].Match.PathPrefix + "/private?secret=hidden"
	b, _ := json.Marshal(map[string]any{"method": "GET", "path": path, "token": "never-log-me", "headers": map[string]string{"X-Tenant": "demo"}})
	w := e.do("POST", "/admin/v1/playground", "application/json", string(b))
	var out struct {
		Status          int
		Body            string
		Truncated       bool
		Route, Upstream string
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || out.Status != 200 || len(out.Body) != 65536 || !out.Truncated || out.Upstream == "" || out.Route == "" {
		t.Fatalf("unexpected preview: code=%d status=%d route=%q upstream=%q len=%d", w.Code, out.Status, out.Route, out.Upstream, len(out.Body))
	}
	log := e.do("GET", "/admin/v1/requests", "", "")
	if strings.Contains(log.Body.String(), "hidden") || strings.Contains(log.Body.String(), "never-log-me") || strings.Contains(log.Body.String(), "private") {
		t.Fatal("request log leaked sensitive data")
	}
	for _, path := range []string{"https://example.com/", "//example.com/"} {
		b, _ := json.Marshal(map[string]string{"method": "GET", "path": path})
		if w := e.do("POST", "/admin/v1/playground", "application/json", string(b)); w.Code != 400 {
			t.Fatal("external URL accepted")
		}
	}
	if w := e.do("POST", "/admin/v1/playground", "text/plain", string(b)); w.Code != 415 {
		t.Fatal("missing JSON guard")
	}
	w = e.do("POST", "/admin/v1/playground", "application/json", `{"method":"GET","path":"/no-matching-route"}`)
	if !strings.Contains(w.Body.String(), `"status":404`) {
		t.Fatal(w.Body.String())
	}
}
func TestRequestLogBoundAndOrder(t *testing.T) {
	l := &RequestLog{}
	for i := 0; i < 250; i++ {
		l.Add(RequestEntry{Status: i, RequestID: strings.Repeat("a", 1000)})
	}
	rows := l.Recent()
	if len(rows) != 200 || rows[0].Status != 249 || rows[199].Status != 50 || len(rows[0].RequestID) != 128 {
		t.Fatal("ring not bounded or ordered")
	}
}

// History and active revision share one durable envelope; restoration uses the
// ordinary Replace contract and therefore cannot bypass validation or If-Match.
func TestHistoryRetentionRestartAndRestore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	c := validConfig()
	cs, err := OpenConfigStore(path, c)
	if err != nil {
		t.Fatal(err)
	}
	for rev := int64(1); rev < 13; rev++ {
		c.Routes[0].TimeoutMS = 1000 + int(rev)
		if _, err = cs.Replace(c, rev); err != nil {
			t.Fatal(err)
		}
	}
	restarted, err := OpenConfigStore(path, c)
	if err != nil {
		t.Fatal(err)
	}
	h := restarted.History()
	if len(h) != 10 || h[0].Revision != 4 || h[9].Revision != 13 || h[0].Config.Routes[0].TimeoutMS != 1003 {
		t.Fatalf("bad retained revisions: %#v", h)
	}
	if _, err = restarted.Replace(h[0].Config, 12); err == nil {
		t.Fatal("stale restore accepted")
	}
	if _, err = restarted.Replace(h[0].Config, 13); err != nil {
		t.Fatal(err)
	}
	if restarted.Store().Load().Revision != 14 || restarted.Store().Load().Config.Routes[0].TimeoutMS != h[0].Config.Routes[0].TimeoutMS {
		t.Fatal("restore did not create new revision")
	}
	invalid := validConfig()
	invalid.Version = 999
	if _, err = restarted.Replace(invalid, 14); err == nil {
		t.Fatal("invalid restore accepted")
	}
	if len(restarted.History()) != 10 {
		t.Fatal("rejected write changed history")
	}
}
