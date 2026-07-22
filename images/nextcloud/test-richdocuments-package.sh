#!/usr/bin/env bash
# Verify the built app, not just the source checkout used to produce it.
set -euo pipefail

app_dir="${1:-richdocuments}"
info="${app_dir}/appinfo/info.xml"
bundle="${app_dir}/js/richdocuments-src_view_Viewer_vue.js"

test -f "${info}"
test -f "${bundle}"
grep -Fq '<version>11.0.1</version>' "${info}"
grep -Fq '<nextcloud min-version="34" max-version="34"/>' "${info}"

# Verify every packaged file against Nextcloud's signed SHA-512 manifest. This
# catches accidental source or generated-asset mutation after archive checks.
python3 - "${app_dir}" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

app = Path(sys.argv[1])
signature = json.loads((app / 'appinfo/signature.json').read_text())
for relative, expected in signature['hashes'].items():
    path = app / relative
    actual = hashlib.sha512(path.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f'package integrity mismatch: {relative}')
PY

# 11.0.0 called JSON.parse(undefined) for normal DAV nodes. The official
# 11.0.1 package must contain the upstream guard, while explicit no-download
# shares and unreadable nodes remain filtered by the same predicate.
grep -Fq 'e.attributes["share-attributes"]' "${bundle}"
grep -Eq '\?JSON\.parse\([^)]*\):\[\]' "${bundle}"
grep -Fq 'e.permissions&OC.PERMISSION_READ' "${bundle}"

# Ordinary PNG/JPEG uploads must remain in the explicit supported allowlist.
grep -Fq '"image/png","image/gif","image/jpeg","image/svg"' "${bundle}"
if grep -Fq '"image/*"' "${bundle}"; then
  echo "ERROR: richdocuments image picker unexpectedly uses a broad wildcard" >&2
  exit 1
fi

echo "richdocuments 11.0.1 picker package checks passed"
