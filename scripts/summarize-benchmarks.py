#!/usr/bin/env python3
"""Turn raw benchmark reports into a compact Markdown report for project review."""
import json
import re
from collections import defaultdict
from pathlib import Path

# Accept only primary artifacts generated with the `-runN.json` naming contract.
# This deliberately excludes `.stdout.json` copies and unrelated E2E JSON files.
RUN_FILE = re.compile(
    r"^(?:(?P<profile>[a-z0-9]+)-)?"
    r"(?P<scenario>direct|proxy-no-jwt|proxy-jwt|proxy-reload)-"
    r"(?P<rps>\d+)-run(?P<repetition>\d+)\.json$"
)
SCENARIOS = (
    ("direct", "Direct upstream", "Baseline: upstream-v1 without the gateway."),
    ("proxy-no-jwt", "Gateway without JWT", "Routing and proxy forwarding only."),
    ("proxy-jwt", "Gateway with JWT", "Routing, proxy forwarding, and RS256 verification."),
    ("proxy-reload", "Gateway during reloads", "Traffic while route snapshots alternate."),
)


def format_ms(value):
    """Keep latency columns compact while preserving useful review detail."""
    return f"{value:.2f} ms"


def outcome(data):
    """Make healthy and failed runs immediately visible in Markdown."""
    if data["errors"] or data.get("revision_mismatches", 0):
        return "FAIL"
    return "PASS"


rows = []
for path in Path("evidence").glob("*.json"):
    match = RUN_FILE.fullmatch(path.name)
    if not match:
        continue
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        continue
    if "target_rps" not in data:
        continue
    rows.append(
        {
            "profile": match.group("profile") or "unlabeled",
            "scenario": match.group("scenario"),
            "repetition": int(match.group("repetition")),
            "data": data,
        }
    )

scenario_index = {name: index for index, (name, _, _) in enumerate(SCENARIOS)}
rows.sort(key=lambda row: (scenario_index[row["scenario"]], row["data"]["target_rps"], row["repetition"]))
profiles = ", ".join(sorted({row["profile"] for row in rows})) or "none"
lines = [
    "# Benchmark review summary",
    "",
    f"**Profile:** {profiles}  ",
    f"**Measured runs:** {len(rows)}  ",
    "**Scope:** One EC2 host running both the gateway and upstream containers. These are functional review results, not multi-host capacity results.",
    "",
    "## At a glance",
    "",
    "| Check | Result |",
    "|---|---:|",
    f"| Successful runs | {sum(outcome(row['data']) == 'PASS' for row in rows)} / {len(rows)} |",
    f"| Runs with request errors | {sum(row['data']['errors'] > 0 for row in rows)} |",
    f"| Runs with mixed revisions | {sum(row['data'].get('revision_mismatches', 0) > 0 for row in rows)} |",
    "",
]

# Group each test type so the review can explain it without decoding filenames.
by_scenario = defaultdict(list)
for row in rows:
    by_scenario[row["scenario"]].append(row)
for key, title, description in SCENARIOS:
    scenario_rows = by_scenario[key]
    if not scenario_rows:
        continue
    lines.extend(
        [
            f"## {title}",
            "",
            description,
            "",
            "| Target RPS | Achieved RPS | Errors | Mixed revisions | p50 | p95 | p99 | Result |",
            "|---:|---:|---:|---:|---:|---:|---:|---|",
        ]
    )
    for row in scenario_rows:
        data = row["data"]
        lines.append(
            f"| {data['target_rps']} | {data['achieved_rps']:.1f} | {data['errors']} | "
            f"{data.get('revision_mismatches', 0)} | {format_ms(data['p50_ms'])} | "
            f"{format_ms(data['p95_ms'])} | {format_ms(data['p99_ms'])} | {outcome(data)} |"
        )
    lines.append("")

# p95 is the concise comparison used to discuss proxy, JWT, and reload overhead.
by_rate = defaultdict(dict)
for row in rows:
    if row["repetition"] == 1:
        by_rate[row["data"]["target_rps"]][row["scenario"]] = row["data"]
lines.extend(
    [
        "## p95 comparison",
        "",
        "| Target RPS | Direct | Gateway | Gateway + JWT | Gateway during reloads |",
        "|---:|---:|---:|---:|---:|",
    ]
)
for rate in sorted(by_rate):
    results = by_rate[rate]
    lines.append(
        "| {} | {} | {} | {} | {} |".format(
            rate,
            format_ms(results["direct"]["p95_ms"]) if "direct" in results else "-",
            format_ms(results["proxy-no-jwt"]["p95_ms"]) if "proxy-no-jwt" in results else "-",
            format_ms(results["proxy-jwt"]["p95_ms"]) if "proxy-jwt" in results else "-",
            format_ms(results["proxy-reload"]["p95_ms"]) if "proxy-reload" in results else "-",
        )
    )
lines.extend(
    [
        "",
        "Raw JSON and matching `.resources.csv` snapshots remain in `evidence/` for audit.",
    ]
)

Path("evidence/benchmark-summary.md").write_text("\n".join(lines) + "\n")
print(f"wrote evidence/benchmark-summary.md with {len(rows)} primary runs")
