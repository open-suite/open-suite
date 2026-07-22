#!/bin/sh
# Compiled equivalent of patches/replace-sso-history.patch for the pinned
# upstream image. Element's BasePlatform starts both immediate and explicit
# legacy SSO by assigning location.href. Replacing that entry prevents the
# pre-SSO Element route from sitting between Portal and the cleaned callback.
set -eu

APP="${1:-/app}"
init_js="$(find "${APP}/bundles" -name init.js | head -1)"
[ -n "${init_js}" ] || { echo "init.js not found under ${APP}/bundles" >&2; exit 1; }

before='const o=this.getSSOCallbackUrl(n);window.location.href=e.getSsoLoginUrl(o.toString(),t,r,i)'
after='const o=this.getSSOCallbackUrl(n);window.location.replace(e.getSsoLoginUrl(o.toString(),t,r,i))'

# Require one exact BasePlatform match: the other location.href assignments in
# this bundle belong to unrelated OAuth/logout paths and must remain untouched.
[ "$(grep -Fo "${before}" "${init_js}" | wc -l)" -eq 1 ]
! grep -F "${after}" "${init_js}" >/dev/null

BEFORE="${before}" AFTER="${after}" perl -0pi -e '
    $before = quotemeta($ENV{BEFORE});
    s/$before/$ENV{AFTER}/g;
' "${init_js}"

! grep -F "${before}" "${init_js}" >/dev/null
[ "$(grep -Fo "${after}" "${init_js}" | wc -l)" -eq 1 ]

echo "element-web outgoing SSO navigation now replaces browser history"
