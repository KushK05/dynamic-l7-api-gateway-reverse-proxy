package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Server owns the two HTTP surfaces while the gateway components are shared.
type Server struct {
	configs *ConfigStore
	keys    *KeyManager
	health  *Health
	metrics *Metrics
	logger  *slog.Logger
}

func NewServer(c *ConfigStore, k *KeyManager, h *Health, m *Metrics, l *slog.Logger) *Server {
	return &Server{configs: c, keys: k, health: h, metrics: m, logger: l}
}
func (s *Server) Run(ctx context.Context, dataAddr, adminAddr string) error {
	// Keep proxy traffic and administrative controls on separate listeners so
	// Compose/AWS can expose only the data plane to clients.
	dataMux := http.NewServeMux()
	proxy := NewProxy(s.configs.Store(), s.keys, s.health, s.metrics, s.logger)
	dataMux.Handle("/", proxy)
	dataMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, map[string]string{"status": "ok"}) })
	dataMux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if s.configs.Store().Load() == nil {
			jsonResponse(w, 503, map[string]string{"status": "not_ready"})
			return
		}
		jsonResponse(w, 200, map[string]string{"status": "ready"})
	})
	dataMux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) { s.metrics.prom(w) })
	adminMux := http.NewServeMux()
	adminMux.HandleFunc("/admin/v1/config", s.configEndpoint)
	adminMux.HandleFunc("/admin/v1/status", s.statusEndpoint)
	adminMux.HandleFunc("/admin/v1/secrets/refresh", s.refreshEndpoint)
	adminMux.HandleFunc("/dashboard", s.dashboard)
	adminMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, map[string]string{"status": "ok"}) })
	data := &http.Server{Addr: dataAddr, Handler: dataMux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	admin := &http.Server{Addr: adminAddr, Handler: adminMux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	errCh := make(chan error, 2)
	go func() { s.logger.Info("data plane listening", "addr", dataAddr); errCh <- data.ListenAndServe() }()
	go func() { s.logger.Info("admin plane listening", "addr", adminAddr); errCh <- admin.ListenAndServe() }()
	select {
	case <-ctx.Done():
		// Gracefully stop both listeners on SIGINT/SIGTERM, with a hard upper bound.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = data.Shutdown(shutdownCtx)
		_ = admin.Shutdown(shutdownCtx)
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
func (s *Server) configEndpoint(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		p := s.configs.Store().Load()
		w.Header().Set("ETag", fmt.Sprintf("\"%d\"", p.Revision))
		jsonResponse(w, 200, map[string]any{"revision": p.Revision, "config": p.Config})
	case http.MethodPut:
		// If-Match makes each update conditional on the revision the client read.
		expected, e := strconv.ParseInt(strings.Trim(r.Header.Get("If-Match"), "\""), 10, 64)
		if e != nil {
			jsonResponse(w, 428, map[string]string{"error": "If-Match revision is required"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		var c Config
		if e = dec.Decode(&c); e != nil {
			jsonResponse(w, 400, map[string]string{"error": "invalid config JSON: " + e.Error()})
			return
		}
		audit, e := s.configs.Replace(c, expected)
		s.metrics.inc("reload")
		if e != nil {
			code := 400
			if strings.HasPrefix(e.Error(), "revision conflict") {
				code = 412
			}
			jsonResponse(w, code, map[string]any{"error": e.Error(), "revision": audit.OldRevision})
			return
		}
		w.Header().Set("ETag", fmt.Sprintf("\"%d\"", audit.NewRevision))
		jsonResponse(w, 200, audit)
	default:
		w.Header().Set("Allow", "GET, PUT")
		jsonResponse(w, 405, map[string]string{"error": "method not allowed"})
	}
}
func (s *Server) statusEndpoint(w http.ResponseWriter, r *http.Request) {
	// Combine config, key, health, and traffic snapshots for one dashboard poll.
	p := s.configs.Store().Load()
	keyRev := "unavailable"
	if k := s.keys.Current(); k != nil {
		keyRev = k.Set.Revision
	}
	jsonResponse(w, 200, map[string]any{"revision": p.Revision, "secret_revision": keyRev, "upstreams": s.health.Snapshot(), "metrics": s.metrics.snapshot()})
}
func (s *Server) refreshEndpoint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonResponse(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if e := s.keys.Refresh(ctx); e != nil {
		jsonResponse(w, 502, map[string]any{"error": e.Error(), "retained_last_known_good": s.keys.Current() != nil})
		return
	}
	jsonResponse(w, 200, map[string]string{"status": "refreshed", "revision": s.keys.Current().Set.Revision})
}

// dashboard is a dependency-free page that polls status. Metrics are written as
// text; the health rows use validated config IDs in a small fixed markup template.
var dashboard = template.Must(template.New("dashboard").Parse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Dynamic L7 Gateway</title><style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#141c30;--line:#283550;--text:#eef4ff;--muted:#91a1bd;--cyan:#57d4e5;--green:#69d9a6;--amber:#ffd166;--red:#ff788a}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#1b3450,var(--bg) 44%);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}.wrap{max-width:1120px;margin:auto;padding:32px 22px}header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid var(--line);padding-bottom:22px}h1{font-size:clamp(26px,4vw,40px);letter-spacing:-.04em;margin:0}p{color:var(--muted);margin:.45rem 0}.badge{font:12px ui-monospace,monospace;color:var(--cyan);border:1px solid #28606b;border-radius:99px;padding:7px 10px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:22px 0}.card{background:linear-gradient(145deg,#17243a,#111a2c);border:1px solid var(--line);border-radius:14px;padding:18px;min-width:0}.label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.value{font-size:30px;font-weight:650;margin-top:8px}.unit{font-size:13px;color:var(--muted);font-weight:400}.wide{grid-column:span 2}.health{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--line)}.healthy{color:var(--green)}.unhealthy{color:var(--red)}table{width:100%;border-collapse:collapse;margin-top:12px}td,th{text-align:left;padding:10px 6px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}@media(max-width:700px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.wide{grid-column:span 2}header{align-items:start;gap:12px;flex-direction:column}}</style></head><body><main class="wrap"><header><div><h1>Dynamic L7 Gateway</h1><p>Live routing, authentication, and upstream health</p></div><span class="badge" id="fresh">CONNECTING</span></header><section class="grid"><article class="card"><div class="label">Config revision</div><div class="value" id="rev">-</div></article><article class="card"><div class="label">Requests</div><div class="value" id="requests">-</div></article><article class="card"><div class="label">JWT rejections</div><div class="value" id="jwt">-</div></article><article class="card"><div class="label">Retries / ejections</div><div class="value" id="resilience">-</div></article><article class="card wide"><div class="label">Latency</div><table><thead><tr><th>p50</th><th>p95</th><th>p99</th></tr></thead><tbody><tr><td id="p50">-</td><td id="p95">-</td><td id="p99">-</td></tr></tbody></table></article><article class="card wide"><div class="label">Upstream health</div><div id="upstreams"></div></article><article class="card wide"><div class="label">Status classes</div><div class="value" style="font-size:19px" id="statuses">-</div></article><article class="card wide"><div class="label">Secret revision</div><div class="value" style="font-size:19px" id="secret">-</div></article></section><p>Refreshes automatically every 2 seconds. Administration listens on the private management interface.</p></main><script>
const $=id=>document.getElementById(id);async function tick(){try{const r=await fetch('/admin/v1/status',{cache:'no-store'});if(!r.ok)throw Error(r.status);const d=await r.json(),m=d.metrics;$('rev').textContent=d.revision;$('requests').textContent=m.requests_total.toLocaleString();$('jwt').textContent=m.jwt_rejections;$('resilience').textContent=m.retries+' / '+m.ejections;$('p50').textContent=m.latency_ms.p50.toFixed(2)+' ms';$('p95').textContent=m.latency_ms.p95.toFixed(2)+' ms';$('p99').textContent=m.latency_ms.p99.toFixed(2)+' ms';$('statuses').textContent=Object.entries(m.status_classes).map(([k,v])=>k+' '+v).join('  ·  ')||'No traffic yet';$('secret').textContent=d.secret_revision; $('upstreams').innerHTML=Object.entries(d.upstreams).map(([id,h])=>'<div class="health"><span>'+id+'</span><span class="'+(h.healthy?'healthy':'unhealthy')+'">'+(h.healthy?'HEALTHY':'EJECTED')+(h.failures?' · '+h.failures+' failures':'')+'</span></div>').join('')||'<p>Waiting for first health probe</p>';$('fresh').textContent='LIVE · '+new Date().toLocaleTimeString()}catch(e){$('fresh').textContent='API UNAVAILABLE'}}tick();setInterval(tick,2000)</script></body></html>`))

func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = dashboard.Execute(w, nil)
}
func jsonResponse(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func LoadConfig(path string) (Config, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return Config{}, e
	}
	var c Config
	e = json.Unmarshal(b, &c)
	return c, e
}
func LocalAddrOnly(addr string) bool {
	host, _, e := net.SplitHostPort(addr)
	return e == nil && (host == "127.0.0.1" || host == "localhost" || host == "::1")
}
