package gateway

import (
	"context"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	loadTick           = 10 * time.Millisecond
	loadMaxConcurrency = 1024
	loadInvalidToken   = "invalid.token.value"
)

// LoadMix weights one route in the generated traffic.
type LoadMix struct {
	Route  string `json:"route"`
	Weight int    `json:"weight"` // 0..100
}

// LoadSettings is the operator-controlled shape of the generated traffic.
type LoadSettings struct {
	RPS                 int       `json:"rps"`                   // 0..maxRPS; 0 = stopped
	Concurrency         int       `json:"concurrency"`           // 1..1024, default 256
	Mix                 []LoadMix `json:"mix,omitempty"`         // empty = every active route equally
	InvalidTokenPercent int       `json:"invalid_token_percent"` // 0..100, default 10
}

// LoadStatus is the point-in-time view served to the dashboard.
type LoadStatus struct {
	Settings   LoadSettings `json:"settings"`
	MaxRPS     int          `json:"max_rps"`
	HasToken   bool         `json:"has_token"`
	SentPerSec float64      `json:"sent_per_sec"` // over the last completed second
	ShedPerSec float64      `json:"shed_per_sec"`
	InFlight   int64        `json:"in_flight"`
	TotalSent  uint64       `json:"total_sent"`
	TotalShed  uint64       `json:"total_shed"`
}

// LoadGen drives synthetic traffic at the gateway's own data plane.
type LoadGen struct {
	target string
	store  *Store
	events *EventLog
	maxRPS int
	token  string
	client *http.Client

	mu       sync.RWMutex
	settings LoadSettings

	inFlight  atomic.Int64
	totalSent atomic.Uint64
	totalShed atomic.Uint64

	// Two-slot per-second counters: cur is the second in progress, prev the
	// last completed one.
	cmu                sync.Mutex
	curSec             int64
	curSent, curShed   uint64
	prevSent, prevShed uint64
}

func NewLoadGen(target string, s *Store, e *EventLog, maxRPS int, token string) *LoadGen {
	tr := &http.Transport{
		MaxIdleConns:        1024,
		MaxIdleConnsPerHost: 1024,
		IdleConnTimeout:     90 * time.Second,
	}
	return &LoadGen{
		target: strings.TrimRight(target, "/"),
		store:  s,
		events: e,
		maxRPS: maxRPS,
		token:  token,
		client: &http.Client{Transport: tr, Timeout: 10 * time.Second},
		settings: LoadSettings{
			Concurrency:         256,
			InvalidTokenPercent: 10,
		},
	}
}

// Apply validates and installs new settings, returning the normalized copy.
func (g *LoadGen) Apply(s LoadSettings) (LoadSettings, error) {
	if s.RPS < 0 || s.RPS > g.maxRPS {
		return LoadSettings{}, fmt.Errorf("rps must be between 0 and %d", g.maxRPS)
	}
	if s.Concurrency < 1 || s.Concurrency > loadMaxConcurrency {
		return LoadSettings{}, fmt.Errorf("concurrency must be between 1 and %d", loadMaxConcurrency)
	}
	if s.InvalidTokenPercent < 0 || s.InvalidTokenPercent > 100 {
		return LoadSettings{}, fmt.Errorf("invalid_token_percent must be between 0 and 100")
	}
	known := map[string]bool{}
	if snap := g.store.Load(); snap != nil {
		for _, r := range snap.Config.Routes {
			known[r.ID] = true
		}
	}
	var mix []LoadMix
	for _, m := range s.Mix {
		if m.Weight < 0 || m.Weight > 100 {
			return LoadSettings{}, fmt.Errorf("mix weight for %q must be between 0 and 100", m.Route)
		}
		if !known[m.Route] {
			return LoadSettings{}, fmt.Errorf("mix references unknown route %q", m.Route)
		}
		mix = append(mix, m)
	}
	s.Mix = mix

	g.mu.Lock()
	prev := g.settings
	g.settings = s
	g.mu.Unlock()

	if !sameLoadSettings(prev, s) {
		switch {
		case s.RPS > 0:
			g.events.Add(Event{Kind: "load", Level: "info", Message: fmt.Sprintf("Traffic generator set to %d rps", s.RPS)})
		case prev.RPS > 0:
			g.events.Add(Event{Kind: "load", Level: "info", Message: "Traffic generator stopped"})
		}
	}
	return s, nil
}

func sameLoadSettings(a, b LoadSettings) bool {
	if a.RPS != b.RPS || a.Concurrency != b.Concurrency || a.InvalidTokenPercent != b.InvalidTokenPercent || len(a.Mix) != len(b.Mix) {
		return false
	}
	for i := range a.Mix {
		if a.Mix[i] != b.Mix[i] {
			return false
		}
	}
	return true
}

func (g *LoadGen) current() LoadSettings {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.settings
}

func (g *LoadGen) Status() LoadStatus {
	s := g.current()
	sent, shed := g.lastSecond(time.Now())
	return LoadStatus{
		Settings:   s,
		MaxRPS:     g.maxRPS,
		HasToken:   g.token != "",
		SentPerSec: sent,
		ShedPerSec: shed,
		InFlight:   g.inFlight.Load(),
		TotalSent:  g.totalSent.Load(),
		TotalShed:  g.totalShed.Load(),
	}
}

// rollLocked advances the two-slot window to the second containing now.
func (g *LoadGen) rollLocked(now time.Time) {
	sec := now.Unix()
	if sec == g.curSec {
		return
	}
	if sec == g.curSec+1 {
		g.prevSent, g.prevShed = g.curSent, g.curShed
	} else {
		g.prevSent, g.prevShed = 0, 0
	}
	g.curSent, g.curShed, g.curSec = 0, 0, sec
}

func (g *LoadGen) record(now time.Time, shed bool) {
	g.cmu.Lock()
	defer g.cmu.Unlock()
	g.rollLocked(now)
	if shed {
		g.curShed++
	} else {
		g.curSent++
	}
}

func (g *LoadGen) lastSecond(now time.Time) (sent, shed float64) {
	g.cmu.Lock()
	defer g.cmu.Unlock()
	g.rollLocked(now)
	return float64(g.prevSent), float64(g.prevShed)
}

// Run paces requests until ctx is cancelled.
func (g *LoadGen) Run(ctx context.Context) {
	t := time.NewTicker(loadTick)
	defer t.Stop()
	var acc float64
	last := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			// Use real elapsed time so a delayed tick does not lose requests.
			dt := now.Sub(last)
			last = now
			if dt > 250*time.Millisecond {
				dt = 250 * time.Millisecond
			}
			s := g.current()
			if s.RPS == 0 {
				acc = 0
				continue
			}
			acc += float64(s.RPS) * dt.Seconds()
			n := int(acc)
			acc -= float64(n)
			for i := 0; i < n; i++ {
				g.dispatch(ctx, s)
			}
		}
	}
}

func (g *LoadGen) acquire(limit int) bool {
	for {
		cur := g.inFlight.Load()
		if cur >= int64(limit) {
			return false
		}
		if g.inFlight.CompareAndSwap(cur, cur+1) {
			return true
		}
	}
}

func (g *LoadGen) dispatch(ctx context.Context, s LoadSettings) {
	route, ok := g.pickRoute()
	if !ok {
		return
	}
	now := time.Now()
	if !g.acquire(s.Concurrency) {
		g.totalShed.Add(1)
		g.record(now, true)
		return
	}
	g.totalSent.Add(1)
	g.record(now, false)
	go func() {
		defer g.inFlight.Add(-1)
		req, err := g.buildRequest(ctx, route)
		if err != nil {
			return
		}
		resp, err := g.client.Do(req)
		if err != nil {
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
}

// pickRoute chooses a route by mix weight among routes in the active config,
// falling back to a uniform pick over all active routes.
func (g *LoadGen) pickRoute() (Route, bool) {
	snap := g.store.Load()
	if snap == nil || len(snap.Config.Routes) == 0 {
		return Route{}, false
	}
	routes := snap.Config.Routes
	mix := g.current().Mix
	if len(mix) > 0 {
		byID := make(map[string]Route, len(routes))
		for _, r := range routes {
			byID[r.ID] = r
		}
		total := 0
		for _, m := range mix {
			if _, ok := byID[m.Route]; ok && m.Weight > 0 {
				total += m.Weight
			}
		}
		if total > 0 {
			n := rand.Intn(total)
			for _, m := range mix {
				if _, ok := byID[m.Route]; !ok || m.Weight <= 0 {
					continue
				}
				if n < m.Weight {
					return byID[m.Route], true
				}
				n -= m.Weight
			}
		}
	}
	return routes[rand.Intn(len(routes))], true
}

func (g *LoadGen) buildRequest(ctx context.Context, r Route) (*http.Request, error) {
	method := http.MethodGet
	if len(r.Match.Methods) > 0 {
		method = r.Match.Methods[0]
	}
	path := strings.TrimRight(r.Match.PathPrefix, "/") + "/item-" + strconv.Itoa(1+rand.Intn(1000))
	var body io.Reader
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch:
		body = strings.NewReader(`{"source":"load-generator","note":"synthetic"}`)
	}
	req, err := http.NewRequestWithContext(ctx, method, g.target+path, body)
	if err != nil {
		return nil, err
	}
	if len(r.Match.Hosts) > 0 {
		req.Host = r.Match.Hosts[0]
	}
	for k, v := range r.Match.Headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("X-Load-Generator", "dashboard")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if r.JWT != nil && r.JWT.Required && g.token != "" {
		tok := g.token
		if rand.Intn(100) < g.current().InvalidTokenPercent {
			tok = loadInvalidToken
		}
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	return req, nil
}
