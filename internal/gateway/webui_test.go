package gateway

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func dashboardGet(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	registerDashboard(mux)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w
}

func assertDashboardHeaders(t *testing.T, path string, w *httptest.ResponseRecorder) {
	t.Helper()
	want := map[string]string{
		"Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
		"Cache-Control":           "no-cache",
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "no-referrer",
	}
	for k, v := range want {
		if got := w.Header().Get(k); got != v {
			t.Errorf("%s: header %s = %q, want %q", path, k, got, v)
		}
	}
}

func TestDashboardServesIndexWithoutRedirect(t *testing.T) {
	for _, path := range []string{"/dashboard", "/dashboard/"} {
		w := dashboardGet(t, path)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d, want 200", path, w.Code)
		}
		if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("%s: content type %q", path, ct)
		}
		body := w.Body.String()
		if !strings.Contains(body, "Dynamic L7 Gateway") {
			t.Fatalf("%s: body lacks product name", path)
		}
		if !strings.Contains(body, `src="/dashboard/js/main.js"`) || !strings.Contains(body, `type="module"`) {
			t.Fatalf("%s: body lacks absolute module script", path)
		}
		assertDashboardHeaders(t, path, w)
	}
}

func TestDashboardServesAssets(t *testing.T) {
	cases := map[string]string{
		"/dashboard/js/main.js": "javascript",
		"/dashboard/app.css":    "text/css",
	}
	for path, ct := range cases {
		w := dashboardGet(t, path)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d, want 200", path, w.Code)
		}
		if got := w.Header().Get("Content-Type"); !strings.Contains(got, ct) {
			t.Fatalf("%s: content type %q, want %s", path, got, ct)
		}
		if w.Body.Len() == 0 {
			t.Fatalf("%s: empty body", path)
		}
		assertDashboardHeaders(t, path, w)
	}
}

func TestDashboardMissingAssetIs404(t *testing.T) {
	for _, path := range []string{"/dashboard/nope.js", "/dashboard/js/", "/dashboard/js"} {
		w := dashboardGet(t, path)
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d, want 404", path, w.Code)
		}
		assertDashboardHeaders(t, path, w)
	}
}
