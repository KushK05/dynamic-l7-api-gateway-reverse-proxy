package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

// Config is the versioned control-plane document accepted at startup and on PUT.
type Config struct {
	Version int     `json:"version"`
	Routes  []Route `json:"routes"`
}

// Route binds match policy, request behavior, and a weighted destination pool.
type Route struct {
	ID            string     `json:"id"`
	Priority      int        `json:"priority"`
	Match         Match      `json:"match"`
	RewritePrefix string     `json:"rewrite_prefix,omitempty"`
	TimeoutMS     int        `json:"timeout_ms"`
	RetryAttempts int        `json:"retry_attempts"`
	JWT           *JWTPolicy `json:"jwt,omitempty"`
	Upstreams     []Upstream `json:"upstreams"`
}

// Match conditions are ANDed; each optional list matches any listed value.
type Match struct {
	Hosts      []string          `json:"hosts,omitempty"`
	Methods    []string          `json:"methods,omitempty"`
	PathPrefix string            `json:"path_prefix"`
	Headers    map[string]string `json:"headers,omitempty"`
}
type Upstream struct {
	ID     string `json:"id"`
	URL    string `json:"url"`
	Weight int    `json:"weight"`
}
type JWTPolicy struct {
	Required bool `json:"required"`
}

// Snapshot is immutable after construction and safe to share with request goroutines.
type Snapshot struct {
	Revision   int64 `json:"revision"`
	Config     Config
	byPriority []Route
}

// Store publishes the complete active routing snapshot with one atomic swap.
type Store struct{ active atomic.Pointer[Snapshot] }

var safeIdentifier = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

func Validate(c Config) error {
	// Validate the full document before compilation so malformed policy can never
	// be partially activated or persisted.
	if c.Version != 1 {
		return fmt.Errorf("unsupported config version %d", c.Version)
	}
	if len(c.Routes) == 0 {
		return errors.New("at least one route is required")
	}
	ids := map[string]bool{}
	priorities := map[int]bool{}
	upstreamURLs := map[string]string{}
	for _, r := range c.Routes {
		if !safeIdentifier.MatchString(r.ID) || ids[r.ID] {
			return fmt.Errorf("route IDs must be safe, non-empty, and unique: %q", r.ID)
		}
		ids[r.ID] = true
		if priorities[r.Priority] {
			return fmt.Errorf("route priority %d is ambiguous", r.Priority)
		}
		priorities[r.Priority] = true
		if r.Match.PathPrefix == "" || !strings.HasPrefix(r.Match.PathPrefix, "/") {
			return fmt.Errorf("route %s requires an absolute path_prefix", r.ID)
		}
		if r.TimeoutMS < 1 || r.TimeoutMS > 120000 {
			return fmt.Errorf("route %s timeout_ms must be 1..120000", r.ID)
		}
		if r.RetryAttempts < 0 || r.RetryAttempts > 1 {
			return fmt.Errorf("route %s retry_attempts must be 0 or 1", r.ID)
		}
		for _, m := range r.Match.Methods {
			if m == "" || m != strings.ToUpper(m) {
				return fmt.Errorf("route %s methods must be uppercase", r.ID)
			}
		}
		if r.RewritePrefix != "" && (!strings.HasPrefix(r.RewritePrefix, "/") || strings.Contains(r.RewritePrefix, "..")) {
			return fmt.Errorf("route %s has invalid rewrite_prefix", r.ID)
		}
		if r.RetryAttempts > 0 && (len(r.Match.Methods) == 0 || hasNonIdempotent(r.Match.Methods)) {
			return fmt.Errorf("route %s retries require explicitly idempotent methods", r.ID)
		}
		if len(r.Upstreams) == 0 {
			return fmt.Errorf("route %s requires an upstream", r.ID)
		}
		uids := map[string]bool{}
		sum := 0
		for _, u := range r.Upstreams {
			if !safeIdentifier.MatchString(u.ID) || uids[u.ID] {
				return fmt.Errorf("route %s upstream IDs must be safe, non-empty, and unique", r.ID)
			}
			uids[u.ID] = true
			parsed, e := url.Parse(u.URL)
			if e != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
				return fmt.Errorf("route %s upstream %s has invalid URL", r.ID, u.ID)
			}
			if previous, ok := upstreamURLs[u.ID]; ok && previous != u.URL {
				// Health state is keyed by ID, so one ID must identify one stable endpoint.
				return fmt.Errorf("upstream ID %s refers to more than one URL", u.ID)
			}
			upstreamURLs[u.ID] = u.URL
			if u.Weight < 0 || u.Weight > 100 {
				return fmt.Errorf("route %s upstream weights must be 0..100", r.ID)
			}
			sum += u.Weight
		}
		if sum != 100 {
			return fmt.Errorf("route %s upstream weights total %d, want 100", r.ID, sum)
		}
	}
	return nil
}
func hasNonIdempotent(ms []string) bool {
	// The runtime only implements retries for GET and HEAD; keep validation stricter
	// than the broader HTTP idempotency definition to match that behavior exactly.
	for _, m := range ms {
		if m != "GET" && m != "HEAD" && m != "OPTIONS" && m != "TRACE" {
			return true
		}
	}
	return false
}
func NewSnapshot(c Config, rev int64) *Snapshot {
	// Copy and sort routes once so request handling can scan in deterministic priority order.
	rs := append([]Route(nil), c.Routes...)
	sort.Slice(rs, func(i, j int) bool { return rs[i].Priority > rs[j].Priority })
	return &Snapshot{Revision: rev, Config: c, byPriority: rs}
}
func (s *Store) Load() *Snapshot              { return s.active.Load() }
func (s *Store) Activate(c Config, rev int64) { s.active.Store(NewSnapshot(c, rev)) }
func (s *Snapshot) MarshalConfig() []byte     { b, _ := json.MarshalIndent(s.Config, "", "  "); return b }
func (m Match) String() string {
	return fmt.Sprintf("%s %s", strings.Join(m.Methods, ","), m.PathPrefix)
}
func (m Match) matches(host, method, path string, headers map[string][]string) bool {
	// Every populated match dimension must pass; an empty host or method list is a wildcard.
	if len(m.Hosts) > 0 {
		ok := false
		for _, h := range m.Hosts {
			if strings.EqualFold(h, host) {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	if len(m.Methods) > 0 {
		ok := false
		for _, v := range m.Methods {
			if v == method {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	if !strings.HasPrefix(path, m.PathPrefix) || (len(path) > len(m.PathPrefix) && !strings.HasSuffix(m.PathPrefix, "/") && path[len(m.PathPrefix)] != '/') {
		// Treat prefixes as path segments, so /api/item does not match /api/items.
		return false
	}
	for k, v := range m.Headers {
		found := false
		for _, hv := range headers[strings.ToLower(k)] {
			if hv == v {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func (s *Store) String() string {
	p := s.Load()
	if p == nil {
		return "uninitialized"
	}
	return fmt.Sprintf("revision=%d routes=%d", p.Revision, len(p.Config.Routes))
}

var _ = time.Second
