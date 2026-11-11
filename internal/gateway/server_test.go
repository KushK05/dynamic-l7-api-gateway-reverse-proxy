package gateway

import (
	"path/filepath"
	"strings"
	"testing"

	"net/http"
	"net/http/httptest"
)

func TestConfigPutRejectionsEmitWarnEvents(t *testing.T) {
	cs, err := OpenConfigStore(filepath.Join(t.TempDir(), "config.json"), validConfig())
	if err != nil {
		t.Fatal(err)
	}
	ev := NewEventLog(10)
	s := NewServer(ServerDeps{Configs: cs, Metrics: NewMetrics(), Events: ev})
	put := func(ifMatch, body string) int {
		req := httptest.NewRequest(http.MethodPut, "/admin/v1/config", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if ifMatch != "" {
			req.Header.Set("If-Match", ifMatch)
		}
		w := httptest.NewRecorder()
		s.configEndpoint(w, req)
		return w.Code
	}
	cases := []struct {
		ifMatch, body string
		code          int
		want          string
	}{
		{"", "{}", 428, "If-Match revision is required"},
		{`"1"`, "{not json", 400, "invalid config JSON"},
		{`"1"`, `{"version":1,"routes":[]}`, 400, "at least one route"},
	}
	for i, c := range cases {
		if got := put(c.ifMatch, c.body); got != c.code {
			t.Fatalf("case %d: code %d want %d", i, got, c.code)
		}
		got := ev.Recent(1)[0]
		if got.Kind != "config" || got.Level != "warn" || !strings.Contains(got.Message, c.want) || int(got.Seq) != i+1 {
			t.Fatalf("case %d: event %+v", i, got)
		}
	}
}
