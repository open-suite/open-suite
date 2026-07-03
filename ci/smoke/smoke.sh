#!/usr/bin/env bash
# Usage: ./smoke.sh <domain>          (e.g. ./smoke.sh demo.opensuite.online)
#
# Unauthenticated smoke test of an assembled Open Suite stack. Asserts the
# edge auth gate is closed (including the Bearer-bypass regression), identity
# is up, and the login flow reaches Keycloak. Run authenticated.mjs afterwards
# for the logged-in assertions (portal, header, calendar, meetcal, apps).
#
# Exit code 0 = all checks pass. Each failure prints FAIL and the script
# continues, so one run reports everything.
set -uo pipefail

DOMAIN="${1:?Usage: $0 <domain>}"
FAILURES=0

check() { # check <name> <expected> <actual>
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: expected ${expected}, got ${actual}"
    FAILURES=$((FAILURES + 1))
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
redirect() { curl -s -o /dev/null -w '%{redirect_url}' --max-time 20 "$@"; }

# matrix.<domain> only routes /_matrix API paths (Traefik 404s on /), so it
# has no meaningful unauthenticated probe here.
GATED_HOSTS=(bridge nextcloud docs meet grist element)

echo "== Gate is closed on every workspace host"
for h in "${GATED_HOSTS[@]}"; do
  url="https://${h}.${DOMAIN}/"
  loc="$(redirect "$url")"
  case "$loc" in
    "https://auth.${DOMAIN}/login"*) echo "ok   ${h}. redirects to gate" ;;
    *) echo "FAIL ${h}.: expected redirect to gate login, got '${loc}' (HTTP $(code "$url"))"
       FAILURES=$((FAILURES + 1)) ;;
  esac
done

echo "== Bearer bypass stays fixed (garbage token must NOT open the curtain)"
for h in bridge nextcloud; do
  url="https://${h}.${DOMAIN}/"
  loc="$(redirect -H 'Authorization: Bearer garbage' "$url")"
  case "$loc" in
    "https://auth.${DOMAIN}/login"*) echo "ok   ${h}. still gated with a bogus Bearer" ;;
    *) echo "FAIL ${h}.: bogus Bearer was not redirected to the gate (got '${loc}')"
       FAILURES=$((FAILURES + 1)) ;;
  esac
done

echo "== Identity and gate health"
check "id. realm endpoint"   200 "$(code "https://id.${DOMAIN}/realms/mijnbureau")"
check "auth. healthz"        200 "$(code "https://auth.${DOMAIN}/healthz")"

echo "== Login flow reaches Keycloak"
loc="$(redirect "https://auth.${DOMAIN}/login?rd=https://bridge.${DOMAIN}/")"
case "$loc" in
  "https://id.${DOMAIN}/realms/mijnbureau/protocol/openid-connect/auth"*)
    echo "ok   gate /login redirects to Keycloak authorize"
    # Follow it: the Keycloak login page itself must render (200, contains the
    # login form) — catches cert, ingress and realm-import breakage.
    page="$(curl -s -L --max-time 20 "https://auth.${DOMAIN}/login?rd=https://bridge.${DOMAIN}/")"
    if printf '%s' "$page" | grep -q 'kc-form-login\|id="kc-form"'; then
      echo "ok   Keycloak login form renders"
    else
      echo "FAIL Keycloak login form did not render"
      FAILURES=$((FAILURES + 1))
    fi
    ;;
  *) echo "FAIL gate /login: expected Keycloak authorize redirect, got '${loc}'"
     FAILURES=$((FAILURES + 1)) ;;
esac

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "SMOKE PASS (unauthenticated)"
else
  echo "SMOKE FAIL: ${FAILURES} check(s) failed"
  exit 1
fi
