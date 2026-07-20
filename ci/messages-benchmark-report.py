#!/usr/bin/env python3
"""Render one Messages fresh-install benchmark sample as Markdown."""

import csv
import json
import pathlib
import sys

milestones_path, first_use_path, output_path = map(pathlib.Path, sys.argv[1:])
rows = list(csv.DictReader(milestones_path.open()))
first_use = json.loads(first_use_path.read_text())
elapsed = {row["milestone"]: float(row["elapsed_seconds"]) for row in rows}


def duration(start, finish):
    return elapsed[finish] - elapsed[start]


phases = [
    ("PostgreSQL pod to Ready", duration("postgresql-pod-created", "postgresql-ready")),
    (
        "fixed database stability gate",
        duration("migration-db-stability-started", "migration-db-stability-passed"),
    ),
    ("Django migration execution", duration("migration-started", "migration-finished")),
    (
        "migration pod to durable Job completion",
        duration("migration-pod-created", "migration-job-complete"),
    ),
    ("backend pod to Ready", duration("backend-pod-created", "backend-ready")),
    ("frontend pod to Ready", duration("frontend-pod-created", "frontend-ready")),
    ("OpenSearch pod to Ready", duration("opensearch-pod-created", "opensearch-ready")),
]
dominant_phase, dominant_seconds = max(phases, key=lambda item: item[1])

lines = [
    "# Messages fresh-install benchmark",
    "",
    "Phase intervals overlap; they are not additive.",
    "",
    "| phase | duration |",
    "|---|---:|",
]
for name, seconds in phases:
    lines.append(f"| {name} | {seconds:.3f}s |")

lines += [
    "",
    f"Dominant measured phase: **{dominant_phase} ({dominant_seconds:.3f}s)**.",
    "",
    "| milestone | seconds from benchmark start | detail |",
    "|---|---:|---|",
]
for row in sorted(rows, key=lambda item: float(item["elapsed_seconds"])):
    lines.append(
        f"| {row['milestone']} | {float(row['elapsed_seconds']):.3f} | {row['detail']} |"
    )

lines += [
    "",
    "## First use from a clean browser",
    "",
    f"- Mail inbox usable: **{first_use['mail_first_usable_ms'] / 1000:.3f}s**",
    f"- Mail OIDC attempts: **{first_use['mail_oidc_attempts']}**",
    f"- First Matrix sync from Element navigation: **{first_use['matrix_first_sync_from_navigation_ms'] / 1000:.3f}s**",
    f"- First Matrix sync request: **{first_use['matrix_first_sync_request_ms'] / 1000:.3f}s**",
    f"- Session security checks: **{'pass' if first_use['session_security_verified'] else 'fail'}**",
    f"- Coordinated logout check: **{'pass' if first_use['logout_contract_verified'] else 'fail'}**",
    "",
]
output_path.write_text("\n".join(lines))
print(output_path.read_text())
