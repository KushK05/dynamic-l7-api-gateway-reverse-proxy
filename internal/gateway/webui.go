package gateway

import (
	"bytes"
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

// webFiles holds the dashboard: plain HTML, CSS and ES modules, no build step.
//
//go:embed web
var webFiles embed.FS

// dashboardCSP allows only same-origin assets and connections; the page has no
// inline scripts or style blocks.
const dashboardCSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'"

// registerDashboard serves the embedded dashboard under /dashboard. Both
// /dashboard and /dashboard/ return index.html directly, without a redirect.
func registerDashboard(mux *http.ServeMux) {
	root, err := fs.Sub(webFiles, "web")
	if err != nil {
		panic(err)
	}
	h := dashboardHandler{root: root}
	mux.Handle("GET /dashboard", h)
	mux.Handle("GET /dashboard/", h)
}

type dashboardHandler struct{ root fs.FS }

func (h dashboardHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	hd := w.Header()
	hd.Set("Content-Security-Policy", dashboardCSP)
	hd.Set("Cache-Control", "no-cache")
	hd.Set("X-Content-Type-Options", "nosniff")
	hd.Set("Referrer-Policy", "no-referrer")

	name := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/dashboard"), "/")
	if name == "" {
		name = "index.html"
	}
	name = path.Clean(name)
	if !fs.ValidPath(name) {
		http.NotFound(w, r)
		return
	}
	if st, err := fs.Stat(h.root, name); err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	b, err := fs.ReadFile(h.root, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ct := mime.TypeByExtension(path.Ext(name))
	if ct == "" {
		ct = "application/octet-stream"
	}
	hd.Set("Content-Type", ct)
	// Embedded files carry no modification time; no-cache plus content length
	// is enough for a loopback admin page.
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(b))
}
