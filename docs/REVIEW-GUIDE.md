# Project Review Guide

This guide is the full runbook for demonstrating the Dynamic L7 API Gateway on the current Ubuntu EC2 `t3.micro`. It includes setup, the live review sequence, expected results, likely reviewer questions, and a map of the important source files.

## What the project demonstrates

The gateway runs on one EC2 host with two separate upstream processes. It forwards HTTP requests, checks JWTs on protected routes, chooses upstreams by configured weights, detects unhealthy upstreams, and accepts route updates while traffic continues.

Each request reads one immutable route snapshot. A config update is validated, written durably, then published as one new snapshot. This is a single-process, single-host guarantee. It is not a distributed consensus or multi-host linearizability demonstration.

The current student-account deployment loads public JWT verification keys from `JWT_KEYS_JSON` in the Compose `.env` file. The signing private key stays on the workstation. Since the account does not allow creating the required EC2 role, the deployed demo does not demonstrate live Secrets Manager refresh. The gateway code supports that path when an authorized role is available.

## Before the review

### 1. Start or confirm the EC2 instance

Start the existing instance from the EC2 console. A stop/start may change its public IP, so use the current address shown by EC2. Confirm the security group permits SSH from your current public IP and gateway port `8080` from the review client. Do not expose admin port `9090` publicly.

### 2. Pull and start the current project

SSH into Ubuntu and enter the repository:

```sh
ssh -i /path/to/your-key.pem ubuntu@YOUR_CURRENT_EC2_IP
cd ~/dynamic-l7-api-gateway-reverse-proxy
git pull --ff-only
sudo docker compose up --build -d
sudo docker compose ps
```

The gateway should report healthy. Check the local data plane and the expected protected-route behavior:

```sh
curl -fsS http://127.0.0.1:8080/healthz
curl -s -o /dev/null -w 'Protected route without token: HTTP %{http_code}\n' \
  http://127.0.0.1:8080/api/secure/profile
scripts/review-smoke.sh
```

Expected results are `{"status":"ok"}` and `HTTP 401`. A `404` on the protected URL means the active persisted config is missing the secure route. Restore the checked-in full config before the review:

```sh
REV="$(curl -fsS http://127.0.0.1:9090/admin/v1/config | python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])')"
curl -fsS -X PUT http://127.0.0.1:9090/admin/v1/config \
  -H "If-Match: \"$REV\"" -H 'Content-Type: application/json' \
  --data-binary @config/config.json
```

### 3. Open the dashboard through SSH

Keep the SSH session open. From a second terminal on your workstation, create a local tunnel:

```sh
ssh -i /path/to/your-key.pem -L 9090:127.0.0.1:9090 ubuntu@YOUR_CURRENT_EC2_IP
```

Open `http://localhost:9090/dashboard` in your workstation browser. The browser is displaying live status from the EC2 gateway through the SSH tunnel. It does not show containers running on your workstation.

### 4. Prepare a JWT without copying the private key

On your workstation, generate a fresh token and test it against the EC2 gateway. Copy it to the clipboard only after confirming HTTP 200:

```sh
cd "$HOME/github/Projects/Dynamic L7 API Gateway & Reverse Proxy"
TOKEN="$(go run ./cmd/jwtgen token \
  -private "$HOME/.config/dynamic-l7/review-signing-private.pem" \
  -kid review-1 -issuer dynamic-l7-review -audience dynamic-l7-gateway \
  -expires-in 30m)"
curl -s -o /dev/null -w 'Valid JWT: HTTP %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  http://YOUR_CURRENT_EC2_IP:8080/api/secure/profile
printf '%s' "$TOKEN" | pbcopy
unset TOKEN
```

Paste the token only into a hidden prompt when a script asks for it. Never put the token or signing private key into Git, evidence files, or the EC2 host.

## Live review flow

This sequence takes about 10 to 12 minutes. Keep the dashboard open throughout.

### 1. Establish that requests reach EC2

From your workstation, show a public health check and a catalog request:

```sh
curl -fsS http://YOUR_CURRENT_EC2_IP:8080/healthz
curl -i http://YOUR_CURRENT_EC2_IP:8080/api/catalog/items
```

Point out `X-Request-ID`, `X-Config-Revision`, and `X-Upstream-ID` in the response. The JSON body identifies upstream-v1 or upstream-v2.

### 2. Show JWT enforcement

Without a token, the protected route should return `401`. With the fresh token, it should return `200`:

```sh
curl -s -o /dev/null -w 'Missing token: HTTP %{http_code}\n' \
  http://YOUR_CURRENT_EC2_IP:8080/api/secure/profile
curl -s -o /dev/null -w 'Valid token: HTTP %{http_code}\n' \
  -H 'Authorization: Bearer PASTE_TOKEN_HERE' \
  http://YOUR_CURRENT_EC2_IP:8080/api/secure/profile
```

The dashboard's JWT rejection count should increase after the missing-token request.

### 3. Show live, atomic route updates and revision conflicts

The simplest prepared demonstration is `scripts/e2e-tests.sh`, which exercises an 80/20 catalog canary while traffic is running, sends valid and invalid config updates, checks stale revisions, and then exercises upstream failure and recovery:

```sh
cd ~/dynamic-l7-api-gateway-reverse-proxy
scripts/e2e-tests.sh
```

Paste the fresh JWT at the hidden prompt. The demo profile uses modest traffic for the `t3.micro`. Watch the dashboard revision change while requests continue. The script saves detailed run artifacts under the ignored `evidence/` directory and restores the config and upstream state on exit.

To explain the config API manually, `GET /admin/v1/config` returns the current revision. `PUT /admin/v1/config` requires that same revision in `If-Match`. A valid update advances the revision. A malformed config returns `400`; a stale revision returns `412`. Both rejected updates leave the active config unchanged.

### 4. Demonstrate faults and recovery

For a more visible dashboard demo, run:

```sh
scripts/fault-demo.sh
```

It starts a low-rate stream of catalog requests, applies an 80/20 canary, adds latency and failed health probes to v2, resets the injected fault, stops the v2 container, then restarts it. Point out v2's health state and the request stream served through the gateway. The script restores the original route config and resets the injected fault when it exits.

### 5. Show the benchmark results

Run the default small-host matrix only if there is time. It takes a few minutes and compares direct upstream, gateway without JWT, gateway with JWT, and gateway traffic during reloads at 5, 10, and 20 RPS:

```sh
scripts/benchmark-matrix.sh
python3 scripts/summarize-benchmarks.py
cat evidence/benchmark-summary.md
```

Paste a fresh valid JWT at the prompt. The script first checks that the token is accepted by the EC2 gateway and can be passed into the bench container. Explain that these measurements include one shared EC2 host and demonstrate functional overhead at modest load. They do not establish `c7g.large` performance targets.

### 6. Close with the guarantee and limits

Summarize the demonstrated behavior: each request uses one complete route revision; invalid and stale config updates do not replace the live config; JWTs are checked before forwarding; and upstream failure is reflected in health state while the other upstream can serve traffic.

State the boundary plainly: the review uses one gateway process on one EC2 instance. It does not claim multi-host failover, distributed consensus, or distributed linearizability. JWT verification uses an environment-provided public key set in the student account; Secrets Manager refresh needs an IAM role that this account cannot create.

### 7. Save evidence and stop the instance

Copy any evidence you want to keep from EC2 before terminating it. Then remove the Compose stack and stop or terminate the EC2 instance from the console:

```sh
sudo docker compose down --volumes
```

The EC2 public IP can change when the instance starts again. Recheck it before the next review.

## Questions a reviewer may ask

### What problem does this gateway solve?

It provides one layer for HTTP routing, weighted canaries, JWT checks, upstream health decisions, and route updates, instead of making each upstream application implement those controls independently.

### What does “atomic route update” mean here?

The gateway validates and durably writes the complete replacement config, then swaps one pointer to the new immutable snapshot. A request keeps the snapshot it loaded for its entire lifetime, so it cannot mix fields from two revisions.

### What happens if an update is invalid or based on an old revision?

The API rejects it before activation. Invalid config returns `400`; a stale `If-Match` returns `412`. The active revision remains the previous accepted one.

### Why use `If-Match`?

It is optimistic concurrency control. The caller must name the revision it read, which prevents two writers from silently overwriting each other's changes.

### How does the 80/20 canary work?

For a route with healthy upstreams, the gateway hashes the request ID and selects a target using the configured integer weights. With weights 80 and 20, about 80% of distinct request IDs go to v1 and 20% to v2 over a sufficiently large sample. A short sample can vary.

### Does each request get retried?

No. Retry behavior is constrained by route policy and only applies once to eligible idempotent methods after a transport failure when another healthy target is available. Non-idempotent operations such as POST are not retried by this mechanism. An HTTP 503 response is not retried after response streaming begins.

### How is an unhealthy upstream detected and recovered?

The gateway probes each configured upstream's `/healthz` endpoint every 500 ms. Two consecutive failed probes eject a target for a cooldown period. Healthy probes restore it after cooldown. The fault demo exercises both injected probe failure and full container stop/start.

### What does the JWT check validate?

The gateway accepts RS256 only, looks up the `kid`, checks the signature, issuer, audience, expiry, and optional not-before claim, and allows 30 seconds of clock skew. Missing, malformed, forged, expired, wrong-issuer, wrong-audience, unknown-key, and disallowed-algorithm tokens should be rejected.

### Why is the private key not on EC2?

The gateway only needs the public verification key. The private key signs review tokens and remains on the workstation, reducing the impact of a host or container compromise.

### Why does the current demo not show Secrets Manager refresh?

The student account does not allow creating the EC2 role needed for least-privilege secret access. The current gateway gets public verification material through `JWT_KEYS_JSON`. The code's Secrets Manager path can be demonstrated in an account where an authorized role is available; it is not claimed as a live result here.

### Is the dashboard showing my laptop's containers?

No. The dashboard is served by the EC2 gateway's admin listener. The SSH tunnel carries the browser's localhost connection to that listener on EC2, so the displayed counters and upstream health are from the deployed server.

### What do the four benchmark scenarios mean?

`direct` measures upstream-v1 without the gateway. `proxy-no-jwt` measures the gateway's routing and forwarding. `proxy-jwt` adds RS256 verification. `proxy-reload` sends traffic while route configs alternate. The report includes achieved request rate, errors, revision mismatches, and p50/p95/p99 latency.

### Are these production capacity results?

No. The demo matrix runs at 5, 10, and 20 RPS on a `t3.micro` that also runs the application containers. These results compare behavior for the review; they are not the original larger-instance performance acceptance run or evidence of horizontal scalability.

### What security boundaries are in place?

The data plane is on port `8080`. The admin listener is bound to host loopback and accessed using SSH forwarding. Upstream fault controls are only reachable inside the Compose network. The instance security group should not expose port `9090` or upstream ports.

### What happens if the EC2 instance stops?

The entire demo becomes unavailable because all components share one host. This project demonstrates failover between upstream processes, not failover of the gateway host itself.

## Important files and what they do

### Applications

| File | What it does |
|---|---|
| `cmd/gateway/main.go` | Starts the gateway, loads and validates routes, initializes JWT keys, starts health probes and refresh loops, and handles shutdown. |
| `internal/gateway/server.go` | Defines the public health/data endpoints, admin config/status endpoints, secret refresh endpoint, and live dashboard page. |
| `internal/gateway/proxy.go` | Handles each proxied request: selects one config snapshot, matches a route, checks JWT policy, selects an upstream, rewrites the path, forwards headers, and streams the response. |
| `internal/gateway/types.go` | Defines the JSON route/config schema, validates updates, orders route priorities, and publishes immutable snapshots. |
| `internal/gateway/configstore.go` | Reads and persists route revisions, checks `If-Match`, writes accepted config durably before activation, and records reload audit entries. |
| `internal/gateway/jwt.go` | Verifies JWT format, RS256 signature, key ID, issuer, audience, expiry, and not-before claims. |
| `internal/gateway/secrets.go` | Loads public verification keys from `JWT_KEYS_JSON` or Secrets Manager and atomically retains/replaces the parsed key set. |
| `internal/gateway/health.go` | Probes upstream health, marks targets healthy/ejected, and exposes a safe copy of health state to routing and dashboard code. |
| `internal/gateway/metrics.go` | Counts traffic, status classes, bytes, JWT rejections, retries, ejections, reloads, and rolling latency percentiles. |
| `cmd/upstream/main.go` | Runs one mock backend process, returns an identifiable response, and exposes health and internal fault-control endpoints. Compose starts it twice with different IDs and ports. |
| `cmd/faultctl/main.go` | Sends fault or reset commands to an upstream over the internal Compose network. |
| `cmd/bench/main.go` | Generates constant-rate HTTP traffic and writes request, status, latency, upstream, and revision results as JSON. |
| `cmd/jwtgen/main.go` | Creates local review signing keys and short-lived JWTs. Keep its private key output on the workstation. |

### Configuration and operations

| File | What it does |
|---|---|
| `config/config.json` | Complete default configuration for catalog, checkout, and protected secure routes. Used to restore the baseline. |
| `config/catalog-100-0.json` | Full config with catalog traffic at 100% v1 and 0% v2; other routes remain present. |
| `config/catalog-80-20.json` | Full config with an 80/20 catalog canary; other routes remain present. |
| `docker-compose.yml` | Runs gateway and upstream containers, keeps admin on host loopback, and defines optional benchmark/fault tools. |
| `Dockerfile` | Builds the Go executables for the target architecture and packages them into the runtime image. |
| `scripts/review-smoke.sh` | Checks the essential health, dashboard, metrics, admin, and proxy endpoints and writes a timestamped report. |
| `scripts/e2e-tests.sh` | Exercises JWT responses, canary distribution, valid/invalid/stale reloads under load, and upstream failure/recovery. |
| `scripts/fault-demo.sh` | Runs visible low-rate traffic while injecting latency, failed health probes, and complete v2 process loss, then restores state. |
| `scripts/benchmark-matrix.sh` | Runs direct, proxy, JWT, and concurrent-reload benchmarks using the small-host defaults or a larger-host profile. |
| `scripts/reload-loop.sh` | Alternates the two catalog config files until stopped to create concurrent reload traffic. |
| `scripts/summarize-benchmarks.py` | Reads primary benchmark JSON files and writes a grouped Markdown report plus p95 comparison. |
| `scripts/lib/docker.sh` | Lets operational scripts use Docker directly or fall back to `sudo docker` on Ubuntu. |
| `deployment/cloudformation.yaml` | Optional automated EC2 and IAM-role deployment template. The current student-account deployment was created manually because role creation is not allowed. |
| `docs/PLAN.md` | Records the original project goals, architecture, acceptance criteria, and boundaries. |
| `README.md` | Provides project setup, endpoints, deployment notes, and operator commands. |

The matching unit-test files are `internal/gateway/types_test.go`, `configstore_test.go`, `proxy_test.go`, `jwt_test.go`, and `health_test.go`. Each exercises the corresponding config, persistence, proxy, authentication, or health logic.

## Evidence and interpretation

The `evidence/` directory is ignored by Git. It can contain raw benchmark reports, container snapshots, E2E artifacts, and the generated `benchmark-summary.md`. Do not put JWT values, private signing keys, or verification-key file contents there.

Use evidence to show what was actually run. `0` errors and `0` mixed revisions in a measured run support those properties at that test's load and duration. They do not prove behavior at unmeasured load or on multiple hosts.
