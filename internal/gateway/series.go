package gateway

import "time"

// latencyBounds are the histogram upper bounds in milliseconds. A final
// implicit +Inf bucket catches everything above the last bound.
var latencyBounds = [...]float64{0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000}

const (
	histBuckets   = len(latencyBounds) + 1
	seriesSeconds = 300
)

type histogram [histBuckets]uint64

func (h *histogram) add(ms float64) {
	for i, b := range latencyBounds {
		if ms <= b {
			h[i]++
			return
		}
	}
	h[histBuckets-1]++
}

func (h *histogram) merge(o *histogram) {
	for i := range h {
		h[i] += o[i]
	}
}

// quantile estimates the q-quantile (0..1) by linear interpolation inside the
// bucket holding the rank. The +Inf bucket reports the last finite bound.
func (h *histogram) quantile(q float64) float64 {
	var total uint64
	for _, c := range h {
		total += c
	}
	if total == 0 {
		return 0
	}
	rank := q * float64(total)
	var cum float64
	for i, c := range h {
		if c == 0 {
			continue
		}
		if cum+float64(c) >= rank {
			if i == histBuckets-1 {
				return latencyBounds[len(latencyBounds)-1]
			}
			lo := 0.0
			if i > 0 {
				lo = latencyBounds[i-1]
			}
			return lo + (latencyBounds[i]-lo)*(rank-cum)/float64(c)
		}
		cum += float64(c)
	}
	return latencyBounds[len(latencyBounds)-1]
}

// secStat accumulates one entity's traffic within one second.
type secStat struct {
	req, e5, e4 uint64
	hist        histogram
}

func (s *secStat) add(status int, ms float64) {
	s.req++
	if status >= 500 {
		s.e5++
	} else if status >= 400 {
		s.e4++
	}
	s.hist.add(ms)
}

func (s *secStat) merge(o *secStat) {
	s.req += o.req
	s.e5 += o.e5
	s.e4 += o.e4
	s.hist.merge(&o.hist)
}

func (s *secStat) point(seconds float64) StatPoint {
	return StatPoint{RPS: float64(s.req) / seconds, ErrorRPS: float64(s.e5) / seconds, ClientErrorRPS: float64(s.e4) / seconds,
		P50: s.hist.quantile(.50), P95: s.hist.quantile(.95), P99: s.hist.quantile(.99)}
}

// secBucket is one slot of the ring; sec identifies which second it holds.
type secBucket struct {
	sec       int64
	total     secStat
	routes    map[string]*secStat
	upstreams map[string]*secStat
	edges     map[string]*secStat
}

func (b *secBucket) reset(sec int64) {
	*b = secBucket{sec: sec, routes: map[string]*secStat{}, upstreams: map[string]*secStat{}, edges: map[string]*secStat{}}
}

func statFor(m map[string]*secStat, key string) *secStat {
	s := m[key]
	if s == nil {
		s = &secStat{}
		m[key] = s
	}
	return s
}

// StatPoint is the per-second rate and latency view of one entity.
type StatPoint struct {
	RPS            float64 `json:"rps"`
	ErrorRPS       float64 `json:"error_rps"`        // 5xx per second
	ClientErrorRPS float64 `json:"client_error_rps"` // 4xx per second
	P50            float64 `json:"p50_ms"`
	P95            float64 `json:"p95_ms"`
	P99            float64 `json:"p99_ms"`
}

// SeriesPoint is one second (or one aggregated window) across all entities.
type SeriesPoint struct {
	TS        int64                `json:"ts"` // unix seconds
	Total     StatPoint            `json:"total"`
	Routes    map[string]StatPoint `json:"routes"`
	Upstreams map[string]StatPoint `json:"upstreams"`
	Edges     map[string]StatPoint `json:"edges"` // key: route + ">" + upstream, e.g. "catalog>v1"
}

// record adds one request to the current-second bucket. Caller holds m.mu.
func (m *Metrics) record(route, upstream string, status int, d time.Duration) {
	sec := m.now().Unix()
	b := &m.ring[sec%seriesSeconds]
	if b.sec != sec || b.routes == nil {
		b.reset(sec)
	}
	ms := float64(d) / float64(time.Millisecond)
	b.total.add(status, ms)
	if route != "" {
		statFor(b.routes, route).add(status, ms)
	}
	if upstream != "" {
		statFor(b.upstreams, upstream).add(status, ms)
	}
	if route != "" && upstream != "" {
		statFor(b.edges, route+">"+upstream).add(status, ms)
	}
}

func clampSeconds(n int) int {
	if n < 1 {
		return 1
	}
	if n > seriesSeconds {
		return seriesSeconds
	}
	return n
}

// aggregate merges the completed seconds [from, to] into point-ready stats.
// Caller holds m.mu.
func (m *Metrics) aggregate(from, to int64) (total secStat, routes, upstreams, edges map[string]*secStat) {
	routes, upstreams, edges = map[string]*secStat{}, map[string]*secStat{}, map[string]*secStat{}
	for sec := from; sec <= to; sec++ {
		b := &m.ring[sec%seriesSeconds]
		if b.sec != sec || b.routes == nil {
			continue
		}
		total.merge(&b.total)
		for k, v := range b.routes {
			statFor(routes, k).merge(v)
		}
		for k, v := range b.upstreams {
			statFor(upstreams, k).merge(v)
		}
		for k, v := range b.edges {
			statFor(edges, k).merge(v)
		}
	}
	return
}

func points(in map[string]*secStat, seconds float64) map[string]StatPoint {
	out := make(map[string]StatPoint, len(in))
	for k, v := range in {
		out[k] = v.point(seconds)
	}
	return out
}

func (m *Metrics) pointFor(from, to int64) SeriesPoint {
	total, routes, upstreams, edges := m.aggregate(from, to)
	secs := float64(to - from + 1)
	return SeriesPoint{TS: to, Total: total.point(secs), Routes: points(routes, secs), Upstreams: points(upstreams, secs), Edges: points(edges, secs)}
}

// Series returns the last N completed seconds, oldest first. Seconds with no
// traffic are zero points. N is clamped to 1..300.
func (m *Metrics) Series(seconds int) []SeriesPoint {
	seconds = clampSeconds(seconds)
	m.mu.Lock()
	defer m.mu.Unlock()
	last := m.now().Unix() - 1
	out := make([]SeriesPoint, 0, seconds)
	for sec := last - int64(seconds) + 1; sec <= last; sec++ {
		out = append(out, m.pointFor(sec, sec))
	}
	return out
}

// Window aggregates the last N completed seconds: rates are averaged per
// second and quantiles come from the merged histograms. TS is the newest second.
func (m *Metrics) Window(seconds int) SeriesPoint {
	seconds = clampSeconds(seconds)
	m.mu.Lock()
	defer m.mu.Unlock()
	last := m.now().Unix() - 1
	return m.pointFor(last-int64(seconds)+1, last)
}

// begin and end bracket an upstream proxy call for the in-flight gauges.
func (m *Metrics) begin(upstream string) {
	m.flightMu.Lock()
	m.flightTotal++
	m.flightUp[upstream]++
	m.flightMu.Unlock()
}

func (m *Metrics) end(upstream string) {
	m.flightMu.Lock()
	m.flightTotal--
	if m.flightUp[upstream]--; m.flightUp[upstream] <= 0 {
		delete(m.flightUp, upstream)
	}
	m.flightMu.Unlock()
}

// InFlight returns the current total and per-upstream in-flight counts.
func (m *Metrics) InFlight() (total int64, upstreams map[string]int64) {
	m.flightMu.Lock()
	defer m.flightMu.Unlock()
	upstreams = make(map[string]int64, len(m.flightUp))
	for k, v := range m.flightUp {
		upstreams[k] = v
	}
	return m.flightTotal, upstreams
}
