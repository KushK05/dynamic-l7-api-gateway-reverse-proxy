# Dynamic L7 API Gateway and Reverse Proxy

Phase 2 builds a custom Go Layer 7 gateway that applies validated route updates atomically while requests continue, checks RS256 JWTs against public verification keys stored in AWS Secrets Manager, and reports route, traffic, and upstream health in a small live dashboard.

The live dashboard demo is recommended on one x86_64 EC2 `t3.large` host (the CloudFormation default). The low-cost option is a `t3.micro` host with 2 GiB of disk-backed swap, which is enough for light traffic and the small `config/config.json` but not for the Busy or Break it traffic presets. Both run Docker Compose. The gateway, the mock upstreams (two by default in `config/config.json`, eleven with the demo config), and optional benchmark/fault tools run in separate containers. Port `8080` is the public data plane. Port `9090` is published only on host loopback and should be reached remotely through an SSH tunnel. This demo profile is for functional review, not the larger-instance performance targets or evidence of multi-host scalability or distributed linearizability.

For a presenter run sheet of the live dashboard, see [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md).

See [docs/PLAN.md](docs/PLAN.md) for implementation phases and acceptance targets. See [docs/REVIEW-GUIDE.md](docs/REVIEW-GUIDE.md) for the complete EC2 demonstration flow, reviewer Q&A, and source file guide.

## Local run

Requirements: Go 1.23 or later, Docker Engine, Docker Compose v2. The default config uses mock upstreams and starts without AWS credentials.

```sh
docker compose up --build
```

Open `http://localhost:8080/healthz` for the data plane. Open `http://localhost:9090/dashboard` for the live dashboard. The admin API is bound to `127.0.0.1:9090` by Compose. Generated active configuration is stored in the Docker volume `gateway-data`.

If those ports are already occupied, choose alternate host ports consistently for startup and smoke checks:

```sh
GATEWAY_PORT=18080 ADMIN_PORT=19090 docker compose up --build -d
BASE_URL=http://127.0.0.1:18080 ADMIN_URL=http://127.0.0.1:19090 scripts/review-smoke.sh
```

To stop the local stack:

```sh
docker compose down
```

### Demo topology and the live dashboard

Compose mounts [config/demo.json](config/demo.json) by default. It is a superset of `config/config.json` (same `catalog`, `checkout`, `secure-read` routes) plus `users` (auto weight), `orders`, `search`, a header-routed `inventory` (`X-Region: eu`) with an `inventory-default` fallback, and a `catalog-v3` upstream that no route uses yet so it can be added live. Each mock upstream has its own base delay and jitter in `docker-compose.yml` so latency differences are visible. Use `GATEWAY_CONFIG=./config/config.json` for the original two-upstream setup.

The gateway persists the active config in the `gateway-data` volume and that persisted state wins over the bootstrap file on later starts. After editing a config file or finishing a demo, run `docker compose down -v` to delete the volume and start clean.

The dashboard at `/dashboard` (admin port) shows a KPI strip, an animated topology (click an upstream to inject faults, click a route to edit it), a Traffic control panel (RPS slider, Idle/Steady/Busy/Spike/Break it presets, concurrency, invalid JWT percent, route mix), scenarios (canary rollout, slow upstream, flaky upstream, kill upstream, reset all faults), an event feed with chart markers, four charts, and a Routes panel (linked weight sliders, Even split, Auto weight, progressive canary with rollback, add/edit/delete route, Config JSON editor). Every configuration change from the UI goes through `PUT /admin/v1/config` with `If-Match`; auto weight is an in-memory overlay that never creates a revision.

Optional environment variables for `docker compose up`: `LOADGEN_BEARER_TOKEN` (valid JWT the load generator sends on JWT routes), `LOAD_MAX_RPS` (generator ceiling, default 3000), `GATEWAY_CONFIG` (bootstrap config path), `GATEWAY_PORT` and `ADMIN_PORT`. The gateway reads fault-eligible upstreams from `-known-upstreams` or `KNOWN_UPSTREAMS` (`id=url,id=url`).

## Configure a local JWT key set

Generate the signing key on the developer machine. Keep it out of the gateway and out of version control. The generated JSON contains only public verification material and metadata.

```sh
go run ./cmd/jwtgen keygen \
  -kid review-1 \
  -issuer dynamic-l7-review \
  -audience dynamic-l7-gateway \
  -private "$HOME/.config/dynamic-l7/review-signing-private.pem" \
  -secret "$HOME/.config/dynamic-l7/jwt-keys.secret.json"
JWT_KEYS_JSON="$(cat "$HOME/.config/dynamic-l7/jwt-keys.secret.json")" docker compose up --build
```

Create a short-lived valid token on the developer machine:

```sh
go run ./cmd/jwtgen token \
  -private "$HOME/.config/dynamic-l7/review-signing-private.pem" \
  -kid review-1 -issuer dynamic-l7-review -audience dynamic-l7-gateway
```

Use that token as `Authorization: Bearer <token>` for `GET /api/secure/...` or `POST /api/checkout/...`.

## Routes and administration

The checked-in starting configuration is [config/config.json](config/config.json); the Compose demo uses [config/demo.json](config/demo.json). Route updates use `GET /admin/v1/config`, then `PUT /admin/v1/config` with the current revision in the `If-Match` header. A valid update is persisted and fsynced before the gateway publishes a new immutable snapshot. Revisions continue across process restarts. A stale revision returns `412`; malformed JSON returns `400`; invalid route configuration returns `400`; none changes the active configuration.

```sh
curl -fsS http://127.0.0.1:9090/admin/v1/config
curl -fsS -X PUT http://127.0.0.1:9090/admin/v1/config \
  -H 'If-Match: "1"' -H 'Content-Type: application/json' \
  --data-binary @config/catalog-80-20.json
```

The JSON configuration has version `1`, uniquely prioritized routes, method/host/path/header match conditions, optional path-prefix rewriting and JWT policy, timeout, at most one retry, and upstreams with weights totaling 100. Route updates replace the complete configuration, so the catalog canary fixtures include the checkout and secure JWT routes unchanged. Routes may retry only with explicitly listed idempotent methods. The runtime retry is made once after a transport error and only when a different weighted upstream is available. HTTP error responses such as 503 are surfaced and handled by health ejection, not retried after response bytes begin streaming.

Useful endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /healthz`, `GET /readyz` | Liveness and readiness |
| `GET /metrics` | Prometheus text metrics |
| `GET /admin/v1/config` | Active versioned config and ETag |
| `PUT /admin/v1/config` | Validated revision-checked update |
| `GET /admin/v1/status` | Route and secret revisions, upstream health, traffic metrics |
| `POST /admin/v1/secrets/refresh` | Force a Secrets Manager key refresh |
| `GET /admin/v1/series?seconds=N` | Per-second throughput, latency and per-upstream history for the charts |
| `GET /admin/v1/events?since=SEQ` | Event feed entries (config, health, faults, traffic, weights) after a sequence number |
| `GET /admin/v1/load`, `PUT /admin/v1/load` | Read or set the built-in load generator (rate, concurrency, invalid JWT percent, route mix) |
| `GET /admin/v1/upstreams` | Known upstreams with URL, health and injected fault state |
| `POST /admin/v1/upstreams/{id}/fault` | Inject delay, error rate or unhealthy state into a known upstream |
| `POST /admin/v1/upstreams/{id}/reset` | Clear faults on one upstream |
| `GET /admin/v1/stream` | Server-sent events feed that drives the dashboard |
| `GET /dashboard` | Live review dashboard (embedded, no build step) |

`GET /admin/v1/status` also returns the effective `weights`. Every mutating admin endpoint (`PUT` config, `PUT` load, fault and reset `POST`s) requires `Content-Type: application/json` and returns `415` otherwise.

The admin plane has no application-level authentication in this academic single-host setup. Compose binds it to host loopback, and the EC2 security group does not expose port 9090. Keep SSH restricted to the operator's `/32`; use the CloudFormation output to open an SSH tunnel.

## Current EC2 student-account deployment

For the live dashboard demo, prefer a `t3.large` (or `t3.xlarge`, `c6i.large`, `c6i.xlarge`, `m6i.large`); the CloudFormation `InstanceType` parameter allows these and defaults to `t3.large`. The low-cost path below keeps working on a `t3.micro`. The review setup uses the already-created Ubuntu `t3.micro`; it does not require CloudFormation or permission to create IAM roles. Keep the gateway public key set on the EC2 host in a root-readable `.env` file, and keep the JWT signing private key on your workstation. The gateway can verify tokens from `JWT_KEYS_JSON` without AWS access. In this mode, `POST /admin/v1/secrets/refresh` is unavailable because there is no instance role; update the public key set and recreate the gateway container to rotate keys.

On EC2, from the repository directory, refresh and start the stack:

```sh
git pull --ff-only
printf 'JWT_KEYS_JSON=%s\nAWS_REGION=us-east-1\n' "$(python3 -c 'import json; print(json.dumps(json.load(open("/home/ubuntu/jwt-keys.secret.json")), separators=(",", ":")))')" | sudo tee .env >/dev/null
sudo chown ubuntu:ubuntu .env
chmod 600 .env
sudo docker compose up --build -d
sudo docker compose ps
curl -fsS http://127.0.0.1:8080/healthz
```

Open the dashboard from your workstation with an SSH tunnel, then browse to `http://localhost:9090/dashboard`:

```sh
ssh -i /path/to/your-key.pem -L 9090:127.0.0.1:9090 ubuntu@YOUR_EC2_IP
```

The security group should allow port `8080` only as needed for review traffic, SSH only from your current public IP `/32`, and no inbound `9090` rule. Do not copy the private signing key to EC2. If an administrator later provides an EC2 role with access to the exact verification secret, the Secrets Manager refresh path can be enabled separately.

## Fault injection, tests, and benchmarks

Run these commands from the EC2 repository checkout over SSH. The scripts use Docker directly when available and `sudo docker` on the Ubuntu host. Fault controls remain inside the private Compose network. The fault demo briefly runs low-rate traffic, applies an 80/20 canary, demonstrates latency/ejection and full v2 process loss, then restores the original routes and upstream state:

```sh
scripts/fault-demo.sh
```

The smoke and E2E scripts write evidence into the ignored `evidence/` directory on EC2. Generate a short-lived valid JWT on your workstation, then paste it into the hidden prompt in the EC2 terminal when asked. The E2E run checks missing, forged, and valid tokens; claim-specific attacks are also checked when the private key is available locally. It never requires copying the private key to EC2.

```sh
scripts/review-smoke.sh
scripts/e2e-tests.sh
```

The benchmark matrix defaults to a small-host demo profile (5, 10, and 20 RPS; 2-second warm-up; 10-second measurement; one repetition). It compares direct upstream, proxy without JWT, proxy with JWT, and proxy during reloads. Paste a short-lived valid token when prompted. These figures show behavior on the shared demo host and are not `c7g.large` performance acceptance results.

```sh
scripts/benchmark-matrix.sh
python3 scripts/summarize-benchmarks.py
```

The original high-load profile remains available only for a dedicated benchmark machine: `BENCH_PROFILE=performance scripts/benchmark-matrix.sh`. It runs 100/500/1000 RPS with 15-second warm-up, 60-second measurements, and three repetitions. Do not run that schedule on the `t3.micro`. Reports include counts, errors, achieved rate, p50/p95/p99, container list, and CPU/memory snapshots. Copy the evidence directory to your workstation before terminating EC2 if you need to retain it.

## Teardown

After copying any evidence you want to keep, remove containers and the persisted gateway config from EC2:

```sh
sudo docker compose down --volumes
```

Then stop or terminate the instance from the EC2 console. The current student-account setup has no CloudFormation stack or attached Secrets Manager role to delete. Keep the signing private key only on your workstation.
