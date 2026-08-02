#!/bin/sh
# Element's build directory is content-addressed and patch-cache-bust.sh gives
# every changed Open Suite build a new suffix. Cache only files beneath that
# fingerprinted directory; mutable root files and unversioned overlays retain
# upstream's revalidation behavior.
set -eu

config="${1:?nginx template path required}"
location='    location ~ "^/bundles/[0-9A-Fa-f]{16,}(-os[0-9a-f]{10})?/" {'

[ -f "${config}" ] || { echo "Element nginx template not found" >&2; exit 1; }
[ "$(grep -Fc '    # redirect server error pages to the static page /50x.html' "${config}")" -eq 1 ] || {
  echo "Element nginx error-page anchor drifted" >&2
  exit 1
}
! grep -F 'max-age=31536000, immutable' "${config}" >/dev/null || {
  echo "Element nginx template already contains an immutable cache rule" >&2
  exit 1
}

patched="$(mktemp)"
trap 'rm -f "${patched}"' EXIT
awk -v location="${location}" '
  $0 == "    # redirect server error pages to the static page /50x.html" {
    print location
    print "        add_header Cache-Control \"public, max-age=31536000, immutable\";"
    print "    }"
    print ""
    inserted++
  }
  { print }
  END { if (inserted != 1) exit 2 }
' "${config}" > "${patched}"
mv "${patched}" "${config}"
chmod 0644 "${config}"

[ "$(grep -Fc "${location}" "${config}")" -eq 1 ]
[ "$(grep -Fc 'add_header Cache-Control "public, max-age=31536000, immutable";' "${config}")" -eq 1 ]
echo "Element fingerprinted-bundle cache header added to ${config}"
