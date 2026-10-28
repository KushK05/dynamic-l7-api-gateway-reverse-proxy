package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	base := flag.String("upstream", "http://127.0.0.1:9102", "upstream base URL reachable from this process")
	delay := flag.Int("delay-ms", 0, "inject response delay")
	status := flag.Int("status", 0, "inject response status")
	unhealthy := flag.Bool("unhealthy", false, "fail health probes")
	rate := flag.Int("error-rate", 0, "percentage of responses to fail")
	reset := flag.Bool("reset", false, "clear faults")
	flag.Parse()
	// Keep injected delays and response codes within safe demo bounds so a typo
	// cannot leave the mock upstream effectively unusable.
	if *delay < 0 || *delay > 30000 || *rate < 0 || *rate > 100 || (*status != 0 && (*status < 400 || *status > 599)) {
		fmt.Fprintln(os.Stderr, "invalid fault settings")
		os.Exit(2)
	}
	path := "/admin/fault"
	payload := map[string]any{"delay_ms": *delay, "status": *status, "unhealthy": *unhealthy, "error_rate_percent": *rate}
	if *reset {
		// Reset uses a dedicated endpoint so a fault-free state is explicit.
		path = "/admin/reset"
		payload = nil
	}
	b, _ := json.Marshal(payload)
	req, e := http.NewRequest(http.MethodPost, strings.TrimRight(*base, "/")+path, bytes.NewReader(b))
	if e != nil {
		fatal(e)
	}
	req.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 5 * time.Second}
	resp, e := client.Do(req)
	if e != nil {
		fatal(e)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		fatal(fmt.Errorf("upstream fault endpoint returned %s", resp.Status))
	}
	fmt.Printf("fault update accepted: %s\n", resp.Status)
}

// fatal reports CLI or transport errors consistently and exits nonzero for scripts.
func fatal(e error) { fmt.Fprintln(os.Stderr, e); os.Exit(1) }
