#!/bin/sh
# Element redirects mobile browsers to its native-app marketing page before it
# loads config.json. Open Suite supports the web client on mobile, so establish
# Element's own opt-out cookie in the initial HTML response and redirect stale
# /mobile_guide bookmarks back to the application.
set -eu

config="${1:?nginx template path required}"
cookie='element_mobile_redirect_to_guide=false; Path=/; Max-Age=31536000; SameSite=Lax; Secure'

[ -f "${config}" ] || { echo "Element nginx template not found" >&2; exit 1; }
grep -F 'location = /index.html {' "${config}" >/dev/null
! grep -F 'element_mobile_redirect_to_guide=false' "${config}" >/dev/null

patched="$(mktemp)"
trap 'rm -f "${patched}"' EXIT
awk -v cookie="${cookie}" '
  $0 == "    location = /index.html {" {
    getline cache
    getline closing_line
    if (cache != "        add_header Cache-Control \"no-cache\";" || closing_line != "    }") exit 2
    print "    location = / {"
    print "        add_header Cache-Control \"no-cache\";"
    print "        add_header Set-Cookie \"" cookie "\";"
    print "        try_files /index.html =404;"
    print "    }"
    print "    location ~ ^/mobile_guide/?$ {"
    print "        add_header Cache-Control \"no-cache\";"
    print "        add_header Set-Cookie \"" cookie "\";"
    print "        return 302 /;"
    print "    }"
    print "    location = /index.html {"
    print "        add_header Cache-Control \"no-cache\";"
    print "        add_header Set-Cookie \"" cookie "\";"
    print "    }"
    replaced = 1
    next
  }
  { print }
  END { if (replaced != 1) exit 3 }
' "${config}" > "${patched}"
mv "${patched}" "${config}"
chmod 0644 "${config}"

[ "$(grep -Fc 'element_mobile_redirect_to_guide=false' "${config}")" -eq 3 ]
grep -F 'location ~ ^/mobile_guide/?$ {' "${config}" >/dev/null
[ "$(LC_ALL=C ls -l "${config}" | cut -c1-10)" = "-rw-r--r--" ]
echo "Element mobile-web entry contract added to ${config}"
