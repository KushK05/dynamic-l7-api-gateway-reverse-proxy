package main

import (
	"encoding/json"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// fault is shared mutable demo state. The lock keeps admin updates consistent
// with concurrent data-plane requests and active health probes.
type fault struct {
	mu        sync.RWMutex
	delay     time.Duration
	status    int
	unhealthy bool
	errorRate int
}

// profile gives an upstream a service-like latency shape: every proxied request
// waits base plus a uniform random amount in [0, jitter).
type profile struct {
	base   time.Duration
	jitter time.Duration
}

func main() {
	id := env("UPSTREAM_ID", "v1")
	port := env("PORT", "9101")
	service := env("SERVICE", "demo")
	p := profile{
		base:   time.Duration(boundedMS("BASE_DELAY_MS")) * time.Millisecond,
		jitter: time.Duration(boundedMS("JITTER_MS")) * time.Millisecond,
	}
	h := newHandler(id, service, p, &fault{}, rand.IntN)
	log.Printf("upstream %s (%s) listening on %s", id, service, port)
	log.Fatal(http.ListenAndServe(":"+strconv.Itoa(mustInt(port)), h))
}

// newHandler builds the upstream mux. rnd(n) must return a value in [0, n) and
// is injectable so tests can make error sampling and jitter deterministic.
func newHandler(id, service string, p profile, f *fault, rnd func(int) int) http.Handler {
	mux := http.NewServeMux()
	// The health endpoint intentionally reflects the injected unhealthy switch,
	// allowing the gateway's real probe loop to exercise ejection and recovery.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		f.mu.RLock()
		bad := f.unhealthy
		f.mu.RUnlock()
		if bad {
			http.Error(w, "unhealthy", 503)
			return
		}
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/admin/fault", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			f.mu.RLock()
			state := map[string]any{
				"delay_ms":           int(f.delay / time.Millisecond),
				"status":             f.status,
				"unhealthy":          f.unhealthy,
				"error_rate_percent": f.errorRate,
			}
			f.mu.RUnlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(state)
		case http.MethodPost:
			var x struct {
				DelayMS   int  `json:"delay_ms"`
				Status    int  `json:"status"`
				Unhealthy bool `json:"unhealthy"`
				ErrorRate int  `json:"error_rate_percent"`
			}
			// Bound the admin payload before decoding and validate values before changing
			// shared state, so malformed requests never partially apply a fault.
			if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&x) != nil || x.DelayMS < 0 || x.DelayMS > 30000 || x.ErrorRate < 0 || x.ErrorRate > 100 {
				http.Error(w, "invalid fault settings", 400)
				return
			}
			f.mu.Lock()
			f.delay = time.Duration(x.DelayMS) * time.Millisecond
			f.status = x.Status
			f.unhealthy = x.Unhealthy
			f.errorRate = x.ErrorRate
			f.mu.Unlock()
			w.WriteHeader(204)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "GET or POST required", 405)
		}
	})
	mux.HandleFunc("/admin/reset", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, "POST required", 405)
			return
		}
		// Reset all fields together under the lock to provide one clean recovery point.
		f.mu.Lock()
		f.delay = 0
		f.status = 0
		f.unhealthy = false
		f.errorRate = 0
		f.mu.Unlock()
		w.WriteHeader(204)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Copy fault settings while locked, then sleep/respond without holding the lock
		// so control requests can still update or clear a long delay.
		f.mu.RLock()
		d, s, rate := f.delay, f.status, f.errorRate
		f.mu.RUnlock()
		wait := p.base + d
		if p.jitter > 0 {
			wait += time.Duration(rnd(int(p.jitter)))
		}
		time.Sleep(wait)
		if s >= 400 || (rate > 0 && rnd(100) < rate) {
			if s < 400 {
				s = 500
			}
			http.Error(w, "injected upstream failure", s)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Upstream-ID", id)
		w.Header().Set("X-Request-ID", r.Header.Get("X-Request-ID"))
		_ = json.NewEncoder(w).Encode(map[string]any{"upstream": id, "service": service, "method": r.Method, "path": r.URL.Path, "request_id": r.Header.Get("X-Request-ID"), "revision": r.Header.Get("X-Gateway-Config-Revision"), "time": time.Now().UTC()})
	})
	return mux
}

// boundedMS reads a millisecond env var (default 0) and fails fast outside 0..10000.
func boundedMS(k string) int {
	n := mustInt(env(k, "0"))
	if n < 0 || n > 10000 {
		log.Fatalf("%s must be between 0 and 10000, got %d", k, n)
	}
	return n
}

func env(k, d string) string {
	// Keep local execution convenient while allowing Compose to identify each instance.
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func mustInt(s string) int {
	// Port configuration is deployment input; fail fast instead of binding an accidental port.
	n, e := strconv.Atoi(s)
	if e != nil {
		log.Fatal(e)
	}
	return n
}
