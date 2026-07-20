#!/bin/sh
# Open Suite patches the built Element bundle in place (verification reminders,
# session lock, etc.) without changing the content-hashed bundle directory name.
# Browsers cache /bundles/<hash>/*.js as immutable, so a returning browser keeps
# serving the OLD patched bundle after we change a patch. Rename the bundle
# directory to a suffix derived from the patched contents, and rewrite every
# reference, so the URL changes exactly when our patched output changes (and
# stays stable when it does not). This makes patch changes reach browsers on the
# next load without a manual cache clear.
set -eu

APP="${1:-/app}"
app_js="$(find "${APP}/bundles" -name element-web-app.js | head -1)"
[ -n "${app_js}" ] || { echo "element-web-app.js not found under ${APP}/bundles" >&2; exit 1; }

dir="$(dirname "${app_js}")"
hash="$(basename "${dir}")"
init_js="$(find "${APP}/bundles" -name init.js | head -1)"
# Suffix reflects the final patched content of the two files we modify.
suffix="os$(cat "${app_js}" "${init_js}" | sha256sum | cut -c1-10)"
new="${hash}-${suffix}"

# Rewrite every textual reference to the old dir name, then move the directory.
# Restrict to text assets (html/js/css/map) to avoid touching wasm/binaries.
# `|| true` so a no-match batch (grep exit 1) does not trip set -e before mv.
refs="$(find "${APP}" -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.map' -o -name '*.json' \) \
  -exec grep -Il "${hash}" {} + 2>/dev/null || true)"
printf '%s\n' "${refs}" | while IFS= read -r f; do
    [ -n "${f}" ] || continue
    sed -i "s/${hash}/${new}/g" "${f}"
done
mv "${APP}/bundles/${hash}" "${APP}/bundles/${new}"

# Postconditions: index.html points at the new dir and the old one is gone.
grep -F "bundles/${new}/" "${APP}/index.html" >/dev/null
[ ! -d "${APP}/bundles/${hash}" ]
[ -f "${APP}/bundles/${new}/element-web-app.js" ]

echo "element bundle dir rehashed for cache-bust: ${hash} -> ${new}"
