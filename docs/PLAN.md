# Dynamic L7 API Gateway and Reverse Proxy - Phase 2

## Goal and guarantees

Build a high-performance Go Layer 7 gateway that validates route changes before publishing them, changes the active immutable config snapshot without restarting, and lets every request complete against one revision. The gateway verifies RS256 JWTs using public keys from AWS Secrets Manager, observes upstream health, ejects failed targets, and exposes a live review dashboard and reproducible fault/benchmark tools.

The low-cost functional review deployment is one x86_64 EC2 `t3.micro` instance with 2 GiB of disk-backed swap, running Docker Compose. Four separate containers provide the gateway, upstream-v1, upstream-v2, and optional benchmark/fault tools. It demonstrates single-process atomic routing and upstream-process fault handling. It does not demonstrate multi-host scaling, consensus, or distributed linearizability. Performance acceptance targets below remain scoped to `c7g.large`; the `t3.micro` profile is for functional review only.

## Architecture and interfaces

```text
                         EC2 t3.micro + 2 GiB swap
       public :8080        Docker Compose network
Client ----------------> Gateway -----------------> upstream-v1 :9101
                           |  |  \-----------------> upstream-v2 :9102
                           |  +-- public metrics and health
                           +----- admin :9090, host loopback only
                                  ^ SSH local port forward
                           IAM role -> Secrets Manager public RS256 keys
                           benchmark/faultctl -> internal network only
```

- The proxy uses Go `net/http` and `httputil.ReverseProxy`, preserving streamed request and response bodies, request IDs, forwarded headers, and the selected route revision.
- Route config version 1 is compiled into priority-ordered immutable snapshots. `atomic.Pointer` replaces each active snapshot as one operation. Persistent state stores both config and revision; a valid update is fsynced and atomically renamed before activation.
- Route matching supports host, method, path prefix with segment boundary, and header equality. A route may rewrite the matched prefix and direct traffic to weighted upstreams. Duplicate route IDs/priorities, invalid URLs, unsafe identifiers, invalid weights, unsupported versions, excessive timeouts, and unsafe retries are rejected.
- The only retry is one transport retry for explicitly idempotent GET or HEAD routes, and only if a different healthy weighted upstream is available. Responses are streamed, so status-code retries are not attempted after response bytes may have been sent.
- Active health probes run every 500 ms. Two consecutive probe failures eject a target; successful probes restore it. Failed transport requests can also trigger an immediate probe. The mock upstream provides delay, status, error-rate, and health-check fault controls only on the Compose network.
- JWT verification accepts only RS256, requires a known `kid`, verifies signature, issuer, audience, expiry, optional not-before, and 30 seconds of clock skew. Public keys and claim metadata are held in Secrets Manager. `jwtgen` keeps signing private keys on the operator machine. Key refresh swaps the verification set atomically; failures retain the last good set.
- The EC2 instance role has `secretsmanager:GetSecretValue` only for the configured secret. No AWS key is baked into source, image, or environment file. The instance requires IMDSv2 and uses a hop limit of 2 for role credentials from the container.
- The data plane publishes HTTP `:8080`. The admin service listens on `:9090`; Compose publishes it only to `127.0.0.1`. EC2 security group ingress exposes `8080` to clients and SSH `22` only from a caller-supplied `/32`; admin access uses SSH forwarding.

### HTTP surface

| Interface | Contract |
|---|---|
| `ANY /*` | Match active route, optionally verify JWT, choose healthy weighted upstream, then proxy and rewrite |
| `GET /healthz`, `GET /readyz` | Liveness and config readiness |
| `GET /metrics` | Prometheus text counters for requests, bytes, status classes, JWT rejections, retries, ejections, and reloads |
| `GET /admin/v1/config` | Active revision and config; ETag is the quoted revision |
| `PUT /admin/v1/config` | JSON config plus required `If-Match`; returns new revision or rejects without activating |
| `GET /admin/v1/status` | Route and secret revisions, upstream health/ejection, counters, and latency percentiles |
| `POST /admin/v1/secrets/refresh` | Fetch and atomically activate current public verification keys |
| `GET /dashboard` | Dependency-free responsive dashboard with revision, latency, status, auth, retry, and health state |
| Upstream `POST /admin/fault`, `/admin/reset` | Internal-only mock fault-control endpoints |

Admin plane has no application authentication in this one-instance academic setup; its exposure is limited to host loopback and an SSH tunnel. Never publish port 9090 or the mock upstream ports publicly.

## Implementation phases

1. **Foundation and data plane** - create Go module and Compose topology; load versioned config; implement validation, deterministic path/method/host/header precedence, rewriting, weighted selection, streaming HTTP forwarding, request IDs, and identifiable mock upstreams.
2. **Atomic control plane** - implement config read/write, required revision matching, durable revisioned storage, atomic snapshots, and append-only reload audit events. Confirm rejected updates preserve both active and persisted revisions.
3. **JWT and upstream resilience** - integrate Secrets Manager via AWS CLI and the EC2 instance role; cache verification keys in memory, refresh every five minutes, retain last-known-good keys, and support forced refresh. Verify JWT claims and algorithm. Add active health probes, ejection/recovery, timeout, and safe transport retry.
4. **Metrics and review dashboard** - expose Prometheus counters and status data; sample a bounded rolling latency set for p50/p95/p99; render the status dashboard without a frontend build/dependency.
5. **Fault and end-to-end checks** - script bad/missing JWTs, active traffic during config reloads, stale revisions, invalid configurations, upstream delays/errors/down state/recovery, and report generation under `evidence/`.
6. **Benchmarks and EC2 delivery** - deploy the low-cost functional review on one x86_64 `t3.micro` EC2 host through CloudFormation. The separate performance profile uses `c7g.large`; collect exact instance/container configuration, and benchmark direct upstream, proxy without JWT, proxy with JWT, and proxy during config reloads at 100/500/1000 RPS. Each run has 15 seconds warm-up, 60 seconds measurement, and three repetitions. Save JSON request/latency results, container CPU/memory snapshots, and a Markdown summary. Document rotation, preflight, and teardown.

## Test and acceptance plan

- Unit tests cover config invariants, ambiguous priority, unsafe retry policy, path boundaries, weighted distribution, revision conflict and persistence across restart, JWT signature/claims, and proxy path/revision forwarding.
- Build and static checks: `gofmt -w`, `go test ./...`, `go test -race ./...`, `go vet ./...`, `govulncheck ./...`, `docker compose config -q`, and multi-architecture image build for `linux/amd64` (the selected t3 demo host).
- Run Compose integration checks against actual gateway and upstream processes. During continuous load, alternate valid route revisions and issue invalid and stale updates. Confirm every response carries a complete revision and no config-reload-induced gateway failures occur.
- Confirm valid JWT acceptance and 401 for missing, malformed, forged, expired, wrong issuer/audience, unknown key ID, and unsupported algorithm.
- Measure weighted distribution over 10,000 requests; an 80/20 route should land between 75/25 and 85/15.
- Confirm a stopped target is ejected within 3 seconds and returns within 10 seconds after healthy recovery. Confirm POST is never retried; retry is limited to GET/HEAD on transport failure.
- If running the performance profile on `c7g.large`, target at least 90% of direct-upstream throughput at 500 RPS, no 5xx or transport errors when dependencies are healthy, proxy-only p95 overhead below 10 ms, and less than 20% p95 increase when JWT verification is enabled. Do not use the low-cost `t3.micro` demo for these acceptance targets. Keep results even when targets are missed; the benchmark is not a substitute for multi-host performance testing.

## Project review demonstration (10 to 12 minutes)

1. Show the EC2 instance, the one-secret IAM policy, security-group ports, running containers, and secret metadata without displaying secret contents.
2. Open the dashboard through the SSH tunnel and send baseline traffic. Point out request IDs, upstream identity, status totals, latency, and config revision.
3. Keep traffic running while switching catalog from 100% v1 to an 80/20 canary. Show the revision advance and actual target split.
4. Submit an invalid config, then a stale `If-Match`. Show both rejected while the valid route remains active.
5. Send requests without a token, with malformed/forged/expired/wrong-audience/unknown-key/disallowed-algorithm tokens, then a valid RS256 token. Show 401/200 and rejection counters.
6. Add latency and 503 failures to v2, then stop its container. Show probe failure, target ejection, safe GET failover, and continued service from v1. Restart v2 and wait for health recovery.
7. Present the repeated benchmark summary and run a short live sample at 100 RPS. Explain that measurements use one EC2 host.
8. State the guarantee: each request uses one immutable route revision; a rejected update does not disrupt current traffic; key rotation does not restart the gateway.
9. Run fault reset, preserve the local evidence bundle, and delete the temporary CloudFormation stack and secret after review.

## Deployment, review evidence, and cleanup

- Follow `README.md` for key generation, secret creation, CloudFormation deployment, SSH tunnel, fault scripts, and teardown.
- `scripts/review-smoke.sh` checks local or tunneled health, metrics, dashboard, admin status, and proxy response. `scripts/e2e-tests.sh` exercises JWT attacks, 100 valid plus 100 invalid and 100 stale updates under load, and target failure/recovery. `scripts/benchmark-matrix.sh` writes raw reports and resource snapshots; `scripts/summarize-benchmarks.py` writes the Markdown comparison.
- Keep local evidence under ignored `evidence/`: raw benchmark reports, resource snapshots, E2E report, dashboard screenshots, effective IAM policy, CloudFormation stack parameters with secret ARN redacted as needed, and exact source commit hash. Never store JWT values, private signing keys, or secret contents in evidence.
- The review host and stack are temporary. Remove Docker containers/volumes if no longer needed, delete the CloudFormation stack, and schedule the verification secret for deletion after preserving permitted evidence.

## Implemented project boundaries

- Phase 2 is single host, single active gateway process, HTTP-only data plane, and synthetic upstreams. TLS termination and multi-instance orchestration remain future work.
- AWS Secret Manager access uses the AWS CLI in the gateway image and the EC2 role credential chain. Local development can use `JWT_KEYS_JSON` for public test material.
- Health-based ejection is process-level and in-memory. Route config and revision persist; health and metrics reset when the process restarts.
- Faults and retries are intentionally bounded: one injected mock service, one retry at most, and only for transport failures on explicitly idempotent methods.
