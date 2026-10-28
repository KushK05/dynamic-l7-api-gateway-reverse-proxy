package main

import (
	"context"
	"flag"
	"log/slog"
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
	flag.Parse()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
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
	health := gateway.NewHealth(metrics)
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
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	stop := make(chan struct{})
	// Probe the currently active upstream set; health is deliberately ephemeral
	// and rebuilt after restart rather than persisted as stale process state.
	go health.Run(stop, configs.Store())
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
	server := gateway.NewServer(configs, keys, health, metrics, logger)
	if err = server.Run(ctx, *dataAddr, *adminAddr); err != nil {
		fatal(logger, err)
	}
	close(stop)
}

// fatal emits startup or listener errors as structured logs before terminating.
func fatal(l *slog.Logger, err error) {
	if err != nil {
		l.Error("fatal", "error", err)
		os.Exit(1)
	}
}
