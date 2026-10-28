package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"
)

// sample holds only the response details needed for aggregates, avoiding the
// memory cost of retaining every response body during a benchmark.
type sample struct {
	ms               float64
	status           int
	err              bool
	revisionMismatch bool
	upstream         string
}

// report is the stable JSON artifact consumed by the benchmark summarizer.
type report struct {
	URL                string         `json:"url"`
	TargetRPS          int            `json:"target_rps"`
	WarmupSeconds      int            `json:"warmup_seconds"`
	DurationSeconds    int            `json:"duration_seconds"`
	Requests           int64          `json:"requests"`
	Errors             int64          `json:"errors"`
	RevisionMismatches int64          `json:"revision_mismatches"`
	UpstreamCounts     map[string]int `json:"upstream_counts"`
	AchievedRPS        float64        `json:"achieved_rps"`
	P50MS              float64        `json:"p50_ms"`
	P95MS              float64        `json:"p95_ms"`
	P99MS              float64        `json:"p99_ms"`
	Status             map[int]int    `json:"status_codes"`
	Started            time.Time      `json:"started_at"`
	Finished           time.Time      `json:"finished_at"`
}

func main() {
	target := flag.String("url", "http://127.0.0.1:8080/api/catalog/items", "request URL")
	rps := flag.Int("rps", 100, "constant request rate")
	warm := flag.Int("warmup", 15, "warm-up seconds")
	duration := flag.Int("duration", 60, "measured seconds")
	token := flag.String("token", "", "optional Bearer token")
	verifyRevision := flag.Bool("verify-revision", false, "verify gateway and upstream config revisions match")
	out := flag.String("out", "", "write JSON report path")
	flag.Parse()
	// Reject nonsensical schedules before starting workers or allocating the result buffer.
	if *rps < 1 || *rps > 100000 || *warm < 0 || *duration < 1 {
		fmt.Fprintln(os.Stderr, "invalid load parameters")
		os.Exit(2)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	measure := func(seconds int, keep bool) ([]sample, time.Duration) {
		scheduleStart := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
		defer cancel()
		ticker := time.NewTicker(time.Second / time.Duration(*rps))
		defer ticker.Stop()
		var wg sync.WaitGroup
		ch := make(chan sample, *rps*seconds+*rps+1)
		for {
			select {
			case <-ctx.Done():
				// Stop scheduling at the requested boundary, then include every in-flight
				// request so the final sample count and error rate are not truncated.
				measured := time.Since(scheduleStart)
				wg.Wait()
				if !keep {
					return nil, measured
				}
				close(ch)
				v := make([]sample, 0, len(ch))
				for x := range ch {
					v = append(v, x)
				}
				return v, measured
			case <-ticker.C:
				wg.Add(1)
				go func() {
					defer wg.Done()
					start := time.Now()
					req, e := http.NewRequest(http.MethodGet, *target, nil)
					if e != nil {
						ch <- sample{err: true}
						return
					}
					req.Header.Set("X-Request-ID", fmt.Sprintf("bench-%d", start.UnixNano()))
					if *token != "" {
						req.Header.Set("Authorization", "Bearer "+*token)
					}
					resp, e := client.Do(req)
					s := sample{ms: float64(time.Since(start)) / float64(time.Millisecond)}
					if e != nil {
						s.err = true
					} else {
						s.status = resp.StatusCode
						s.upstream = resp.Header.Get("X-Upstream-ID")
						if *verifyRevision {
							// Gateway and upstream echo the revision independently; compare them
							// to catch responses assembled across different config snapshots.
							body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
							var payload map[string]any
							if readErr != nil || json.Unmarshal(body, &payload) != nil || fmt.Sprint(payload["revision"]) != resp.Header.Get("X-Config-Revision") {
								s.revisionMismatch = true
							}
						} else {
							_, _ = io.Copy(io.Discard, resp.Body)
						}
						resp.Body.Close()
						if resp.StatusCode >= 500 {
							s.err = true
						}
					}
					ch <- s
				}()
			}
		}
	}
	if *warm > 0 {
		// Warm caches and connection pools, but exclude this phase from reported samples.
		fmt.Fprintf(os.Stderr, "warm-up: %ds at %d req/s\n", *warm, *rps)
		_, _ = measure(*warm, false)
	}
	started := time.Now().UTC()
	fmt.Fprintf(os.Stderr, "measure: %ds at %d req/s\n", *duration, *rps)
	samples, measured := measure(*duration, true)
	finished := time.Now().UTC()
	var errorsN int64
	var revisionMismatches int64
	statuses := map[int]int{}
	upstreams := map[string]int{}
	times := make([]float64, 0, len(samples))
	for _, s := range samples {
		if s.err {
			errorsN++
		}
		if s.revisionMismatch {
			revisionMismatches++
		}
		if s.status != 0 {
			statuses[s.status]++
		}
		if s.upstream != "" {
			upstreams[s.upstream]++
		}
		times = append(times, s.ms)
	}
	sort.Float64s(times)
	// Use nearest-rank style indexing over the sorted request latencies.
	quant := func(q float64) float64 {
		if len(times) == 0 {
			return 0
		}
		return times[int(float64(len(times)-1)*q)]
	}
	elapsed := measured.Seconds()
	rep := report{URL: *target, TargetRPS: *rps, WarmupSeconds: *warm, DurationSeconds: *duration, Requests: int64(len(samples)), Errors: errorsN, RevisionMismatches: revisionMismatches, UpstreamCounts: upstreams, AchievedRPS: float64(len(samples)) / elapsed, P50MS: quant(.50), P95MS: quant(.95), P99MS: quant(.99), Status: statuses, Started: started, Finished: finished}
	b, _ := json.MarshalIndent(rep, "", "  ")
	fmt.Println(string(b))
	if *out != "" {
		// Create a new report file with owner-only permissions.
		if e := os.WriteFile(*out, b, 0600); e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
	}
}
