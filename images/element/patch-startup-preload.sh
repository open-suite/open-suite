#!/bin/sh
set -eu

APP="${1:-/app}"
html="${APP}/index.html"
wasm="$(find "${APP}/bundles" -name 'e5ee*.wasm' -type f)"

[ -f "${html}" ] || { echo "Element index.html not found" >&2; exit 1; }
[ "$(printf '%s\n' "${wasm}" | sed '/^$/d' | wc -l)" -eq 1 ] || {
  echo "Expected exactly one e5ee WebAssembly bundle" >&2
  exit 1
}

wasm_path="/${wasm#${APP}/}"
! grep -F "href=\"${wasm_path}\"" "${html}" >/dev/null

WASM_PATH="${wasm_path}" perl -0pi -e '
  s#</head>#<link rel="preload" href="$ENV{WASM_PATH}" as="fetch" type="application/wasm" crossorigin="anonymous">\n</head>#
' "${html}"

grep -F "<link rel=\"preload\" href=\"${wasm_path}\" as=\"fetch\" type=\"application/wasm\" crossorigin=\"anonymous\">" "${html}" >/dev/null
echo "Element WebAssembly startup preload added for ${wasm_path}"
