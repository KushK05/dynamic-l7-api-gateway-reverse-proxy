# Demo handoff: one EC2 host

This release keeps the existing Compose architecture and ports. No new managed
service, database, frontend build step or AWS permissions are needed. Build on
EC2 so Docker selects its architecture; do not copy a Mac-built image to x86 EC2.

## Update an existing deployment

Commit/push the reviewed changes first, or transfer the complete source checkout.
From the teammate's checkout on EC2, with Docker running:

```sh
git pull --ff-only
# Keep the existing .env and gateway-data volume.
LOAD_MAX_RPS=300 docker compose up --build -d
docker compose ps
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
curl -fsS http://127.0.0.1:8080/api/catalog/test
curl -fsS http://127.0.0.1:9090/admin/v1/history
curl -fsS http://127.0.0.1:9090/admin/v1/requests
```

Use `sudo docker` if that host requires it. Preserve your existing JWT public-key
configuration; private signing keys remain on the workstation. Never commit .env.
A conservative 300 RPS ceiling is suitable as a starting point for a small-host
demo, not a performance guarantee. Start at 20-50 RPS and check CPU/memory before
increasing. Busy/Break it are intentionally stressful; avoid them on small hosts.

## Dashboard access from a workstation

Restrict SSH to the presenter's IP. Keep port 9090 closed in the security group;
Compose already publishes it on host loopback only. Expose 8080 only as needed.

```sh
ssh -i /path/to/key.pem -N -L 9090:127.0.0.1:9090 ubuntu@EC2_PUBLIC_IP
```

Open http://localhost:9090/dashboard. New tools use same-origin admin requests;
they do not require a tunnel for port 8080 or any browser CORS changes.

## Rehearsal and acceptance checks

1. Confirm LIVE status, topology, KPIs and all four charts work.
2. Playground: GET /api/catalog/test, host demo.local. Inspect route, upstream,
   status, request ID and body. Try an unmatched path (404).
3. JWT: GET /api/secure/test without a token (401), then with a valid token signed
   using your existing jwtgen setup (200). An arbitrary token is not a valid JWT.
4. Recent requests: find these requests, filter route/status, pause/resume viewing.
   Only 200 completed proxy requests are retained; high load overwrites them fast.
5. Start low-rate traffic, edit catalog weights and verify the distribution changes.
6. History: compare the previous configuration, restore it and verify the revision
   increases. A stale preview must fail instead of overwriting another update.
7. Simulate a failure on one upstream, observe ejection, reset faults and verify
   recovery. This action simulates failure; it does not stop a container.
8. Exercise auto weight and a canary. Keep the initiating browser tab open for the
   canary and finish/rollback it before restoring configuration history.
9. Set traffic to Idle, clear faults, then recreate just the gateway to verify
   persistence (brief gateway downtime is expected):

```sh
docker compose up -d --force-recreate --no-deps gateway
curl -fsS http://127.0.0.1:9090/admin/v1/history
curl -fsS http://127.0.0.1:9090/admin/v1/config
```

Configuration and the last ten successful revisions (including active) survive
recreation in gateway-data. The initial revision is included from the first
successful update. Existing older config envelopes load without migration commands.
Request logs are memory-only and intentionally clear on restart. Playground
responses are capped at 64 KiB, its request JSON at 4 KiB, and execution at 5s.
It calls the proxy handler directly: it tests routes/authentication/resilience,
not public-listener health endpoints such as /healthz. JWTs entered in its password
field are not persisted by the application; clear them after the demo.

## Stop and recover

```sh
docker compose logs --tail=100 gateway
docker compose down
```

Normal shutdown retains state. **Do not use `down -v` or `down --volumes` during an
update**: those delete the active configuration and its history. Use reset commands
only when intentionally returning to the bootstrap demo. To roll back code, check
out the previously recorded commit and rebuild with the same volume; the config
file remains compatible with the prior version, which ignores history metadata.
