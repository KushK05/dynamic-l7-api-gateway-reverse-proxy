# Live demo run sheet (10 to 12 minutes)

This is the presenter script for the live dashboard. Each beat lists what to click and what to say. Times are cumulative targets. For the longer reviewer runbook and Q&A, see [REVIEW-GUIDE.md](REVIEW-GUIDE.md).

## Setup (before the audience arrives)

Recommended host: EC2 `t3.large` (2 vCPU, 8 GiB). It runs the gateway plus 11 mock upstream containers and the built-in load generator comfortably. A `t3.micro` still works for light traffic (use Steady or lower, not Busy or Break it).

1. Start the stack with the demo config (`config/demo.json` is the Compose default). To get the valid-token JWT beats, pass a token for the load generator:

   ```sh
   # on your workstation: mint a token (see README "Configure a local JWT key set")
   TOKEN="$(go run ./cmd/jwtgen token -private "$HOME/.config/dynamic-l7/review-signing-private.pem" \
     -kid review-1 -issuer dynamic-l7-review -audience dynamic-l7-gateway)"
   # on the host, in the repo directory
   docker compose down -v          # start from a clean persisted config
   JWT_KEYS_JSON="$(cat jwt-keys.secret.json)" LOADGEN_BEARER_TOKEN="$TOKEN" docker compose up --build -d
   ```

   Persisted state in the `gateway-data` volume overrides the bootstrap config, so always run `docker compose down -v` before a fresh demo. Tokens are short-lived: mint a new one right before presenting.
2. Open the SSH tunnel from your laptop and browse to the dashboard:

   ```sh
   ssh -i <key.pem> -L 9090:127.0.0.1:9090 ec2-user@<EC2_DNS>
   open http://localhost:9090/dashboard
   ```

   Use a full-screen browser at 1920x1080 or 1366x768. The header pill should read LIVE.
3. In a second terminal on the host, have the data-plane URL ready: `GW=http://127.0.0.1:8080` (or the EC2 public DNS on port 8080).
4. Sanity check: `scripts/review-smoke.sh` passes, and Reset all faults has been clicked once.

## What is in the demo config

`config/demo.json` is a superset of `config/config.json`. JSON cannot hold comments, so the structure is described here.

| Route | Priority | Match | Upstreams (weight) | Notes |
|---|---|---|---|---|
| `catalog` | 100 | GET,HEAD `/api/catalog` | v1 100, v2 0 | `catalog-v3` is in the known list but in no route |
| `checkout` | 90 | POST `/api/checkout` | v1 100 | JWT required |
| `secure-read` | 80 | GET,HEAD `/api/secure` | v1 100 | JWT required |
| `users` | 70 | GET `/api/users` | users-a 50, users-b 50 | `auto_weight` on |
| `orders` | 60 | GET,POST `/api/orders` | orders-a 90, orders-b 10 | orders-b is slow |
| `search` | 50 | GET `/api/search` | search-a 70, search-b 30 | retry 1, search-b is slowest |
| `inventory` | 45 | GET `/api/inventory` with header `X-Region: eu` | inventory-eu 100 | higher priority than the default |
| `inventory-default` | 40 | GET `/api/inventory` | inventory-us 100 | catches everything else |

Priorities are unique. `inventory-default` has the same path as `inventory` but a lower priority, so the header rule is checked first and does not get shadowed. Mock upstream latency is set in `docker-compose.yml` (base delay plus jitter, about 2 to 60 ms), so each upstream has a visibly different latency.

## Beats

### 1. Tour the topology (0:00 - 1:30)

Click nothing yet. Point at the layout: Clients on the left, then the Gateway, then Routes by priority, then Upstreams. Say: "Every card is live. The route cards show the match rule, the upstream cards show their health and latency. The edges carry the real weight split, and the dots flowing along them are requests." Point out the KPI strip (Throughput, Success rate, Latency p50/p95/p99, Errors 5xx, In-flight, JWT rejections) and the Config revision chip in the header.

### 2. Start Steady traffic (1:30 - 2:30)

In Traffic control, click the Steady preset (150 rps), then Start. Say: "The load generator lives inside the gateway and only calls its own public data plane, so every number you see is real proxy traffic." Watch the dots speed up, the KPIs fill in, and the Throughput and Latency charts start drawing. Note that orders-b and search-b show higher latency than their siblings.

### 3. Header-based routing (2:30 - 3:45)

Find the `inventory` and `inventory-default` route cards. Say: "Same path, two routes. The higher priority one only matches when the request carries `X-Region: eu`." Then show it from the terminal:

```sh
curl -si "$GW/api/inventory/items" | grep -i x-upstream-id                    # inventory-us
curl -si -H 'X-Region: eu' "$GW/api/inventory/items" | grep -i x-upstream-id   # inventory-eu
```

Note for the audience: the built-in load generator copies a route's header match onto its requests, so generated `inventory` traffic always carries `X-Region: eu` and lands on inventory-eu. The US route only sees traffic when you curl without the header. In the route mix you can give `inventory-default` a share too, but remember it sends the plain request, which is exactly the US case.

### 4. Weights and live shift (3:45 - 5:00)

In the Routes panel, find `orders` (90/10). Drag the orders-b slider up: the paired slider moves so the total stays 100. Click Apply. Say: "That is a validated, fsynced, atomic config update with an If-Match revision check; the revision chip just ticked." Watch the edges re-balance in the topology and the Upstream traffic chart shift. Click Even split and Apply for a clean 50/50. Optional: open Config JSON to show the same change as a document.

### 5. Progressive canary and rollback (5:00 - 6:30)

On `catalog`, pick v2 as the canary target and click Start canary (or the Canary rollout scenario). It steps 10, 25, 50, 100 percent every 8 seconds. Say: "Each step is a normal config update." Midway, click Rollback and watch weights snap back to the baseline. Point at the event feed (filter: Config) and the chart markers.

### 6. Add a route live with catalog-v3 (6:30 - 7:45)

Click Add route. Route ID `catalog-next`, priority `95`, method GET, path prefix `/api/next`, rewrite prefix `/api/next`, timeout 1500. Add upstream `catalog-v3` (it is in the known-upstreams dropdown, URL `http://catalog-v3:9103`) at weight 100, then Add route. Say: "No restart. The new route and the catalog-v3 node just appeared in the topology." Then `curl -si "$GW/api/next/ok" | grep -i x-upstream-id` shows `catalog-v3`. In Traffic control, give the new route a share in Route mix if you like.

### 7. JWT rejections (7:45 - 8:30)

```sh
curl -si "$GW/api/secure/profile" | head -1                                   # 401
curl -si -H "Authorization: Bearer $TOKEN" "$GW/api/secure/profile" | head -1  # 200
```

Then raise Invalid JWT in Traffic control to about 20 percent. Say: "The generator sends a bad token for that share of requests." Watch the JWT rejections KPI climb and 401s appear in the Throughput chart. Set it back to 0. Without `LOADGEN_BEARER_TOKEN`, JWT routes see only invalid tokens, so this beat still works.

### 8. Slow upstream and auto weight (8:30 - 9:30)

`users` has Auto weight on (AUTO badge). Select upstream users-a in the Scenarios upstream picker (or click its card in the topology) and click Slow upstream (+800 ms). Say: "Auto weight is a runtime overlay. The configured 50/50 is the baseline; the gateway shifts effective weights away from the slow target without creating a config revision." Watch users-a's edge thin out and users-b take over, and the Weights events in the feed. Click Reset all faults and watch it drift back.

### 9. Kill an upstream, ejection, recovery (9:30 - 10:45)

Pick `orders-a` (it carries 90 percent of orders) and click Kill upstream. Say: "The gateway's active probes fail twice, then it ejects the target." Watch the card turn to ejected, the 5xx KPI blip, and the event feed log the ejection. Then click Reset all faults: after the 3 second cooldown and a good probe, the target returns. Point at the event feed for the full timeline.

### 10. Break it (10:45 - 11:45)

Click the Break it preset: the rate ramps to the maximum over 60 seconds. Say: "Let us find the weak spot." Watch latency p95/p99 and Shed by generator climb; on a t3.large the slow upstreams (search-b, orders-b) and the generator's own concurrency limit show strain first, then the Error rate chart rises. Click Cancel in the ramp readout (or the Idle preset) to stop. Do not run this on a `t3.micro`.

### 11. Reset (11:45 - 12:00)

Click Idle, then Reset all faults. For a full return to the bootstrap config run `docker compose down -v` (it deletes the `gateway-data` volume and the persisted config). Wrap up with the revision history in the event feed.

## Troubleshooting

- **Dashboard shows CONNECTING or stale:** the SSH tunnel dropped; reconnect it. The page reconnects by itself.
- **Config looks old after `up`:** the persisted volume overrides `config/demo.json`. Run `docker compose down -v` and start again.
- **JWT routes return 401 for valid-looking tokens:** the token expired or `JWT_KEYS_JSON` is not set on the gateway container; mint a fresh token and restart with both variables.
- **Generated JWT traffic all 401:** `LOADGEN_BEARER_TOKEN` was not passed to `docker compose up`; recreate the gateway with it set.
- **Start does nothing or rate is capped:** the generator caps at `-load-max-rps` (default 3000, set with `LOAD_MAX_RPS`); the target is also limited by concurrency.
- **Mutating call returns 415:** admin writes need `Content-Type: application/json`.
- **412 on a config save:** someone else changed the config; reload the dashboard and retry.
- **Port 8080 or 9090 busy locally:** `GATEWAY_PORT=18080 ADMIN_PORT=19090 docker compose up -d`.
- **Containers restart on a t3.micro:** use `config/config.json` (`GATEWAY_CONFIG=./config/config.json`) and light traffic, or move to a larger instance type.
