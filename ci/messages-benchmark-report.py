#!/usr/bin/env python3
"""Render one Messages fresh-install benchmark sample as Markdown."""

import csv
import json
import pathlib
import sys

milestones_path, first_use_path, output_path = map(pathlib.Path, sys.argv[1:])
rows = list(csv.DictReader(milestones_path.open()))
first_use = json.loads(first_use_path.read_text())

lines = [
    "# Messages fresh-install benchmark",
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
    f"- First Matrix sync from Element navigation: **{first_use['matrix_first_sync_from_navigation_ms'] / 1000:.3f}s**",
    f"- First Matrix sync request: **{first_use['matrix_first_sync_request_ms'] / 1000:.3f}s**",
    f"- Session security checks: **{'pass' if first_use['session_security_verified'] else 'fail'}**",
    f"- Coordinated logout check: **{'pass' if first_use['logout_contract_verified'] else 'fail'}**",
    "",
]
output_path.write_text("\n".join(lines))
print(output_path.read_text())
