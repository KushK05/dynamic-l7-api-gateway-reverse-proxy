package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	events  *EventLog
	weights *AutoWeigher
	load    *LoadGen
	logger  *slog.Logger
	// known lists extra upstreams that may receive injected faults.
	known []Upstream
	// streamInterval paces SSE frames; zero means one second.
	streamInterval time.Duration
}

// ServerDeps bundles the shared components a Server needs. Events, Weights and Load
// may be nil; both are nil-safe.
type ServerDeps struct {
	Configs *ConfigStore
	Keys    *KeyManager
	Health  *Health
	Metrics *Metrics
	Events  *EventLog
	Weights *AutoWeigher
	Load    *LoadGen
	Logger  *slog.Logger
	// KnownUpstreams are fault-eligible even when absent from the active config.
	KnownUpstreams []Upstream
}

func NewServer(d ServerDeps) *Server {
	return &Server{configs: d.Configs, keys: d.Keys, health: d.Health, metrics: d.Metrics, events: d.Events, weights: d.Weights, load: d.Load, logger: d.Logger, known: d.KnownUpstreams}
}
func (s *Server) Run(ctx context.Context, dataAddr, adminAddr string) error {
	// Keep proxy traffic and administrative controls on separate listeners so
	// Compose/AWS can expose only the data plane to clients.
	dataMux := http.NewServeMux()
	proxy := NewProxy(s.configs.Store(), s.keys, s.health, s.metrics, s.logger)
	proxy.weights = s.weights
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
	s.registerAdmin(adminMux)
	registerDashboard(adminMux)
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
		if !requireJSON(w, r) {
			return
		}
		// If-Match makes each update conditional on the revision the client read.
		expected, e := strconv.ParseInt(strings.Trim(r.Header.Get("If-Match"), "\""), 10, 64)
		if e != nil {
			s.events.Add(Event{Kind: "config", Level: "warn", Message: "Config rejected: If-Match revision is required"})
			jsonResponse(w, 428, map[string]string{"error": "If-Match revision is required"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		var c Config
		if e = dec.Decode(&c); e != nil {
			s.events.Add(Event{Kind: "config", Level: "warn", Message: "Config rejected: invalid config JSON: " + e.Error()})
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
			s.events.Add(Event{Kind: "config", Level: "warn", Message: "Config rejected: " + e.Error()})
			jsonResponse(w, code, map[string]any{"error": e.Error(), "revision": audit.OldRevision})
			return
		}
		s.events.Add(Event{Kind: "config", Level: "success", Message: fmt.Sprintf("Config revision %d applied: %d routes", audit.NewRevision, len(c.Routes))})
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
	jsonResponse(w, 200, map[string]any{"revision": p.Revision, "secret_revision": s.secretRevision(), "upstreams": s.health.Snapshot(), "metrics": s.metrics.snapshot(), "weights": s.weights.Weights()})
}
func (s *Server) secretRevision() string {
	if k := s.keys.Current(); k != nil {
		return k.Set.Revision
	}
	return "unavailable"
}
func (s *Server) refreshEndpoint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonResponse(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if e := s.keys.Refresh(ctx); e != nil {
		s.events.Add(Event{Kind: "secrets", Level: "error", Message: "Secrets refresh failed: " + e.Error()})
		jsonResponse(w, 502, map[string]any{"error": e.Error(), "retained_last_known_good": s.keys.Current() != nil})
		return
	}
	s.events.Add(Event{Kind: "secrets", Level: "success", Message: "Secrets refreshed, revision " + s.keys.Current().Set.Revision})
	jsonResponse(w, 200, map[string]string{"status": "refreshed", "revision": s.keys.Current().Set.Revision})
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
