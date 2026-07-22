#!/usr/bin/env bash
# Verify the built app, not just the source checkout used to produce it.
set -euo pipefail

app_dir="${1:-richdocuments}"
package_state="${2:-prepare}"
info="${app_dir}/appinfo/info.xml"
bundle="${app_dir}/js/richdocuments-src_view_Viewer_vue.js"
source_map="${bundle}.map"
assets_controller="${app_dir}/lib/Controller/AssetsController.php"
asset_mapper="${app_dir}/lib/Db/AssetMapper.php"
routes="${app_dir}/appinfo/routes.php"

case "${package_state}" in
  prepare)
    # The acquisition workflow invokes this immediately after verifying and
    # extracting the pinned archive. Verify the complete signed package before
    # applying the exact distribution patch, then verify the resulting tree.
    bash "$0" "${app_dir}" upstream
    patch --fuzz=0 --no-backup-if-mismatch \
      -d "$(dirname "${app_dir}")" -p1 \
      < "$(dirname "${BASH_SOURCE[0]}")/patches/richdocuments-asset-mime.patch"
    bash "$0" "${app_dir}" patched
    exit
    ;;
  upstream|patched) ;;
  *) echo "usage: $0 [app-dir] [prepare|upstream|patched]" >&2; exit 2 ;;
esac

test -f "${info}"
test -f "${bundle}"
test -f "${source_map}"
test -f "${assets_controller}"
test -f "${asset_mapper}"
grep -Fq '<version>11.0.1</version>' "${info}"
grep -Fq '<nextcloud min-version="34" max-version="34"/>' "${info}"

# Before patching, verify every packaged file against Nextcloud's signed SHA-512
# manifest. Afterwards, keep verifying every unmodified file and require the
# one intentional controller mutation to have its exact deterministic hash.
python3 - "${app_dir}" "${package_state}" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

app = Path(sys.argv[1])
state = sys.argv[2]
signature = json.loads((app / 'appinfo/signature.json').read_text())
patched_file = 'lib/Controller/AssetsController.php'
patched_hash = '6f22679dfaebdd5c860b41b5898c5b30d91c952b9f432b2f6a43008e070fcc4e684ce0fe7a89b13564959ef57bb7393a2ee59701e244c0bf7328767a4b4f9560'
for relative, expected in signature['hashes'].items():
    path = app / relative
    actual = hashlib.sha512(path.read_bytes()).hexdigest()
    if state == 'patched' and relative == patched_file:
        if actual != patched_hash or actual == expected:
            raise SystemExit(f'patched package integrity mismatch: {relative}')
        continue
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

# Pin the complete asset handoff contract. The GET is intentionally public at
# the realm-session layer but constrained to the WOPI source allowlist, a
# 64-character one-use token, and a ten-minute lifetime. It must stream the
# original bytes; replacing this with a redirect/login/error response yields
# Collabora's misleading "Unknown image format" dialog.
grep -Fq "['name' => 'assets#get', 'url' => 'assets/{token}', 'verb' => 'GET']" "${routes}"
grep -Fq '#[RestrictToWopiServer]' "${assets_controller}"
grep -Fq '* @PublicPage' "${assets_controller}"
grep -Fq "if (\$this->request->getMethod() === 'GET')" "${assets_controller}"
grep -Fq '$this->assetMapper->delete($asset);' "${assets_controller}"
grep -Fq "new StreamResponse(\$node->fopen('rb'))" "${assets_controller}"
grep -Fq "addHeader('Content-Disposition', 'attachment')" "${assets_controller}"
grep -Fq 'public const TOKEN_TTL = 600;' "${asset_mapper}"
grep -Fq 'setToken($this->random->generate(64,' "${asset_mapper}"
grep -Fq 'ISecureRandom::CHAR_UPPER . ISecureRandom::CHAR_LOWER . ISecureRandom::CHAR_DIGITS' "${asset_mapper}"

if [ "${package_state}" = upstream ]; then
  grep -Fq "addHeader('Content-Type', 'application/octet-stream')" "${assets_controller}"
else
  grep -Fq '$mimeType = $node->getMimeType();' "${assets_controller}"
  grep -Fq "addHeader('Content-Type', \$mimeType !== '' ? \$mimeType : 'application/octet-stream')" "${assets_controller}"
  if grep -Fq "addHeader('Content-Type', 'application/octet-stream')" "${assets_controller}"; then
    echo "ERROR: normal richdocuments assets still have a hard-coded generic MIME" >&2
    exit 1
  fi
fi

# The signed production source map is part of the shipped app. Verify the
# browser sends the returned asset URL unchanged in Action_InsertGraphic,
# rather than checking only that those unrelated strings occur in a minified
# bundle.
python3 - "${source_map}" <<'PY'
import json
from pathlib import Path
import sys

source_map = json.loads(Path(sys.argv[1]).read_text())
sources = dict(zip(source_map['sources'], source_map['sourcesContent']))
files = sources['webpack:///richdocuments/src/view/FilesAppIntegration.js']
office = sources['webpack:///richdocuments/src/view/Office.vue']
for literal in (
    "axios.post(generateUrl('apps/richdocuments/assets'), { path })",
    'insertFileProc(filename, data.url)',
):
    if literal not in files:
        raise SystemExit(f'missing packaged asset handoff: {literal}')
for literal in (
    "case 'UI_InsertGraphic':",
    "sendWOPIPostMessage(FRAME_DOCUMENT, 'Action_InsertGraphic'",
    'filename,\n\t\t\t\t\t\turl,',
):
    if literal not in office:
        raise SystemExit(f'missing packaged Collabora handoff: {literal}')
PY

echo "richdocuments 11.0.1 ${package_state} picker package checks passed"
