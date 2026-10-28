# Dynamic L7 API Gateway and Reverse Proxy

Phase 2 builds a custom Go Layer 7 gateway that applies validated route updates atomically while requests continue, checks RS256 JWTs against public verification keys stored in AWS Secrets Manager, and reports route, traffic, and upstream health in a small live dashboard.

The low-cost review deployment uses one x86_64 EC2 `t3.micro` host with 2 GiB of disk-backed swap and Docker Compose. The gateway, two upstreams, and optional benchmark/fault tools run in separate containers. Port `8080` is the public data plane. Port `9090` is published only on host loopback and should be reached remotely through an SSH tunnel. This demo profile is for functional review, not the larger-instance performance targets or evidence of multi-host scalability or distributed linearizability.

See [docs/PLAN.md](docs/PLAN.md) for implementation phases, acceptance targets, AWS setup, and the project review flow.

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

The checked-in starting configuration is [config/config.json](config/config.json). Route updates use `GET /admin/v1/config`, then `PUT /admin/v1/config` with the current revision in the `If-Match` header. A valid update is persisted and fsynced before the gateway publishes a new immutable snapshot. Revisions continue across process restarts. A stale revision returns `412`; malformed JSON returns `400`; invalid route configuration returns `400`; none changes the active configuration.

```sh
curl -fsS http://127.0.0.1:9090/admin/v1/config
curl -fsS -X PUT http://127.0.0.1:9090/admin/v1/config \
  -H 'If-Match: "1"' -H 'Content-Type: application/json' \
  --data-binary @config/catalog-80-20.json
```

The JSON configuration has version `1`, uniquely prioritized routes, method/host/path/header match conditions, optional path-prefix rewriting and JWT policy, timeout, at most one retry, and upstreams with weights totaling 100. Routes may retry only with explicitly listed idempotent methods. The runtime retry is made once after a transport error and only when a different weighted upstream is available. HTTP error responses such as 503 are surfaced and handled by health ejection, not retried after response bytes begin streaming.

Useful endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /healthz`, `GET /readyz` | Liveness and readiness |
| `GET /metrics` | Prometheus text metrics |
| `GET /admin/v1/config` | Active versioned config and ETag |
| `PUT /admin/v1/config` | Validated revision-checked update |
| `GET /admin/v1/status` | Route and secret revisions, upstream health, traffic metrics |
| `POST /admin/v1/secrets/refresh` | Force a Secrets Manager key refresh |
| `GET /dashboard` | Live review dashboard |

The admin plane has no application-level authentication in this academic single-host setup. Compose binds it to host loopback, and the EC2 security group does not expose port 9090. Keep SSH restricted to the operator's `/32`; use the CloudFormation output to open an SSH tunnel.

## AWS deployment

Prerequisites: an AWS account and region with `t3.micro` quota, a public HTTPS Git repository for this project, an EC2 key pair, and an operator IP CIDR. These steps create billable resources. Use a disposable review stack and tear it down after the demonstration.

1. Generate an RSA signing key and verification secret on a trusted workstation using the command above. Upload only the public key JSON to Secrets Manager:

   ```sh
   aws secretsmanager create-secret \
     --name dynamic-l7/jwt-verification \
     --secret-string file://"$HOME/.config/dynamic-l7/jwt-keys.secret.json"
   ```

2. Deploy the stack, providing the complete secret ARN, repository URL, key pair, and your SSH `/32`:

   ```sh
   aws cloudformation deploy \
     --template-file deployment/cloudformation.yaml \
     --stack-name dynamic-l7-review \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides \
       RepositoryURL=https://github.com/OWNER/REPOSITORY.git \
       JWTSecretArn=arn:aws:secretsmanager:REGION:ACCOUNT:secret:dynamic-l7/jwt-verification-SUFFIX \
       SSHAllowedCIDR=YOUR.PUBLIC.IP/32 \
       KeyPairName=YOUR_EC2_KEY_PAIR
   ```

3. Read stack outputs. Visit the public gateway URL. Open the admin dashboard using the `SSHTunnel` output, then browse to `http://localhost:9090/dashboard`.
4. Generate short-lived review tokens on the workstation. Do not copy the signing private key to EC2, Secrets Manager, the container, or the repository.
5. For rotation, add the next public key under a new `kid` while retaining the old key during transition. Update the secret, call `POST /admin/v1/secrets/refresh` through the tunnel, confirm `secret_revision`, then remove the old key after existing tokens have expired.

The instance role grants only `secretsmanager:GetSecretValue` on the configured secret ARN. EC2 requires IMDSv2; the token hop limit is 2 so the gateway container can retrieve the instance role credentials. No static AWS access key is required. The stack opens TCP 8080 publicly and SSH only from the supplied CIDR. Admin port 9090 is not exposed in the security group.

## Fault injection, tests, and benchmarks

The fault controls are reachable only over the private Compose network. Use the supplied driver:

```sh
scripts/fault-demo.sh
docker compose stop upstream-v2
docker compose start upstream-v2
```

The review smoke checks and E2E reload/JWT/fault run produce local files under the ignored `evidence/` directory:

```sh
scripts/review-smoke.sh
JWT_VALID_TOKEN="$(go run ./cmd/jwtgen token -private "$HOME/.config/dynamic-l7/review-signing-private.pem")" scripts/e2e-tests.sh
```

The full benchmark matrix takes about 45 minutes at the default schedule (four scenarios, three rates, three repetitions, 15-second warm-up plus 60-second measurement) and is intended for the larger `c7g.large` performance profile. Do not run it on the low-cost `t3.micro` demo host. Run from a benchmark host after exporting a short-lived `JWT_BENCH_TOKEN`:

```sh
JWT_BENCH_TOKEN="$(go run ./cmd/jwtgen token -private "$HOME/.config/dynamic-l7/review-signing-private.pem")" scripts/benchmark-matrix.sh
python3 scripts/summarize-benchmarks.py
```

The matrix records raw request counts, errors, achieved rate, p50/p95/p99 latency, active container list, and container CPU/memory snapshots. Benchmarks on one EC2 instance include shared-host and network-stack effects. For credible comparisons, keep the instance type, region, container limits, and test inputs fixed; preserve raw results if a target is missed.

## Teardown

Stop and remove the stack and delete its secret after preserving required review evidence:

```sh
aws cloudformation delete-stack --stack-name dynamic-l7-review
aws secretsmanager delete-secret --secret-id dynamic-l7/jwt-verification --recovery-window-in-days 7
```

The secret deletion command uses a seven-day recovery window. If the review policy requires immediate permanent deletion, follow the institution's approved secret handling process.
