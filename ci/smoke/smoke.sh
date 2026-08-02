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
# SMOKE_INSECURE=1: tolerate self-signed certs (local VM deploys).
CURL_K=""
[ "${SMOKE_INSECURE:-0}" = "1" ] && CURL_K="-k"
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

code() { curl -s ${CURL_K} -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
redirect() { curl -s ${CURL_K} -o /dev/null -w '%{redirect_url}' --max-time 20 "$@"; }

docs_json_boundary_probe() { # probe <name> <method> <path> [authorization]
  local name="$1" method="$2" path="$3" authorization="${4:-}"
  local headers body status
  headers="$(mktemp)"
  body="$(mktemp)"
  if [ -n "${authorization}" ]; then
    status="$(curl -sS ${CURL_K} -D "${headers}" -o "${body}" -w '%{http_code}' \
      --max-time 20 -X "${method}" -H "Authorization: ${authorization}" \
      "https://docs.${DOMAIN}${path}")"
  else
    status="$(curl -sS ${CURL_K} -D "${headers}" -o "${body}" -w '%{http_code}' \
      --max-time 20 -X "${method}" "https://docs.${DOMAIN}${path}")"
  fi

  check "${name} status" 401 "${status}"
  if grep -qi '^content-type: application/json' "${headers}" \
    && python3 - "${body}" <<'PY'
import json
import pathlib
import sys

body = json.loads(pathlib.Path(sys.argv[1]).read_text())
if not isinstance(body, dict) or not isinstance(body.get("error"), str):
    raise SystemExit(1)
PY
  then
    echo "ok   ${name} returns a JSON error"
  else
    echo "FAIL ${name}: response is not the y-provider JSON error contract"
    FAILURES=$((FAILURES + 1))
  fi
  if grep -qi '^location:' "${headers}"; then
    echo "FAIL ${name}: machine API response contains an OIDC Location"
    FAILURES=$((FAILURES + 1))
  else
    echo "ok   ${name} has no OIDC Location"
  fi
  if grep -qi '^strict-transport-security:.*max-age=' "${headers}"; then
    echo "ok   ${name} retains HSTS"
  else
    echo "FAIL ${name}: Strict-Transport-Security is missing"
    FAILURES=$((FAILURES + 1))
  fi
  rm -f "${headers}" "${body}"
}

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

echo "== Matrix client API is reachable (Element breaks if the gate eats it)"
check "matrix client versions" 200 "$(code "https://matrix.${DOMAIN}/_matrix/client/versions")"

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
    page="$(curl -s ${CURL_K} -L --max-time 20 "https://auth.${DOMAIN}/login?rd=https://bridge.${DOMAIN}/")"
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

if [ "${SMOKE_DOCS_COLLABORATION_BOUNDARY:-0}" = "1" ]; then
  echo "== Docs collaboration machine API boundary"
  get_path='/collaboration/api/get-connections/?room=opensuite-boundary-probe&sessionKey=probe'
  reset_path='/collaboration/api/reset-connections/?room=opensuite-boundary-probe'
  docs_json_boundary_probe "get-connections without credentials" GET "${get_path}"
  docs_json_boundary_probe "get-connections with wrong credentials" GET "${get_path}" "wrong-key"
  docs_json_boundary_probe "reset-connections without credentials" POST "${reset_path}"
  docs_json_boundary_probe "reset-connections with wrong credentials" POST "${reset_path}" "wrong-key"

  echo "== Adjacent y-provider routes remain behind browser auth"
  for path in /ping /api/convert/; do
    loc="$(redirect "https://docs.${DOMAIN}${path}")"
    case "${loc}" in
      "https://auth.${DOMAIN}/login"*) echo "ok   ${path} redirects to browser auth" ;;
      *) echo "FAIL ${path}: expected browser auth redirect, got '${loc}'"
         FAILURES=$((FAILURES + 1)) ;;
    esac
  done

  echo "== Valid collaboration secret reaches the y-provider"
  collaboration_secret="$(kubectl -n mb-docs get secret docs \
    -o jsonpath='{.data.COLLABORATION_SERVER_SECRET}' | base64 -d)"
  if [ -z "${collaboration_secret}" ]; then
    echo "FAIL valid collaboration secret: deployed secret is empty"
    FAILURES=$((FAILURES + 1))
  else
    headers="$(mktemp)"
    body="$(mktemp)"
    auth_header="$(mktemp)"
    chmod 600 "${auth_header}"
    printf 'Authorization: %s\n' "${collaboration_secret}" > "${auth_header}"
    status="$(curl -sS ${CURL_K} -D "${headers}" -o "${body}" -w '%{http_code}' \
      --max-time 20 -H @"${auth_header}" \
      "https://docs.${DOMAIN}${get_path}")"
    if [ "${status}" = "404" ] \
      && grep -qi '^content-type: application/json' "${headers}" \
      && ! grep -qi '^location:' "${headers}" \
      && python3 - "${body}" <<'PY'
import json
import pathlib
import sys

body = json.loads(pathlib.Path(sys.argv[1]).read_text())
if body.get("error") != "Room not found":
    raise SystemExit(1)
PY
    then
      echo "ok   valid collaboration secret reaches y-provider JSON"
    else
      echo "FAIL valid collaboration secret: expected y-provider JSON 404 without redirect, got HTTP ${status}"
      FAILURES=$((FAILURES + 1))
    fi
    rm -f "${headers}" "${body}" "${auth_header}"
    unset collaboration_secret
  fi
fi

# The bare apex has no app; it must 301 to the portal. In secure mode redirect()
# curls without -k, so an untrusted apex cert (Traefik's default self-signed,
# ERR_CERT_AUTHORITY_INVALID) makes this fail with an empty result — the check
# covers both the cert and the redirect. SMOKE_INSECURE relaxes the cert.
echo "== Apex redirects to the portal (with a valid cert in secure mode)"
check "apex -> bridge redirect" "https://bridge.${DOMAIN}/" "$(redirect "https://${DOMAIN}/")"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "SMOKE PASS (unauthenticated)"
else
  echo "SMOKE FAIL: ${FAILURES} check(s) failed"
  exit 1
fi
