#!/bin/sh
# Element's content-hashed bundles are immutable for the life of an image.
# Compress them once during the image build instead of spending nginx CPU on
# the same gzip work for every cold request.
set -eu

APP="${1:-/app}"
bundles="$(find "${APP}/bundles" -mindepth 1 -maxdepth 1 -type d)"

[ "$(printf '%s\n' "${bundles}" | sed '/^$/d' | wc -l)" -eq 1 ] || {
  echo "Expected exactly one content-hashed Element bundle directory" >&2
  exit 1
}
! find "${bundles}" -type f -name '*.gz' | grep -q . || {
  echo "Element bundle already contains precompressed files" >&2
  exit 1
}
! find "${APP}" -type f -name '*.gz' ! -path "${bundles}/*" | grep -q . || {
  echo "Refusing to enable gzip_static with gzip files outside hashed bundles" >&2
  exit 1
}

find "${bundles}" -type f -size +1023c \
  \( -name '*.js' -o -name '*.css' -o -name '*.json' -o -name '*.svg' \
     -o -name '*.wasm' -o -name '*.xml' -o -name '*.txt' \) \
  -exec gzip -n -5 -k {} +

count="$(find "${bundles}" -type f -name '*.gz' | wc -l)"
[ "${count}" -gt 0 ] || { echo "No Element bundles were compressed" >&2; exit 1; }

find "${bundles}" -type f -name '*.gz' -exec sh -c '
  for compressed do
    gzip -t "${compressed}"
    gzip -cd "${compressed}" | cmp - "${compressed%.gz}"
  done
' sh {} +

echo "Precompressed ${count} content-hashed Element bundles"
