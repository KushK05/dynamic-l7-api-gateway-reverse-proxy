# Demo Control Dashboard - Implementation Plan

Spec: this document is the spec (no separate spec file). The user request it argues from:
"More detailed dashboard with controls, visualization, stats. The project has to be demoed,
so visuals matter. A bigger EC2 instance will be used so we can create more routes and show
proper routing. A visualization like breakscale (https://github.com/workersio/breakscale)
showing amount of traffic, latency and other stats. Add features to change the configuration:
add routes, change weights, auto weight."

## Goal

Turn the admin dashboard into a projector-ready "mission control" for the gateway:

1. A live, animated topology (clients -> gateway -> routes -> upstreams) in the spirit of
   breakscale: particles flow along edges at a rate proportional to real traffic, nodes show
   rps / latency / health, and the system visibly "goes red" when it starts to break.
2. A built-in traffic generator with a slider ("drag the traffic up until it breaks").
3. Live charts: throughput by status class, latency percentiles, per-upstream share, error rate.
4. Full configuration control: add / edit / delete routes, change upstream weights with
   linked sliders, progressive canary, and an auto-weight mode that adapts weights from
   observed latency and errors.
5. Fault injection on any upstream from the UI (latency, error rate, failing health checks).
6. A live event feed (reloads, ejections, recoveries, faults, traffic and weight changes).
7. A richer demo deployment (more upstream services and routes) sized for a larger EC2 instance,
   plus a written demo run sheet.

## Architecture

```text
Browser (dashboard, vanilla ES modules embedded in the gateway binary)
   |  EventSource /admin/v1/stream (1 frame / second)   REST: config, load, faults
   v
Admin plane :9090 (loopback only, SSH tunnel)
   |-- Metrics: existing counters + NEW per-second ring buffer (300 s) by route and upstream
   |-- EventLog: NEW ring buffer of operational events
   |-- AutoWeigher: NEW runtime overlay of effective weights for routes with auto_weight=true
   |-- LoadGen: NEW in-process traffic generator targeting the gateway's own data plane
   |-- Fault proxy: NEW forwards fault/reset to upstream /admin/fault (config/known IDs only)
Data plane :8080 -> Proxy (pick() consults AutoWeigher) -> upstream containers
```

## Global Constraints

- Go standard library only. No new Go modules. `go.mod` stays at `go 1.23`; Go 1.22+ `ServeMux`
  method and wildcard patterns (for example `"POST /admin/v1/upstreams/{id}/fault"`) are allowed.
- Frontend: no build step, no npm, no CDN, no web fonts, no external network requests. Plain
  HTML + CSS + vanilla JavaScript ES modules under `internal/gateway/web/`, embedded into the
  gateway binary with `go:embed`. Served with a Content-Security-Policy of
  `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'`
  (no inline scripts, no inline `<style>` blocks; setting `element.style` from JS is fine).
- Admin plane stays loopback-only (unchanged Compose binding). No new data-plane endpoints.
  The load generator only sends to the gateway's own data plane address.
- Backward compatibility: existing endpoints and JSON fields of `GET /admin/v1/status`,
  `GET|PUT /admin/v1/config`, `POST /admin/v1/secrets/refresh`, `/metrics`, `/healthz`,
  `/readyz` keep their current shape. `GET /dashboard` (no trailing slash, no redirect) must
  return HTML containing the text `Dynamic L7 Gateway` (checked by `scripts/review-smoke.sh`).
- Config remains the single source of truth. Every UI configuration change goes through
  `PUT /admin/v1/config` with `If-Match` (validated, fsynced, atomic). Auto-weight's
  effective weights are an in-memory runtime overlay and never create config revisions.
- Mutating admin endpoints (`PUT /admin/v1/config`, `PUT /admin/v1/load`,
  `POST /admin/v1/upstreams/{id}/fault`, `POST /admin/v1/upstreams/{id}/reset`) require
  `Content-Type: application/json` (media type match, parameters such as charset allowed) and
  return `415` otherwise. This blocks cross-site "simple request" CSRF against the loopback port.
- Fault forwarding only targets upstream IDs present in the active config or the
  known-upstreams list. Never a caller-supplied URL.
- Visual bar: legible on a projector at 1920x1080 and on a 1366x768 laptop; no horizontal page
  scroll at widths >= 1024px; stacks to one column below 900px. Minimum body text 14px. Numbers
  use `font-variant-numeric: tabular-nums`. Honors `prefers-reduced-motion` (particles and
  pulses reduced to static indicators). Dark theme is the primary theme.
- Writing rule: never use the em dash character (U+2014) anywhere (code, comments, docs, UI
  copy, commit messages). Use a plain hyphen.
- Do not edit `CHANGELOG.md` or generated files. Commit messages carry no co-author line.
- Keep `go vet ./...`, `gofmt -l .` (empty output), and `go test ./...` green after every task.
  New Go code has unit tests. Frontend modules are verified by `node --check` on every `.js`
  file and by the browser QA task.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `cmd/upstream/main.go`, `cmd/upstream/main_test.go` | Mock upstream with per-service latency profile and fault read-back | 1 |
| `internal/gateway/series.go`, `series_test.go` | Per-second ring buffer, latency histograms, windows | 2 |
| `internal/gateway/metrics.go`, `proxy.go` | Record route/upstream per request, in-flight gauges | 2 |
| `internal/gateway/events.go`, `events_test.go` | Operational event ring buffer | 3 |
| `internal/gateway/autoweight.go`, `autoweight_test.go` | Adaptive effective weights | 3 |
| `internal/gateway/types.go`, `health.go` | `auto_weight` route field, health transition events | 3 |
| `internal/gateway/loadgen.go`, `loadgen_test.go` | In-process traffic generator | 4 |
| `internal/gateway/admin.go`, `admin_test.go` | New admin endpoints, SSE stream, fault proxy | 5 |
| `internal/gateway/server.go`, `cmd/gateway/main.go` | Wiring, `ServerDeps`, flags | 3, 4, 5 |
| `internal/gateway/webui.go` | `go:embed` + static serving + CSP | 6 |
| `internal/gateway/web/index.html`, `web/app.css` | Page shell, layout, design tokens | 6 |
| `internal/gateway/web/js/main.js` | Boot, wiring modules together | 6 |
| `internal/gateway/web/js/api.js` | REST helpers | 6 |
| `internal/gateway/web/js/store.js` | SSE client, history, pub/sub | 6 |
| `internal/gateway/web/js/format.js`, `ui.js` | Number formatting, toast, modal, popover | 6 |
| `internal/gateway/web/js/charts.js` | Canvas time-series chart + sparkline | 6 |
| `internal/gateway/web/js/topology.js` | Animated topology | 7 |
| `internal/gateway/web/js/routes.js`, `routeform.js` | Route list, weights, canary, add/edit/delete, JSON editor | 8 |
| `internal/gateway/web/js/traffic.js`, `events.js`, `scenarios.js` | Traffic panel, event feed, scenario buttons | 9 |
| `config/demo.json`, `docker-compose.yml`, `deployment/cloudformation.yaml`, `README.md`, `docs/DEMO-SCRIPT.md`, `docs/REVIEW-GUIDE.md`, `scripts/review-smoke.sh` | Demo topology and docs | 10 |

---

## Task 1: Realistic mock upstreams

**Files:** `cmd/upstream/main.go`, create `cmd/upstream/main_test.go`.

Make each upstream container behave like a distinct service so routing and latency differences
are visible on the dashboard.

Requirements:
- Refactor so the HTTP handler is built by a testable function, for example
  `func newHandler(id, service string, p profile, f *fault, rnd func(int) int) http.Handler`
  (exact shape is the implementer's choice). `main()` only reads env and listens.
- New env vars: `SERVICE` (default `demo`), `BASE_DELAY_MS` (default `0`, 0..10000),
  `JITTER_MS` (default `0`, 0..10000). Invalid values fail fast at startup with `log.Fatal`.
- Every proxied request (the `/` handler) sleeps `base + uniform[0, jitter) + injected delay`.
- Replace `time.Now().UnixNano()%100` error sampling with `math/rand/v2` (injectable for tests).
- `GET /admin/fault` returns the current fault state as JSON:
  `{"delay_ms":int,"status":int,"unhealthy":bool,"error_rate_percent":int}`. `POST /admin/fault`
  and `POST /admin/reset` keep current behavior. `/admin/reset` must reject non-POST with 405.
- Response JSON gains `"service": <SERVICE>`; keep all existing fields and headers.
- Tests (httptest, no sleeps longer than ~50ms): fault GET round-trip after POST; reset clears;
  error rate 100 always fails, 0 never fails; base delay is applied (use a small value);
  invalid fault payload returns 400; non-POST reset returns 405.

## Task 2: Per-second metrics time series

**Files:** create `internal/gateway/series.go`, `internal/gateway/series_test.go`; modify
`internal/gateway/metrics.go`, `internal/gateway/proxy.go`, `internal/gateway/proxy_test.go`.

Requirements:
- Latency histogram with fixed upper bounds in ms:
  `0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, +Inf`.
  Quantile estimate = linear interpolation inside the bucket containing the rank (lower bound of
  the first bucket is 0; for the `+Inf` bucket return 10000).
- A ring of 300 one-second buckets keyed by unix second. Each bucket holds a stat for the total,
  per route ID, per upstream ID, and per route>upstream edge: request count, 5xx count, 4xx
  count, histogram.
  Requests with no matched route count only in the total. Requests with no chosen upstream
  (404, 401, 503 "no healthy upstream") count in total and route but not upstream.
- `Metrics` gains an injectable clock (`now func() time.Time`, defaulting to `time.Now`) so
  tests can drive seconds deterministically.
- Change `observe` to `observe(rev int64, route, upstream string, status int, d time.Duration, bytesIn, bytesOut uint64)`
  and update every call site in `proxy.go`. The upstream recorded must be the one that actually
  served the request: when `retryTransport` retries onto a different upstream, record the retry
  target (carry it back to `ServeHTTP`, for example via a field the transport sets).
- In-flight gauges: `Metrics.begin(upstream string)` / `Metrics.end(upstream string)` around the
  upstream proxy call; track a total and per-upstream count (atomic or mutex-protected).
- Exported read API (JSON tags exactly as shown):
  ```go
  type StatPoint struct {
      RPS            float64 `json:"rps"`
      ErrorRPS       float64 `json:"error_rps"`        // 5xx per second
      ClientErrorRPS float64 `json:"client_error_rps"` // 4xx per second
      P50            float64 `json:"p50_ms"`
      P95            float64 `json:"p95_ms"`
      P99            float64 `json:"p99_ms"`
  }
  type SeriesPoint struct {
      TS        int64                `json:"ts"` // unix seconds
      Total     StatPoint            `json:"total"`
      Routes    map[string]StatPoint `json:"routes"`
      Upstreams map[string]StatPoint `json:"upstreams"`
      Edges     map[string]StatPoint `json:"edges"` // key: route + ">" + upstream, e.g. "catalog>v1"
  }
  func (m *Metrics) Series(seconds int) []SeriesPoint // last N COMPLETED seconds, oldest first, missing seconds as zero points; N clamped to 1..300
  func (m *Metrics) Window(seconds int) SeriesPoint   // aggregate of the last N completed seconds: rates averaged per second, quantiles from merged histograms; TS = newest second
  func (m *Metrics) InFlight() (total int64, upstreams map[string]int64)
  ```
  "Completed" means seconds strictly before the current clock second. Maps are never nil in
  output (use empty maps).
- Existing `snapshot()` keys and `prom()` output remain unchanged in shape.
- Tests: quantile interpolation; series gap filling and ordering; 300-second wraparound evicts
  old data; window aggregation; route/upstream attribution through `Proxy.ServeHTTP` against an
  httptest upstream (including a 404 with route "" and a retry recorded on the retry target);
  in-flight returns to 0 after requests. Run `go test -race ./internal/gateway/` once.

## Task 3: Event log and auto-weight

**Files:** create `internal/gateway/events.go`, `events_test.go`, `autoweight.go`,
`autoweight_test.go`; modify `types.go`, `types_test.go`, `health.go`, `proxy.go`,
`server.go`, `cmd/gateway/main.go`.

### Event log
```go
type Event struct {
    Seq      uint64    `json:"seq"`
    Time     time.Time `json:"time"`
    Kind     string    `json:"kind"`  // "config" | "health" | "fault" | "load" | "weights" | "secrets"
    Level    string    `json:"level"` // "info" | "success" | "warn" | "error"
    Message  string    `json:"message"`
    Route    string    `json:"route,omitempty"`
    Upstream string    `json:"upstream,omitempty"`
}
func NewEventLog(capacity int) *EventLog
func (l *EventLog) Add(e Event) Event           // assigns Seq (starting at 1, monotonic) and Time (UTC) if zero
func (l *EventLog) Since(seq uint64) []Event     // events with Seq > seq, oldest first
func (l *EventLog) Recent(n int) []Event         // newest n, oldest first
```
Nil-receiver safe (`(*EventLog)(nil).Add(...)` is a no-op) so components work without one.
Capacity 500 in production.

Emitters wired in this task:
- `Health`: add `func (h *Health) SetEvents(e *EventLog)`. Emit `health`/`error` on ejection
  ("Upstream v2 ejected after 2 failed probes") and `health`/`success` on recovery
  ("Upstream v2 recovered"). Only on state transitions, never per probe. Do not change
  `NewHealth`'s signature.
- Config PUT handler: `config`/`success` on applied revision ("Config revision 7 applied: 5
  routes"), `config`/`warn` on rejection with the error text.
- Secrets refresh handler: `secrets`/`success` or `secrets`/`error`.

### `auto_weight` route field
- `Route` gains `AutoWeight bool `json:"auto_weight,omitempty"``. Validation is unchanged
  (configured weights still must total 100; they are the baseline and fallback).
  Add a `types_test.go` case proving a config with `auto_weight: true` round-trips through JSON
  and validates.

### AutoWeigher
```go
func NewAutoWeigher(s *Store, m *Metrics, h *Health, e *EventLog) *AutoWeigher
func (a *AutoWeigher) Run(stop <-chan struct{}, interval time.Duration) // production interval 2s
func (a *AutoWeigher) Effective(r Route) []Upstream                     // copy of r.Upstreams with effective weights
func (a *AutoWeigher) Weights() map[string]map[string]int               // route ID -> upstream ID -> effective weight, for every route in the active config
```
Nil-receiver safe: a nil `*AutoWeigher` returns configured weights.

Algorithm per tick, for each route with `AutoWeight` true (other routes: effective = configured):
- Window `w := metrics.Window(10).Upstreams`.
- For each upstream in the route: if `!health.Allowed(id)` score = 0. Else if
  `w[id].RPS < 0.5` (not enough data) score = neutral, where neutral is the mean score of
  upstreams that do have data, or 1 if none do. Else
  `errRatio = ErrorRPS / RPS` and `score = (1 - errRatio)^2 / max(P95, 1)`.
- Target weight = score / sum(scores) * 100. Every upstream with score > 0 gets at least 5
  (when 2 or more have score > 0) so it keeps receiving traffic and can recover.
- Smooth: `new = 0.5*previous + 0.5*target` (previous = last effective, or configured on first
  tick), then round with the largest-remainder method so the integers total exactly 100.
- If every score is 0, effective = configured (the proxy then returns 503 as today).
- Emit `weights`/`info` ("Auto-weight catalog: v1 62, v2 38") when any upstream's weight moved
  by 5 or more since the last emitted event for that route.
- When the active config revision changes, drop state for routes that no longer exist or whose
  upstream set changed.
- Concurrency: `Effective` is on the request hot path; use an `atomic.Pointer` to an immutable
  map (recomputed each tick), not a mutex held across requests.

### Proxy integration
- `Proxy` gains a `weights *AutoWeigher` field (set by `Server.Run`). `pick` and `pickDifferent`
  use `p.weights.Effective(route)`; in auto mode an upstream whose configured weight is 0 is
  eligible if its effective weight > 0.

### Server wiring
- Replace `NewServer(c, k, h, m, l)` with
  ```go
  type ServerDeps struct {
      Configs *ConfigStore
      Keys    *KeyManager
      Health  *Health
      Metrics *Metrics
      Events  *EventLog
      Weights *AutoWeigher
      Logger  *slog.Logger
  }
  func NewServer(d ServerDeps) *Server
  ```
  Later tasks add fields to `ServerDeps`. Update `cmd/gateway/main.go`: create the event log
  (capacity 500), call `health.SetEvents`, create the weigher and `go weigher.Run(stop, 2*time.Second)`.
- `GET /admin/v1/status` keeps its existing fields and adds `"weights": weigher.Weights()`.

Tests: event seq/ring eviction/Since/Recent and nil safety; health emits exactly one event per
transition; weigher shifts weight toward the faster upstream given synthetic metrics (drive
`Metrics` with an injected clock and `observe` calls), gives 0 to an unhealthy upstream, respects
the 5 floor, totals 100, leaves non-auto routes alone; proxy routes to a configured-0 upstream
when auto weight makes it positive.

## Task 4: In-process load generator

**Files:** create `internal/gateway/loadgen.go`, `loadgen_test.go`; modify `server.go`
(`ServerDeps.Load *LoadGen`), `cmd/gateway/main.go`.

```go
type LoadMix struct {
    Route  string `json:"route"`
    Weight int    `json:"weight"` // 0..100
}
type LoadSettings struct {
    RPS                 int       `json:"rps"`                   // 0..maxRPS; 0 = stopped
    Concurrency         int       `json:"concurrency"`           // 1..1024, default 256
    Mix                 []LoadMix `json:"mix,omitempty"`         // empty = every active route equally
    InvalidTokenPercent int       `json:"invalid_token_percent"` // 0..100, default 10
}
type LoadStatus struct {
    Settings    LoadSettings `json:"settings"`
    MaxRPS      int          `json:"max_rps"`
    HasToken    bool         `json:"has_token"`
    SentPerSec  float64      `json:"sent_per_sec"` // over the last completed second
    ShedPerSec  float64      `json:"shed_per_sec"`
    InFlight    int64        `json:"in_flight"`
    TotalSent   uint64       `json:"total_sent"`
    TotalShed   uint64       `json:"total_shed"`
}
func NewLoadGen(target string, s *Store, e *EventLog, maxRPS int, token string) *LoadGen
func (g *LoadGen) Apply(s LoadSettings) (LoadSettings, error) // validates, applies, returns normalized
func (g *LoadGen) Status() LoadStatus
func (g *LoadGen) Run(ctx context.Context)
```

Requirements:
- Pacing: a 10ms ticker with a fractional accumulator so N rps is accurate at low rates
  (e.g. 3 rps) and high rates. Each request takes a slot from a semaphore sized
  `Concurrency`; if no slot is free the request is shed (counted, not sent). Changing
  `Concurrency` takes effect without restarting `Run`.
- Request synthesis from the active snapshot's route chosen by the mix: method = first entry of
  `Match.Methods` (or `GET` when empty); path = `PathPrefix` joined with `/item-<n>` (avoid a
  double slash; `n` random 1..1000); `Host` = first `Match.Hosts` entry when present; headers =
  `Match.Headers`; header `X-Load-Generator: dashboard`; POST/PUT/PATCH send a small JSON body
  with `Content-Type: application/json`. Mix entries for route IDs not in the active config are
  ignored (validation rejects unknown IDs only at Apply time against the current config).
- JWT routes: if a token is configured (env `LOADGEN_BEARER_TOKEN`), send
  `Authorization: Bearer <token>` except for `InvalidTokenPercent` of requests which send
  `Bearer invalid.token.value`. Without a token, JWT routes get no Authorization header (they
  produce 401s, which the dashboard shows as rejections).
- HTTP client: dedicated `http.Transport` with `MaxIdleConnsPerHost` = 1024, request timeout
  10s, response bodies drained and closed.
- Events: `load`/`info` when settings change ("Traffic generator set to 800 rps",
  "Traffic generator stopped").
- `main.go`: flags `-load-max-rps` (default 3000) and target derived from `-data-addr`
  (`":8080"` -> `"http://127.0.0.1:8080"`; a host part is kept, unspecified hosts become
  127.0.0.1). `go loadgen.Run(ctx)`. Token from env `LOADGEN_BEARER_TOKEN`.
- Tests against an httptest server: ~100 rps for 1s lands within +-25%; low rate (5 rps over
  1s) sends 4..6; concurrency 1 against a handler that blocks sheds requests; validation errors
  (negative rps, rps > max, concurrency 0, unknown route in mix, mix weight > 100); request
  synthesis (method, path joining, host, headers, auth header with and without token).
  Keep total test time for this file under ~5s.

## Task 5: Admin API for the dashboard

**Files:** create `internal/gateway/admin.go`, `admin_test.go`; modify `server.go`,
`cmd/gateway/main.go`.

`ServerDeps` gains `KnownUpstreams []Upstream`. Add
`func ParseKnownUpstreams(s string) ([]Upstream, error)` parsing
`"id=url,id=url"` (whitespace tolerant, empty string -> empty list), validating IDs with
`safeIdentifier` and URLs with the same rules as `Validate`. `main.go` flag
`-known-upstreams` defaulting to env `KNOWN_UPSTREAMS`.

Endpoints (all on the admin mux):
- `GET /admin/v1/series?seconds=N` -> `{"points":[SeriesPoint...]}`; N default 120, clamp 1..300,
  non-integer -> 400.
- `GET /admin/v1/events?since=SEQ` -> `{"events":[Event...]}` (since default 0 returns Recent(100)).
- `GET /admin/v1/load` -> `LoadStatus`; `PUT /admin/v1/load` with `LoadSettings` JSON
  (DisallowUnknownFields, 4 KiB cap) -> normalized `LoadStatus` or 400 with `{"error":...}`.
- `GET /admin/v1/upstreams` -> `{"upstreams":[{"id","url","in_config":bool,"known":bool,"health":upstreamHealth|null,"fault":{...}|null}]}`
  sorted by ID. `fault` is fetched from `GET <url>/admin/fault` in parallel with a 300ms timeout
  per upstream; failures yield `null`.
- `POST /admin/v1/upstreams/{id}/fault` with body
  `{"delay_ms":0..30000,"status":0|400..599,"unhealthy":bool,"error_rate_percent":0..100}`
  forwards to `<url>/admin/fault`; `POST /admin/v1/upstreams/{id}/reset` forwards to
  `<url>/admin/reset`. Unknown ID -> 404. Upstream failure -> 502 with error. Success -> 200
  `{"status":"applied"}` and an event (`fault`/`warn` "Injected 800 ms latency into v2",
  `fault`/`success` "Faults cleared on v2"). 5s client timeout.
- `GET /admin/v1/stream` (Server-Sent Events): headers `Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `X-Accel-Buffering: no`. On connect send one `event: hello` with
  `{"series":Series(120),"events":Recent(50)}`. Then every 1s send `event: frame` with:
  ```json
  {
    "ts": 0, "revision": 0, "secret_revision": "",
    "point": SeriesPoint,            // Series(1)[0], the last completed second
    "window": SeriesPoint,           // Window(5)
    "inflight": {"total": 0, "upstreams": {}},
    "health": {"<id>": upstreamHealth},
    "weights": {"<route>": {"<upstream>": 0}},
    "load": LoadStatus,
    "events": [Event],               // events with Seq greater than the last one sent on this connection
    "totals": {}                     // the existing metrics.snapshot() map
  }
  ```
  Also send a `: ping` comment line if a frame is skipped. Stop cleanly when the request
  context ends. The per-connection ticker must not leak goroutines. The admin `http.Server`
  has no `WriteTimeout` today; keep it that way so streams stay open.
- Content-Type enforcement (see Global Constraints) on PUT config, PUT load, POST fault/reset.
  Use `mime.ParseMediaType`.
- Move the new handlers into `admin.go`; `server.go` keeps listener setup and the existing
  handlers.

Tests (httptest against the admin mux, built through a helper that constructs a full `Server`
with fake upstream httptest servers): series clamp and 400; events since; load GET/PUT incl.
415 and 400; upstreams listing with fault read-back and an unreachable upstream (`fault:null`);
fault forward success, unknown ID 404, upstream down 502, invalid body 400; reset; SSE receives
`hello` then at least one `frame` with the required keys within ~2.5s and the handler returns
after the client cancels; PUT config without JSON content type -> 415 while existing behaviors
(428, 400, 412, 200) still pass.

## Task 6: Dashboard foundation (shell, data layer, KPIs, charts)

**Files:** create `internal/gateway/webui.go`, `internal/gateway/webui_test.go`,
`internal/gateway/web/index.html`, `web/app.css`, `web/js/main.js`, `web/js/api.js`,
`web/js/store.js`, `web/js/format.js`, `web/js/ui.js`, `web/js/charts.js`; modify `server.go`
(remove the inline `dashboard` template and its handler).

Serving:
- `//go:embed web` in `webui.go`. `GET /dashboard` and `GET /dashboard/` serve `index.html`
  directly (no redirect). `GET /dashboard/<asset>` serves the embedded file with correct
  content type. Headers on every dashboard response: the CSP from Global Constraints,
  `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- Asset URLs in `index.html` are absolute (`/dashboard/app.css`, `/dashboard/js/main.js`,
  `type="module"`).
- `webui_test.go`: `/dashboard` 200 HTML containing `Dynamic L7 Gateway` and the CSP header;
  `/dashboard/` same; `/dashboard/js/main.js` served as JavaScript; missing asset 404.

Page layout (`index.html`, ids are the contract other tasks fill):
- Top bar: product name `Dynamic L7 Gateway`, subtitle, connection pill `#conn` (LIVE /
  RECONNECTING / OFFLINE), chips `#chip-rev` (config revision), `#chip-secret`, `#chip-uptime`.
- KPI strip `#kpis`: Throughput (rps, with sparkline), Success rate (%), Latency p50 / p95 / p99
  (ms), Errors (5xx/s), In-flight, JWT rejections (total), Shed by generator (/s). Each KPI
  turns amber/red past thresholds (success < 99% amber, < 95% red; p99 > 250ms amber,
  > 1000ms red).
- Main grid: `#topology` (large panel, left, about 2/3 width, min height 520px),
  right column with `#traffic` (traffic control panel) above `#events` (event feed).
  Task 6 renders these three as titled empty panels with a placeholder line.
- Charts row: four chart cards `#chart-throughput` (stacked area: 2xx-3xx rps, 4xx rps, 5xx rps),
  `#chart-latency` (p50, p95, p99 lines), `#chart-upstreams` (per-upstream rps, stacked area,
  one color per upstream ID), `#chart-errors` (error % = 5xx / total and 4xx %).
- `#routes` full-width panel at the bottom (Task 8 fills it).
- Design tokens on `:root` (dark mission-control theme): background, panel, line, text, muted,
  accent (cyan), ok (green), warn (amber), err (red), info (violet), plus an 8-color categorical
  palette `--c1`..`--c8` used for upstream series everywhere (topology, charts, route editor)
  via `format.js` `colorFor(upstreamId)` that assigns colors stably by first-seen order.

Modules:
- `api.js`: `getConfig() -> {revision, config}`, `putConfig(config, revision)` (throws an
  `ApiError` with `status` and server `error` text; 412 is distinguishable), `getLoad()`,
  `putLoad(settings)`, `getUpstreams()`, `injectFault(id, body)`, `resetFault(id)`,
  `getSeries(seconds)`. All JSON with `Content-Type: application/json` on writes.
- `store.js`: connects `EventSource('/admin/v1/stream')`, auto-reconnect with backoff, keeps
  the last 300 points (seeded from `hello`), the latest frame, events (bounded 500), and the
  active config (fetched via `getConfig()` at start and whenever `frame.revision` changes).
  API: `subscribe(fn)` -> unsubscribe; callbacks receive `{type: 'frame'|'config'|'events'|'conn', state}`;
  `getState()` returns `{conn, frame, points, events, config, revision}`; `refreshConfig()`.
- `format.js`: `fmtNum`, `fmtRate`, `fmtMs` (adaptive precision: `0.42 ms`, `12.3 ms`, `1.24 s`),
  `fmtPct`, `fmtAgo`, `colorFor`.
- `ui.js`: `toast(message, level)` stack bottom-right auto-dismiss 4s; `openModal({title, body: Node, actions})`
  returning a close function, focus trap, Esc closes; `openPopover(anchorRect, Node)` positioned
  within viewport, closes on outside click/Esc.
- `charts.js`: `class TimeChart` on `<canvas>`: constructor `(container, {series:[{key,label,color,fill}], stacked, yFormat, yMin, yMaxFloor, log})`;
  `update(points)` where points are `{ts, values:{key:number}}`; `setMarkers([{ts, color, label}])`
  draws vertical annotation lines with a small label; 120-second visible window that scrolls
  smoothly (interpolate between 1s frames using requestAnimationFrame); HiDPI aware; resizes
  with its container (ResizeObserver); nice y-axis ticks with autoscale; hover crosshair with a
  tooltip listing each series value at that second; legend. `class Sparkline` for the KPI.
- `main.js`: boots store, renders KPIs and charts from store updates, sets chips and `#conn`.
  Exposes nothing global; later tasks add `import`s and init calls here
  (`initTopology(el, store)`, `initRoutes(el, store)`, `initTraffic(el, store)`,
  `initEvents(el, store, charts)`, `initScenarios(...)`).

Verification: `go test ./...`; `node --check` on every JS file; run the gateway locally
(`go run ./cmd/gateway -config config/config.json -state <tmp>/state.json -data-addr 127.0.0.1:18080 -admin-addr 127.0.0.1:19090`
plus two `go run ./cmd/upstream` processes if needed, or `docker compose`) and open
`http://127.0.0.1:19090/dashboard` with `chrome-devtools-axi`; take a screenshot under the SDD
workspace; confirm no console errors and no CSP violations. Use the generator
(`PUT /admin/v1/load`) to put traffic on the charts.

## Task 7: Animated topology

**Files:** create `internal/gateway/web/js/topology.js`, extend `web/app.css`, modify
`web/js/main.js` to call `initTopology(document.getElementById('topology'), store)`.

The centerpiece of the demo, in the spirit of breakscale.
- Layout: four columns inside `#topology`: Clients node -> Gateway node -> one node per route
  (sorted by priority, descending) -> one node per unique upstream ID. Nodes are HTML/SVG cards
  laid out from measured container size; re-layout on resize and when the config revision
  changes (animate positions with CSS transitions or tweening; new nodes fade in).
- Node contents:
  - Clients: "Traffic generator" + external, current rps sent, shed/s.
  - Gateway: rps, p99, in-flight, circular gauge of success rate, config revision.
  - Route: ID, `METHODS path_prefix`, rps, error %, p95, a lock icon when JWT is required, an
    `AUTO` badge when `auto_weight`.
  - Upstream: ID, URL host, health state (HEALTHY / EJECTED / FAULT when the upstreams endpoint
    reports an active fault), rps, p95, in-flight, a small bar of in-flight vs 64.
- Edges: curved paths client->gateway, gateway->route, route->upstream. Route->upstream edges
  label the effective weight (`frame.weights`), dashed when the weight is 0. Stroke width scales
  with the edge's share of traffic.
- Particles on a `<canvas>` overlay: spawn rate per edge proportional to that edge's rps with a
  sqrt scale and a cap (about 40 particles/s per edge, 600 alive total), travel time
  proportional to that hop's latency (clamped 0.4s..4s). Particle color: green success, amber
  4xx, red 5xx, sampled by the edge's status mix. 401 rejections stop at the route node with a
  small burst. Route->upstream rps and status mix come from `edges["<route>><upstream>"]`.
- "Breaking" cues: node border and a pulsing halo go amber when error % > 2 or p99 > 250ms and
  red when error % > 10 or p99 > 1000ms or the upstream is ejected; ejected upstreams render
  greyed with a red badge and their edges turn red dashed.
- Interaction: hover a node -> popover with detailed stats. Click an upstream -> popover with
  fault controls (latency slider 0..3000ms, error-rate slider 0..100%, "Fail health checks"
  toggle, "Return 503" toggle, Apply, Reset) calling `api.injectFault` / `api.resetFault`, with
  toast feedback. Click a route -> `document.dispatchEvent(new CustomEvent('route:edit', {detail:{id}}))`.
  Poll `api.getUpstreams()` every 3s for fault state.
- Performance: one requestAnimationFrame loop, pause when `document.hidden`; with
  `prefers-reduced-motion` draw static flow indicators instead of particles.
- Verify in the browser at 1920x1080 and 1366x768 with traffic on (and with a fault injected);
  save screenshots to the SDD workspace; no console errors.

## Task 8: Route and weight controls

**Files:** create `internal/gateway/web/js/routes.js`, `web/js/routeform.js`; extend
`web/app.css`; modify `web/js/main.js` to call `initRoutes(...)`.

- `#routes` panel lists every route as a card: ID, priority, match summary, rewrite, timeout,
  retry, JWT badge, AUTO badge, live rps / error % / p95 from the store.
- Weight editor per route: one slider + number input per upstream, colored by `colorFor`.
  Sliders are linked so the total stays 100: changing one rebalances the others proportionally
  to their current weights (or evenly when they are all 0), integers only. Buttons: "Even split",
  "Auto weight" toggle (sets `auto_weight` in the config; when on, sliders are disabled and show
  live effective weights from `frame.weights` as animated bars), "Apply" and "Discard" (enabled
  only when the route has unsaved edits). Apply = take the latest config, replace this route,
  `putConfig` with the current revision.
- Conflict handling: on 412, toast a warning, refresh config, and keep the user's pending edit
  for that route if the route still exists, so the user can re-apply. Validation errors (400)
  show inline on the card with the server message.
- Progressive canary (routes with 2+ upstreams): choose a target upstream, then "Start canary"
  applies 10 -> 25 -> 50 -> 100 to the target (remainder to the other upstreams proportionally)
  every 8 seconds, each step a real config revision, with a visible step indicator and a
  "Rollback" button that restores the weights from before the canary. Export
  `startCanary(routeId, upstreamId)` for Task 9's scenario buttons.
- Add route / Edit route (modal via `ui.openModal`, form in `routeform.js`): id, priority
  (default: next free below the lowest), methods (checkboxes GET HEAD POST PUT PATCH DELETE
  OPTIONS), path prefix, hosts (comma list), headers (key=value lines), rewrite prefix,
  timeout ms, retry (checkbox enabled only when all methods are GET/HEAD/OPTIONS/TRACE), JWT
  required, upstreams (rows: pick from `api.getUpstreams()` list or enter custom ID + URL, weight),
  auto weight. Client-side validation mirrors server rules (`Validate` in `types.go`), server
  400 text is shown in the form. Listen for the `route:edit` event to open the edit form.
- Delete route with a confirm modal (disabled when only one route remains).
- "Config JSON" toggle on the panel header showing the active config pretty-printed in a
  `<textarea>` that can be edited and applied (same revision handling).
- Verify in the browser: add a route that uses a known upstream and see traffic flow to it in
  the topology; change weights and watch the upstream chart shift; toggle auto weight with a
  latency fault on one upstream and watch weights move; run and roll back a canary; force a
  412 by editing in two tabs. Screenshots to the SDD workspace; no console errors.

## Task 9: Traffic panel, event feed, scenarios

**Files:** create `internal/gateway/web/js/traffic.js`, `web/js/events.js`,
`web/js/scenarios.js`; extend `web/app.css`; modify `web/js/main.js`.

- `#traffic` panel: large RPS slider with a logarithmic mapping 0..`max_rps` plus numeric
  input; concurrency slider 1..1024; per-route mix sliders (default equal); invalid JWT %
  slider (with a hint "No load-generator token configured; JWT routes will return 401" when
  `has_token` is false); Start/Stop button. Live readout: sent/s, shed/s, in-flight. Updates
  are debounced (250ms) into `api.putLoad`.
- Presets: Idle (0), Steady (150), Busy (800), Spike (ramp to `max_rps` over 5s, hold 15s,
  return to the previous rate), Break it (ramp from current to `max_rps` over 60s, like
  breakscale's traffic slider). Ramps update once per second and can be cancelled; the active
  preset is highlighted.
- `#events` feed: newest first, icon and color by level, kind chip, relative time that
  updates, filter chips (All, Config, Health, Faults, Traffic, Weights), max 200 rendered.
  New events slide in. Also push `{ts, color, label}` markers for config, health, and fault
  events to the throughput and latency charts via `setMarkers` (last 120s only).
- Scenarios (a compact row of buttons in the traffic panel or a small panel under it):
  "Canary rollout" (uses `startCanary` on the first route with 2+ upstreams, target = the
  upstream with the lowest current weight), "Slow upstream" (800ms on a selected upstream),
  "Flaky upstream" (30% errors), "Kill upstream" (unhealthy + 503), "Reset all faults"
  (reset every upstream from `getUpstreams`). The upstream selector lists upstream IDs.
- Verify in the browser end to end: Break it ramp shows rising latency and shed requests;
  scenarios produce matching events and chart markers. Screenshots to the SDD workspace.

## Task 10: Demo topology, deployment sizing, docs

**Files:** create `config/demo.json`, `docs/DEMO-SCRIPT.md`; modify `docker-compose.yml`,
`deployment/cloudformation.yaml`, `README.md`, `docs/REVIEW-GUIDE.md`, `docs/PLAN.md`
(architecture note only), `scripts/review-smoke.sh`.

- `config/demo.json`: a superset of `config/config.json` (routes `catalog`, `checkout`,
  `secure-read` byte-for-byte identical in meaning) plus routes: `users` (GET, `/api/users`,
  users-a 50 / users-b 50, auto_weight true), `orders` (GET/POST, `/api/orders`, orders-a 90 /
  orders-b 10), `search` (GET, `/api/search`, search-a 70 / search-b 30, retry 1), `inventory`
  (GET, `/api/inventory`, header match `X-Region: eu` -> inventory-eu 100) and `inventory-default`
  (GET, `/api/inventory`, lower priority, inventory-us 100), plus a `catalog-v3`
  upstream available in the known list but not in any route (so the demo can add it live).
  Must pass `Validate`; add a Go test that loads every `config/*.json` and validates it.
- `docker-compose.yml`: keep `upstream-v1` and `upstream-v2` services and names. Add services
  for `catalog-v3`, `users-a`, `users-b`, `orders-a`, `orders-b`, `search-a`, `search-b`,
  `inventory-eu`, `inventory-us`, each using the upstream entrypoint with distinct `PORT`,
  `SERVICE`, `BASE_DELAY_MS`, `JITTER_MS` (spread from ~2ms to ~60ms so latency differences are
  visible; make `search-b` and `orders-b` noticeably slower). Gateway: mount
  `${GATEWAY_CONFIG:-./config/demo.json}` as `/etc/gateway/config.json`; env `KNOWN_UPSTREAMS`
  listing every upstream service; env `LOADGEN_BEARER_TOKEN: ${LOADGEN_BEARER_TOKEN:-}`;
  command adds `-load-max-rps ${LOAD_MAX_RPS:-3000}`. Note that persisted state in the
  `gateway-data` volume overrides the bootstrap config; document `docker compose down -v`.
- `deployment/cloudformation.yaml`: `InstanceType` allowed values
  `[t3.micro, t3.medium, t3.large, t3.xlarge, c6i.large, c6i.xlarge, m6i.large]`, default
  `t3.large`; update the stack description (no em dash). Keep everything else.
- `scripts/review-smoke.sh`: add checks that `/admin/v1/load` and `/admin/v1/series` return
  200 and that `/dashboard/js/main.js` is served. Keep existing checks.
- `docs/DEMO-SCRIPT.md`: a 10 to 12 minute run sheet for a live demo: setup (tunnel, token,
  `docker compose up`), then numbered beats with what to click and what to say: tour the
  topology; start Steady traffic; header-based routing (inventory EU vs US); weights and live
  shift; progressive canary and rollback; add a route live using `catalog-v3`; JWT rejections;
  slow upstream + auto weight adapting; kill upstream -> ejection -> recovery; Break it ramp
  and what breaks first; reset. Include a short troubleshooting section.
- `README.md` and `docs/REVIEW-GUIDE.md`: describe the new dashboard, endpoints table rows for
  the new admin endpoints, the demo config, and the recommended instance size. Keep the t3.micro
  path documented as the low-cost option.
- Verify: `docker compose up --build -d` locally with alternate ports if needed, run
  `scripts/review-smoke.sh` against it, confirm every route returns 200 (or 401 for JWT routes
  without a token) through the gateway, then `docker compose down -v`.

## Task 11: End-to-end visual QA and polish

**Files:** any under `internal/gateway/web/` (and Go files only to fix bugs found).

- Run the full demo stack (`docker compose up --build`) and walk through every beat of
  `docs/DEMO-SCRIPT.md` in a real browser via `chrome-devtools-axi` at 1920x1080 and 1366x768,
  with a screenshot per beat saved to the SDD workspace.
- Fix every defect found: console errors, CSP violations, layout overflow, unreadable text,
  janky animation, controls that do not round-trip, stale state after reconnect (restart the
  gateway container mid-session and confirm the UI reconnects and recovers).
- Check the page stays responsive for 5 minutes at the Busy preset (no unbounded growth of DOM
  nodes, particles, or memory; use `performance.memory` or heap snapshots if available).
- Report the list of defects found and fixed, with before/after screenshots paths.
