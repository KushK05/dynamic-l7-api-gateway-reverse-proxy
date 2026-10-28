#!/usr/bin/env python3
"""Build a compact comparison from benchmark JSON files in evidence/."""
import glob
import json
from pathlib import Path

rows = []
for name in sorted(glob.glob("evidence/*-run*.json")):
    try:
        data = json.loads(Path(name).read_text())
    except (OSError, json.JSONDecodeError):
        continue
    if "target_rps" in data:
        rows.append((Path(name).name, data))

lines = [
    "# Benchmark summary",
    "",
    "Generated from raw per-run JSON. Matching `.resources.csv` files record container CPU and memory.",
    "",
    "| Run | Target RPS | Achieved RPS | Errors | Revision mismatches | p50 ms | p95 ms | p99 ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
]
for name, d in rows:
    lines.append(
        f"| {name} | {d['target_rps']} | {d['achieved_rps']:.1f} | {d['errors']} | "
        f"{d.get('revision_mismatches', 0)} | {d['p50_ms']:.2f} | {d['p95_ms']:.2f} | {d['p99_ms']:.2f} |"
    )
Path("evidence/benchmark-summary.md").write_text("\n".join(lines) + "\n")
print(f"wrote evidence/benchmark-summary.md with {len(rows)} runs")
