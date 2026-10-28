package gateway

import (
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Metrics protects counters and a bounded latency sample shared by handlers.
type Metrics struct {
	mu                                       sync.Mutex
	requests                                 map[int64]uint64
	jwtRejected, retries, ejections, reloads uint64
	latency                                  []float64
	status                                   map[string]uint64
	bytesIn, bytesOut                        uint64
	started                                  time.Time
}

func NewMetrics() *Metrics {
	return &Metrics{requests: map[int64]uint64{}, status: map[string]uint64{}, started: time.Now()}
}
func (m *Metrics) observe(rev int64, status int, d time.Duration, bytesIn, bytesOut uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests[rev]++
	m.status[fmt.Sprint(status/100, "xx")]++
	m.bytesIn += bytesIn
	m.bytesOut += bytesOut
	m.latency = append(m.latency, float64(d)/float64(time.Millisecond))
	if len(m.latency) > 10000 {
		// Keep memory bounded by discarding the older half once the sample fills.
		m.latency = m.latency[len(m.latency)-5000:]
	}
}
func (m *Metrics) inc(which string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch which {
	case "jwt":
		m.jwtRejected++
	case "retry":
		m.retries++
	case "ejection":
		m.ejections++
	case "reload":
		m.reloads++
	}
}
func (m *Metrics) snapshot() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	lat := append([]float64(nil), m.latency...)
	sort.Float64s(lat)
	quant := func(q float64) float64 {
		if len(lat) == 0 {
			return 0
		}
		return lat[int(float64(len(lat)-1)*q)]
	}
	revisions := map[int64]uint64{}
	var total uint64
	for k, v := range m.requests {
		revisions[k] = v
		total += v
	}
	status := map[string]uint64{}
	for k, v := range m.status {
		status[k] = v
	}
	return map[string]any{"requests_total": total, "requests_by_revision": revisions, "status_classes": status, "bytes_received_total": m.bytesIn, "bytes_sent_total": m.bytesOut, "jwt_rejections": m.jwtRejected, "retries": m.retries, "ejections": m.ejections, "reloads": m.reloads, "latency_ms": map[string]float64{"p50": quant(.50), "p95": quant(.95), "p99": quant(.99)}, "uptime_seconds": int(time.Since(m.started).Seconds())}
}
func (m *Metrics) prom(w http.ResponseWriter) {
	// Render a small Prometheus text exposition directly to avoid a runtime dependency.
	m.mu.Lock()
	defer m.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	var total uint64
	for _, v := range m.requests {
		total += v
	}
	fmt.Fprintf(w, "gateway_requests_total %d\n", total)
	fmt.Fprintf(w, "gateway_bytes_received_total %d\n", m.bytesIn)
	fmt.Fprintf(w, "gateway_bytes_sent_total %d\n", m.bytesOut)
	fmt.Fprintf(w, "gateway_jwt_rejections_total %d\n", m.jwtRejected)
	fmt.Fprintf(w, "gateway_retries_total %d\n", m.retries)
	fmt.Fprintf(w, "gateway_upstream_ejections_total %d\n", m.ejections)
	fmt.Fprintf(w, "gateway_config_reloads_total %d\n", m.reloads)
	for k, v := range m.status {
		fmt.Fprintf(w, "gateway_responses_by_status_class_total{status_class=\"%s\"} %d\n", k, v)
	}
}
