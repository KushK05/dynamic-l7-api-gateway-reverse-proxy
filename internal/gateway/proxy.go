package gateway

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Proxy keeps request handlers stateless while all route decisions come from
// the shared active snapshot and resilience managers.
type Proxy struct {
	store     *Store
	keys      *KeyManager
	health    *Health
	metrics   *Metrics
	logger    *slog.Logger
	clockSkew time.Duration
	transport *http.Transport
}

func NewProxy(s *Store, k *KeyManager, h *Health, m *Metrics, l *slog.Logger) *Proxy {
	// Reuse a tuned transport across requests so keep-alive pools are shared rather
	// than creating fresh TCP connections for every proxied call.
	return &Proxy{store: s, keys: k, health: h, metrics: m, logger: l, clockSkew: 30 * time.Second, transport: &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: 500 * time.Millisecond, KeepAlive: 30 * time.Second}).DialContext, ResponseHeaderTimeout: 120 * time.Second, IdleConnTimeout: 90 * time.Second, MaxIdleConns: 512, MaxIdleConnsPerHost: 128, ForceAttemptHTTP2: true}}
}
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	capture := &statusCapture{ResponseWriter: w}
	w = capture
	snap := p.store.Load()
	// Hold this snapshot pointer for the full request. A concurrent reload swaps the
	// Store pointer but cannot change the revision or routes this handler sees.
	if snap == nil {
		http.Error(w, "gateway not ready", 503)
		return
	}
	w.Header().Set("X-Config-Revision", strconv.FormatInt(snap.Revision, 10))
	id := r.Header.Get("X-Request-ID")
	if id == "" {
		id = fmt.Sprintf("%x", time.Now().UnixNano())
	}
	w.Header().Set("X-Request-ID", id)
	var route *Route
	host := r.Host
	if h, _, e := net.SplitHostPort(host); e == nil {
		host = h
	}
	for i := range snap.byPriority {
		// Routes are already sorted by descending priority when the snapshot is built.
		if snap.byPriority[i].Match.matches(host, r.Method, r.URL.Path, normalizedHeaders(r.Header)) {
			route = &snap.byPriority[i]
			break
		}
	}
	if route == nil {
		http.NotFound(w, r)
		p.metrics.observe(snap.Revision, 404, time.Since(start), requestBytes(r), capture.bytes)
		return
	}
	if route.JWT != nil && route.JWT.Required {
		token, e := bearer(r.Header.Get("Authorization"))
		if e == nil {
			e = verifyJWT(token, p.keys.Current(), p.clockSkew)
		}
		if e != nil {
			p.metrics.inc("jwt")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			p.metrics.observe(snap.Revision, 401, time.Since(start), requestBytes(r), capture.bytes)
			return
		}
	}
	up, ok := p.pick(*route, id)
	if !ok {
		http.Error(w, "no healthy upstream", http.StatusServiceUnavailable)
		p.metrics.observe(snap.Revision, 503, time.Since(start), requestBytes(r), capture.bytes)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(route.TimeoutMS)*time.Millisecond)
	defer cancel()
	target, e := url.Parse(up.URL)
	if e != nil {
		http.Error(w, "invalid upstream", 502)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = target.Host
		if route.RewritePrefix != "" && strings.HasPrefix(req.URL.Path, route.Match.PathPrefix) {
			// Replace only the matched leading prefix; retain the unmatched suffix.
			suffix := strings.TrimPrefix(req.URL.Path, route.Match.PathPrefix)
			req.URL.Path = strings.TrimRight(route.RewritePrefix, "/") + suffix
			if req.URL.Path == "" {
				req.URL.Path = "/"
			}
		}
		req.Header.Set("X-Forwarded-Host", r.Host)
		req.Header.Set("X-Forwarded-Proto", scheme(r))
		req.Header.Set("X-Request-ID", id)
		req.Header.Set("X-Gateway-Route", route.ID)
		req.Header.Set("X-Gateway-Upstream", up.ID)
		req.Header.Set("X-Gateway-Config-Revision", strconv.FormatInt(snap.Revision, 10))
	}
	// Flush streaming responses immediately rather than buffering them in the proxy.
	proxy.FlushInterval = -1
	proxy.Transport = &retryTransport{base: p.transport, route: *route, first: up, proxy: p, seed: id}
	// Keep the gateway-generated ID authoritative. Upstreams receive it on the
	// request, but their response copy is discarded to avoid duplicate headers.
	proxy.ModifyResponse = func(resp *http.Response) error {
		resp.Header.Del("X-Request-ID")
		return nil
	}
	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, err error) {
		p.logger.Warn("upstream request failed", "route", route.ID, "error", err)
		http.Error(rw, "upstream unavailable", http.StatusBadGateway)
	}
	req := r.Clone(ctx)
	proxy.ServeHTTP(w, req)
	status := capture.status
	if status == 0 {
		status = 200
	}
	p.metrics.observe(snap.Revision, status, time.Since(start), requestBytes(r), capture.bytes)
}

// statusCapture is separate to preserve streaming writes while recording status.
type statusCapture struct {
	http.ResponseWriter
	status int
	bytes  uint64
}

func (w *statusCapture) WriteHeader(n int) {
	if w.status == 0 {
		w.status = n
	}
	w.ResponseWriter.WriteHeader(n)
}
func (w *statusCapture) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	n, e := w.ResponseWriter.Write(b)
	w.bytes += uint64(n)
	return n, e
}
func (w *statusCapture) Flush() {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (w *statusCapture) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (p *Proxy) pick(r Route, seed string) (Upstream, bool) {
	// Remove ejected targets and renormalize the remaining configured weights.
	healthy := []Upstream{}
	for _, u := range r.Upstreams {
		if u.Weight > 0 && p.health.Allowed(u.ID) {
			healthy = append(healthy, u)
		}
	}
	if len(healthy) == 0 {
		return Upstream{}, false
	}
	sum := 0
	for _, u := range healthy {
		sum += u.Weight
	}
	// Hashing a stable request ID gives deterministic routing for the same request ID
	// while distributing ordinary unique IDs across the configured weight ranges.
	hash := sha256.Sum256([]byte(seed))
	n := int(uint64From(hash[:8]) % uint64(sum))
	for _, u := range healthy {
		if n < u.Weight {
			return u, true
		}
		n -= u.Weight
	}
	return healthy[len(healthy)-1], true
}
func normalizedHeaders(h http.Header) map[string][]string {
	m := map[string][]string{}
	for k, v := range h {
		m[strings.ToLower(k)] = v
	}
	return m
}
func scheme(r *http.Request) string {
	// Honor X-Forwarded-Proto when a trusted upstream proxy already terminated TLS.
	if r.TLS != nil {
		return "https"
	}
	if v := r.Header.Get("X-Forwarded-Proto"); v != "" {
		return v
	}
	return "http"
}
func uint64From(b []byte) uint64 {
	var n uint64
	for _, v := range b {
		n = n<<8 | uint64(v)
	}
	return n
}
func contextWithTimeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}
func requestBytes(r *http.Request) uint64 {
	// Unknown/chunked request sizes are reported as zero rather than guessed.
	if r.ContentLength > 0 {
		return uint64(r.ContentLength)
	}
	return 0
}

type retryTransport struct {
	base  http.RoundTripper
	route Route
	first Upstream
	proxy *Proxy
	seed  string
}

func (t *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	if err == nil || t.route.RetryAttempts < 1 || (req.Method != "GET" && req.Method != "HEAD") {
		return resp, err
	}
	t.proxy.health.Check(t.first.ID, t.first.URL)
	// Retry only a transport failure, only for idempotent methods, and only on a
	// different currently eligible target. HTTP status responses are never replayed.
	next, ok := t.proxy.pickDifferent(t.route, t.seed+"-retry", t.first.ID)
	if !ok {
		return nil, err
	}
	target, e := url.Parse(next.URL)
	if e != nil {
		return nil, err
	}
	clone := req.Clone(req.Context())
	clone.URL.Scheme = target.Scheme
	clone.URL.Host = target.Host
	clone.Host = target.Host
	clone.Header = req.Header.Clone()
	clone.Header.Set("X-Gateway-Upstream", next.ID)
	t.proxy.metrics.inc("retry")
	return t.base.RoundTrip(clone)
}
func (p *Proxy) pickDifferent(r Route, seed, excluded string) (Upstream, bool) {
	filtered := r
	filtered.Upstreams = make([]Upstream, 0, len(r.Upstreams))
	for _, u := range r.Upstreams {
		if u.ID != excluded {
			filtered.Upstreams = append(filtered.Upstreams, u)
		}
	}
	return p.pick(filtered, seed)
}
