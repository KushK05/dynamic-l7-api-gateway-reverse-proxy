package gateway

import (
	"net/http"
	"net/url"
	"sync"
	"time"
)

// upstreamHealth is the observable state for one configured upstream target.
type upstreamHealth struct {
	Healthy      bool      `json:"healthy"`
	Failures     int       `json:"failures"`
	LastChange   time.Time `json:"last_change"`
	EjectedUntil time.Time `json:"ejected_until,omitempty"`
}

// Health tracks probe outcomes and makes the current allow/eject decision safe
// for concurrent probes and request handlers.
type Health struct {
	mu            sync.RWMutex
	state         map[string]upstreamHealth
	failThreshold int
	cooldown      time.Duration
	metrics       *Metrics
}

func NewHealth(m *Metrics) *Health {
	return &Health{state: map[string]upstreamHealth{}, failThreshold: 2, cooldown: 3 * time.Second, metrics: m}
}
func (h *Health) Check(id, base string) {
	u, e := url.Parse(base)
	if e != nil {
		return
	}
	client := http.Client{Timeout: 500 * time.Millisecond}
	// Probe a fixed health path with a short deadline so a slow target cannot stall
	// the background loop or occupy a connection indefinitely.
	resp, e := client.Get(u.ResolveReference(&url.URL{Path: "/healthz"}).String())
	ok := e == nil && resp.StatusCode < 500
	if resp != nil {
		resp.Body.Close()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	old := h.state[id]
	now := time.Now()
	if ok {
		// A successful probe during cooldown does not restore traffic immediately;
		// wait until the ejection window expires, then require another good probe.
		if !old.Healthy && !old.EjectedUntil.IsZero() && now.Before(old.EjectedUntil) {
			old.Failures = 0
			h.state[id] = old
			return
		}
		if !old.Healthy {
			old.LastChange = now.UTC()
		}
		old.Healthy = true
		old.Failures = 0
		old.EjectedUntil = time.Time{}
		h.state[id] = old
		return
	}
	old.Failures++
	// Eject only after consecutive failures, and start cooldown once per ejection.
	if old.Failures >= h.failThreshold && old.Healthy {
		old.Healthy = false
		old.LastChange = now.UTC()
		old.EjectedUntil = now.Add(h.cooldown)
		h.metrics.inc("ejection")
	}
	h.state[id] = old
}
func (h *Health) Allowed(id string) bool {
	h.mu.RLock()
	v, ok := h.state[id]
	h.mu.RUnlock()
	// Unknown targets remain eligible during initial startup; the first probe then
	// establishes explicit health before subsequent routing decisions.
	return !ok || v.Healthy
}
func (h *Health) Snapshot() map[string]upstreamHealth {
	h.mu.RLock()
	defer h.mu.RUnlock()
	// Return a copy so dashboard serialization cannot race with probe updates.
	out := map[string]upstreamHealth{}
	for k, v := range h.state {
		out[k] = v
	}
	return out
}
func (h *Health) Run(stop <-chan struct{}, s *Store) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			// Derive targets from the active config each tick so hot-reloaded upstreams
			// are probed without restarting this worker.
			p := s.Load()
			if p == nil {
				continue
			}
			seen := map[string]string{}
			for _, r := range p.Config.Routes {
				for _, u := range r.Upstreams {
					seen[u.ID] = u.URL
				}
			}
			for id, base := range seen {
				h.Check(id, base)
			}
		}
	}
}
