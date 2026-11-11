package main

import (
	"context"
	"flag"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"dynamic-l7-gateway/internal/gateway"
)

func main() {
	configPath := flag.String("config", "/etc/gateway/config.json", "initial route configuration")
	dataAddr := flag.String("data-addr", ":8080", "public data-plane listen address")
	adminAddr := flag.String("admin-addr", ":9090", "private admin-plane listen address")
	statePath := flag.String("state", "/data/config.json", "durable active configuration path")
	loadMaxRPS := flag.Int("load-max-rps", 3000, "maximum requests per second the built-in load generator may produce")
	knownFlag := flag.String("known-upstreams", os.Getenv("KNOWN_UPSTREAMS"), "extra fault-eligible upstreams as id=url,id=url")
	flag.Parse()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	known, err := gateway.ParseKnownUpstreams(*knownFlag)
	fatal(logger, err)
	// Validate the shipped bootstrap config even when durable state already exists;
	// this catches a broken deployment artifact before either listener starts.
	initial, err := gateway.LoadConfig(*configPath)
	fatal(logger, err)
	if err = gateway.Validate(initial); err != nil {
		fatal(logger, err)
	}
	configs, err := gateway.OpenConfigStore(*statePath, initial)
	fatal(logger, err)
	metrics := gateway.NewMetrics()
	events := gateway.NewEventLog(500)
	health := gateway.NewHealth(metrics)
	health.SetEvents(events)
	weigher := gateway.NewAutoWeigher(configs.Store(), metrics, health, events)
	keys := gateway.NewKeyManager(os.Getenv("JWT_SECRET_ARN"), 5*time.Minute)
	if os.Getenv("JWT_SECRET_ARN") != "" || os.Getenv("JWT_KEYS_JSON") != "" {
		// Bound startup retrieval so an unavailable secret service cannot hang boot.
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err = keys.Refresh(ctx)
		cancel()
		if err != nil {
			logger.Error("JWT key load failed; last-known-good unavailable", "error", err)
		}
	}
	loadgen := gateway.NewLoadGen(loadTarget(*dataAddr), configs.Store(), events, *loadMaxRPS, os.Getenv("LOADGEN_BEARER_TOKEN"))
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	stop := make(chan struct{})
	// Probe the currently active upstream set; health is deliberately ephemeral
	// and rebuilt after restart rather than persisted as stale process state.
	go health.Run(stop, configs.Store())
	go weigher.Run(stop, 2*time.Second)
	go loadgen.Run(ctx)
	if os.Getenv("JWT_SECRET_ARN") != "" || os.Getenv("JWT_KEYS_JSON") != "" {
		go func() {
			// The manager enforces the five-minute cache TTL; the shorter tick lets
			// refresh happen soon after expiry without blocking request handlers.
			t := time.NewTicker(30 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					refreshCtx, done := context.WithTimeout(ctx, 15*time.Second)
					e := keys.RefreshIfExpired(refreshCtx)
					done()
					if e != nil {
						logger.Error("JWT key refresh failed; retaining current set", "error", e)
					}
				}
			}
		}()
	}
	server := gateway.NewServer(gateway.ServerDeps{Configs: configs, Keys: keys, Health: health, Metrics: metrics, Events: events, Weights: weigher, Load: loadgen, Logger: logger, KnownUpstreams: known})
	if err = server.Run(ctx, *dataAddr, *adminAddr); err != nil {
		fatal(logger, err)
	}
	close(stop)
}

// loadTarget turns the data listen address into a URL the in-process load
// generator can reach: unspecified hosts become loopback.
func loadTarget(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://127.0.0.1:8080"
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// fatal emits startup or listener errors as structured logs before terminating.
func fatal(l *slog.Logger, err error) {
	if err != nil {
		l.Error("fatal", "error", err)
		os.Exit(1)
	}
}
