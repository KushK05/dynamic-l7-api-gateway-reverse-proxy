package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	adminBodyLimit    = 4 << 10
	faultReadTimeout  = 300 * time.Millisecond
	faultWriteTimeout = 5 * time.Second
	defaultStreamTick = time.Second
)

// faultSettings mirrors the mock upstream's /admin/fault document.
type faultSettings struct {
	DelayMS          int  `json:"delay_ms"`
	Status           int  `json:"status"`
	Unhealthy        bool `json:"unhealthy"`
	ErrorRatePercent int  `json:"error_rate_percent"`
}

// upstreamView is one row of GET /admin/v1/upstreams.
type upstreamView struct {
	ID       string          `json:"id"`
	URL      string          `json:"url"`
	InConfig bool            `json:"in_config"`
	Known    bool            `json:"known"`
	Health   *upstreamHealth `json:"health"`
	Fault    *faultSettings  `json:"fault"`
}

// registerAdmin installs the dashboard endpoints on the admin mux.
func (s *Server) registerAdmin(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/v1/requests", s.requestsEndpoint)
	mux.HandleFunc("POST /admin/v1/playground", s.playgroundEndpoint)
	mux.HandleFunc("GET /admin/v1/history", s.historyEndpoint)
	mux.HandleFunc("GET /admin/v1/series", s.seriesEndpoint)
	mux.HandleFunc("GET /admin/v1/events", s.eventsEndpoint)
	mux.HandleFunc("GET /admin/v1/load", s.loadGetEndpoint)
	mux.HandleFunc("PUT /admin/v1/load", s.loadPutEndpoint)
	mux.HandleFunc("GET /admin/v1/upstreams", s.upstreamsEndpoint)
	mux.HandleFunc("POST /admin/v1/upstreams/{id}/fault", s.faultEndpoint)
	mux.HandleFunc("POST /admin/v1/upstreams/{id}/reset", s.resetEndpoint)
	mux.HandleFunc("GET /admin/v1/stream", s.streamEndpoint)
}

// requireJSON enforces Content-Type: application/json on mutating endpoints so a
// cross-site "simple request" cannot change state. Parameters such as charset are fine.
func requireJSON(w http.ResponseWriter, r *http.Request) bool {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		jsonResponse(w, http.StatusUnsupportedMediaType, map[string]string{"error": "Content-Type must be application/json"})
		return false
	}
	return true
}

func errorJSON(w http.ResponseWriter, code int, msg string) {
	jsonResponse(w, code, map[string]string{"error": msg})
}

func (s *Server) seriesEndpoint(w http.ResponseWriter, r *http.Request) {
	n := 120
	if v := r.URL.Query().Get("seconds"); v != "" {
		parsed, err := strconv.Atoi(v)
		if err != nil {
			errorJSON(w, 400, "seconds must be an integer")
			return
		}
		n = parsed
	}
	jsonResponse(w, 200, map[string]any{"points": s.metrics.Series(clampSeconds(n))})
}

func (s *Server) eventsEndpoint(w http.ResponseWriter, r *http.Request) {
	var since uint64
	if v := r.URL.Query().Get("since"); v != "" {
		parsed, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			errorJSON(w, 400, "since must be a non-negative integer")
			return
		}
		since = parsed
	}
	var out []Event
	if since == 0 {
		out = s.events.Recent(100)
	} else {
		out = s.events.Since(since)
	}
	if out == nil {
		out = []Event{}
	}
	jsonResponse(w, 200, map[string]any{"events": out})
}

func (s *Server) loadGetEndpoint(w http.ResponseWriter, r *http.Request) {
	if s.load == nil {
		errorJSON(w, 503, "load generator unavailable")
		return
	}
	jsonResponse(w, 200, s.load.Status())
}

func (s *Server) loadPutEndpoint(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}
	if s.load == nil {
		errorJSON(w, 503, "load generator unavailable")
		return
	}
	var in LoadSettings
	if err := decodeStrict(w, r, &in); err != nil {
		errorJSON(w, 400, "invalid load JSON: "+err.Error())
		return
	}
	if _, err := s.load.Apply(in); err != nil {
		errorJSON(w, 400, err.Error())
		return
	}
	jsonResponse(w, 200, s.load.Status())
}

// decodeStrict reads one JSON document of at most 4 KiB, rejecting unknown
// fields and trailing data.
func decodeStrict(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, adminBodyLimit)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("unexpected trailing data")
	}
	return nil
}

// upstreamTargets returns the fault-eligible upstreams: the active config plus the
// known list. The active config wins when an ID appears in both.
func (s *Server) upstreamTargets() map[string]*upstreamView {
	out := map[string]*upstreamView{}
	for _, u := range s.known {
		out[u.ID] = &upstreamView{ID: u.ID, URL: u.URL, Known: true}
	}
	if snap := s.configs.Store().Load(); snap != nil {
		for _, r := range snap.Config.Routes {
			for _, u := range r.Upstreams {
				v := out[u.ID]
				if v == nil {
					v = &upstreamView{ID: u.ID}
					out[u.ID] = v
				}
				v.URL, v.InConfig = u.URL, true
			}
		}
	}
	return out
}

func (s *Server) faultClient() *http.Client {
	return &http.Client{
		Timeout: faultWriteTimeout,
		// A mock upstream has no reason to redirect; never follow one elsewhere.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func (s *Server) upstreamsEndpoint(w http.ResponseWriter, r *http.Request) {
	targets := s.upstreamTargets()
	hs := s.health.Snapshot()
	rows := make([]*upstreamView, 0, len(targets))
	for _, v := range targets {
		if h, ok := hs[v.ID]; ok {
			h := h
			v.Health = &h
		}
		rows = append(rows, v)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	client := s.faultClient()
	var wg sync.WaitGroup
	for _, v := range rows {
		wg.Add(1)
		go func(v *upstreamView) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(r.Context(), faultReadTimeout)
			defer cancel()
			v.Fault = readFault(ctx, client, v.URL)
		}(v)
	}
	wg.Wait()
	jsonResponse(w, 200, map[string]any{"upstreams": rows})
}

func readFault(ctx context.Context, c *http.Client, base string) *faultSettings {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/admin/fault", nil)
	if err != nil {
		return nil
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var f faultSettings
	if json.NewDecoder(io.LimitReader(resp.Body, adminBodyLimit)).Decode(&f) != nil {
		return nil
	}
	return &f
}

func (f faultSettings) validate() error {
	switch {
	case f.DelayMS < 0 || f.DelayMS > 30000:
		return errors.New("delay_ms must be between 0 and 30000")
	case f.Status != 0 && (f.Status < 400 || f.Status > 599):
		return errors.New("status must be 0 or between 400 and 599")
	case f.ErrorRatePercent < 0 || f.ErrorRatePercent > 100:
		return errors.New("error_rate_percent must be between 0 and 100")
	}
	return nil
}

// summary builds the operator-facing event text for an applied fault.
func (f faultSettings) summary(id string) (string, string) {
	var injected []string
	if f.DelayMS > 0 {
		injected = append(injected, fmt.Sprintf("%d ms latency", f.DelayMS))
	}
	if f.ErrorRatePercent > 0 {
		injected = append(injected, fmt.Sprintf("%d%% errors", f.ErrorRatePercent))
	}
	if f.Status != 0 {
		injected = append(injected, fmt.Sprintf("status %d responses", f.Status))
	}
	var parts []string
	if len(injected) > 0 {
		parts = append(parts, "Injected "+strings.Join(injected, " and ")+" into "+id)
	}
	if f.Unhealthy {
		msg := id + " set to fail health checks"
		if f.Status != 0 {
			msg += fmt.Sprintf(" and return %d", f.Status)
		}
		parts = append(parts, msg)
	}
	if len(parts) == 0 {
		return "success", "Faults cleared on " + id
	}
	return "warn", strings.Join(parts, "; ")
}

// forward sends one request to a known upstream's admin surface.
func (s *Server) forward(ctx context.Context, base, path string, body []byte) error {
	method := http.MethodPost
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(base, "/")+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.faultClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, adminBodyLimit))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("upstream returned status %d", resp.StatusCode)
	}
	return nil
}

func (s *Server) faultEndpoint(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}
	id := r.PathValue("id")
	target := s.upstreamTargets()[id]
	if target == nil {
		errorJSON(w, 404, "unknown upstream "+strconv.Quote(id))
		return
	}
	var f faultSettings
	if err := decodeStrict(w, r, &f); err != nil {
		errorJSON(w, 400, "invalid fault JSON: "+err.Error())
		return
	}
	if err := f.validate(); err != nil {
		errorJSON(w, 400, err.Error())
		return
	}
	body, _ := json.Marshal(f)
	if err := s.forward(r.Context(), target.URL, "/admin/fault", body); err != nil {
		s.events.Add(Event{Kind: "fault", Level: "error", Upstream: id, Message: "Fault injection failed for " + id + ": " + err.Error()})
		errorJSON(w, 502, "upstream fault update failed: "+err.Error())
		return
	}
	level, msg := f.summary(id)
	s.events.Add(Event{Kind: "fault", Level: level, Upstream: id, Message: msg})
	jsonResponse(w, 200, map[string]string{"status": "applied"})
}

func (s *Server) resetEndpoint(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}
	id := r.PathValue("id")
	target := s.upstreamTargets()[id]
	if target == nil {
		errorJSON(w, 404, "unknown upstream "+strconv.Quote(id))
		return
	}
	if err := s.forward(r.Context(), target.URL, "/admin/reset", nil); err != nil {
		s.events.Add(Event{Kind: "fault", Level: "error", Upstream: id, Message: "Fault reset failed for " + id + ": " + err.Error()})
		errorJSON(w, 502, "upstream reset failed: "+err.Error())
		return
	}
	s.events.Add(Event{Kind: "fault", Level: "success", Upstream: id, Message: "Faults cleared on " + id})
	jsonResponse(w, 200, map[string]string{"status": "applied"})
}

// sseWrite emits one named event and flushes it.
func sseWrite(w http.ResponseWriter, rc *http.ResponseController, name string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		// Keep the connection alive and let the client see the next frame.
		if _, e := io.WriteString(w, ": ping\n\n"); e != nil {
			return e
		}
		return rc.Flush()
	}
	if _, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b); err != nil {
		return err
	}
	return rc.Flush()
}

func (s *Server) streamEndpoint(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	recent := s.events.Recent(50)
	if recent == nil {
		recent = []Event{}
	}
	var lastSeq uint64
	if len(recent) > 0 {
		lastSeq = recent[len(recent)-1].Seq
	}
	if err := sseWrite(w, rc, "hello", map[string]any{"series": s.metrics.Series(120), "events": recent}); err != nil {
		return
	}
	interval := s.streamInterval
	if interval <= 0 {
		interval = defaultStreamTick
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-t.C:
		}
		frame := s.buildFrame(lastSeq)
		if evs := frame["events"].([]Event); len(evs) > 0 {
			lastSeq = evs[len(evs)-1].Seq
		}
		if err := sseWrite(w, rc, "frame", frame); err != nil {
			return
		}
	}
}

func (s *Server) buildFrame(lastSeq uint64) map[string]any {
	total, ups := s.metrics.InFlight()
	evs := s.events.Since(lastSeq)
	if evs == nil {
		evs = []Event{}
	}
	var load any
	if s.load != nil {
		load = s.load.Status()
	}
	var rev int64
	if p := s.configs.Store().Load(); p != nil {
		rev = p.Revision
	}
	var point SeriesPoint
	if pts := s.metrics.Series(1); len(pts) > 0 {
		point = pts[0]
	}
	return map[string]any{
		"ts":              time.Now().Unix(),
		"revision":        rev,
		"secret_revision": s.secretRevision(),
		"point":           point,
		"window":          s.metrics.Window(5),
		"inflight":        map[string]any{"total": total, "upstreams": ups},
		"health":          s.health.Snapshot(),
		"weights":         s.weights.Weights(),
		"load":            load,
		"events":          evs,
		"totals":          s.metrics.snapshot(),
	}
}

// ParseKnownUpstreams parses "id=url,id=url" into upstreams that may receive
// injected faults even when they are not in the active config.
func ParseKnownUpstreams(s string) ([]Upstream, error) {
	out := []Upstream{}
	seen := map[string]bool{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, raw, ok := strings.Cut(part, "=")
		id, raw = strings.TrimSpace(id), strings.TrimSpace(raw)
		if !ok || !safeIdentifier.MatchString(id) {
			return nil, fmt.Errorf("known upstream %q must look like id=url with a safe id", part)
		}
		if !validUpstreamURL(raw) {
			return nil, fmt.Errorf("known upstream %s has invalid URL", id)
		}
		if seen[id] {
			return nil, fmt.Errorf("known upstream %s is listed twice", id)
		}
		seen[id] = true
		out = append(out, Upstream{ID: id, URL: raw})
	}
	return out, nil
}
