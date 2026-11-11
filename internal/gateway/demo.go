package gateway

import (
	"bytes"
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// RequestLog is a fixed-size ring. Keeping only routing metadata avoids collecting
// user paths, credentials or payloads and bounds memory even during load tests.
type RequestEntry struct {
	Time       time.Time `json:"time"`
	Method     string    `json:"method"`
	RequestID  string    `json:"request_id"`
	Route      string    `json:"route"`
	Upstream   string    `json:"upstream"`
	Status     int       `json:"status"`
	DurationMS float64   `json:"duration_ms"`
	Revision   int64     `json:"revision"`
}
type RequestLog struct {
	mu          sync.Mutex
	entries     [200]RequestEntry
	next, count int
}

func (l *RequestLog) Add(e RequestEntry) {
	// Caller-controlled request IDs are useful for correlation, but must be bounded.
	if len(e.RequestID) > 128 {
		e.RequestID = e.RequestID[:128]
	}
	if len(e.Method) > 32 {
		e.Method = e.Method[:32]
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries[l.next] = e
	l.next = (l.next + 1) % len(l.entries)
	if l.count < len(l.entries) {
		l.count++
	}
}
func (l *RequestLog) Recent() []RequestEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]RequestEntry, 0, l.count)
	for i := 0; i < l.count; i++ {
		out = append(out, l.entries[(l.next-1-i+len(l.entries))%len(l.entries)])
	}
	return out
}
func (s *Server) requestsEndpoint(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	jsonResponse(w, 200, map[string]any{"requests": s.requests.Recent()})
}
func (s *Server) historyEndpoint(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	jsonResponse(w, 200, map[string]any{"history": s.configs.History()})
}

// previewResponse caps captured response data without changing proxy streaming
// behavior or exposing an arbitrary outbound URL through the playground.
type previewEntryKey struct{}

type previewResponse struct {
	header    http.Header
	status    int
	body      bytes.Buffer
	truncated bool
}

func (p *previewResponse) Header() http.Header { return p.header }
func (p *previewResponse) WriteHeader(n int) {
	if p.status == 0 {
		p.status = n
	}
}
func (p *previewResponse) Write(b []byte) (int, error) {
	if p.status == 0 {
		p.status = 200
	}
	remaining := (64 << 10) - p.body.Len()
	if len(b) > remaining {
		p.truncated = true
	}
	if remaining > len(b) {
		remaining = len(b)
	}
	if remaining > 0 {
		_, _ = p.body.Write(b[:remaining])
	}
	return len(b), nil
}
func (p *previewResponse) Flush() {
	if p.status == 0 {
		p.status = 200
	}
}

func (s *Server) playgroundEndpoint(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !requireJSON(w, r) {
		return
	}
	var in struct {
		Method  string            `json:"method"`
		Path    string            `json:"path"`
		Host    string            `json:"host"`
		Headers map[string]string `json:"headers"`
		Token   string            `json:"token"`
		Body    string            `json:"body"`
	}
	if err := decodeStrict(w, r, &in); err != nil {
		errorJSON(w, 400, "invalid playground JSON: "+err.Error())
		return
	}
	switch in.Method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
	default:
		errorJSON(w, 400, "unsupported method")
		return
	}
	u, err := url.ParseRequestURI(in.Path)
	if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(in.Path, "/") || strings.HasPrefix(in.Path, "//") {
		errorJSON(w, 400, "use a relative gateway path starting with /, not an external URL")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	entry := &RequestEntry{}
	ctx = context.WithValue(ctx, previewEntryKey{}, entry)
	req, err := http.NewRequestWithContext(ctx, in.Method, "http://gateway"+in.Path, strings.NewReader(in.Body))
	if err != nil {
		errorJSON(w, 400, "invalid request")
		return
	}
	req.Host = "demo.local"
	if in.Host != "" {
		req.Host = in.Host
	}
	for key, value := range in.Headers {
		// Routing headers are allowed, transport/proxy headers and cookies are not.
		k := http.CanonicalHeaderKey(key)
		if k != "Content-Type" && k != "Accept" && k != "Authorization" && (!strings.HasPrefix(k, "X-") || strings.HasPrefix(k, "X-Forwarded-") || strings.HasPrefix(k, "X-Gateway-")) {
			errorJSON(w, 400, "allowed headers: Content-Type, Accept, Authorization and custom X- headers")
			return
		}
		// Constructing headers directly requires rejecting control characters ourselves.
		if strings.ContainsAny(key+value, "\r\n") {
			errorJSON(w, 400, "invalid header")
			return
		}
		req.Header.Set(k, value)
	}
	if in.Token != "" {
		req.Header.Set("Authorization", "Bearer "+in.Token)
	}
	out := &previewResponse{header: make(http.Header)}
	start := time.Now()
	// This is the same handler/transport as the public data plane: JWT checks,
	// health selection, retries, metrics and request logging all remain active.
	s.proxy.ServeHTTP(out, req)
	if out.status == 0 {
		out.status = 200
	}
	jsonResponse(w, 200, map[string]any{"status": out.status, "route": entry.Route, "upstream": entry.Upstream, "duration_ms": float64(time.Since(start).Microseconds()) / 1000, "request_id": out.header.Get("X-Request-ID"), "revision": out.header.Get("X-Config-Revision"), "body": out.body.String(), "truncated": out.truncated})
}
