#!/usr/bin/env bash
# shellcheck disable=SC2016 # Helm and shell expressions below are intentional literals.
# Source and cluster contract checks for the five chart-owned self-signed TLS
# Secrets repaired here. With only <patched-infra-dir>, this is a static test.
# Passing a domain validates the live certificates; an optional baseline file
# detects certificate rotation across repeated deploys.
set -euo pipefail

INFRA="${1:?Usage: $0 <patched-infra-dir> [domain [fingerprint-baseline]]}"
DOMAIN="${2:-}"
BASELINE="${3:-}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_SCRIPT="${REPO}/scripts/single-vps-deploy/04-nextcloud-office.sh"
OIDC_RESTART_SCRIPT="${REPO}/scripts/single-vps-deploy/03-restart-oidc-apps.sh"

require_literal() {
  local file="$1" expected="$2"
  if ! grep -Fq -- "${expected}" "${file}"; then
    echo "ERROR: ${file} is missing: ${expected}" >&2
    exit 1
  fi
}

chart_paths=(
  bureaublad/charts/bureaublad
  collabora/charts/collabora
  docs/charts/docs
  element/charts/element-web
  messages/charts/messages
)

for chart_path in "${chart_paths[@]}"; do
  chart="${INFRA}/helmfile/apps/${chart_path}"
  tls_template="${chart}/templates/tls-secret.yaml"
  ingress_template="${chart}/templates/ingress.yaml"
  require_literal "${tls_template}" '.Values.ingress.selfSigned'
  require_literal "${tls_template}" '$secretName := printf "%s-tls" .Values.ingress.hostname'
  require_literal "${tls_template}" 'type: kubernetes.io/tls'
  require_literal "${tls_template}" 'tls.crt:'
  require_literal "${tls_template}" 'tls.key:'
  require_literal "${tls_template}" 'ca.crt:'
  require_literal "${ingress_template}" 'secretName: {{ printf "%s-tls" .Values.ingress.hostname'

  if [[ "${chart_path}" == messages/* ]]; then
    # The local Messages chart has no Bitnami common dependency, so it uses
    # Helm's lookup directly to preserve the first generated certificate.
    require_literal "${tls_template}" '$existingSecret := lookup "v1" "Secret" .Release.Namespace $secretName'
    require_literal "${tls_template}" 'tls.crt: {{ index $existingSecret.data "tls.crt" }}'
    require_literal "${tls_template}" 'tls.key: {{ index $existingSecret.data "tls.key" }}'
    require_literal "${tls_template}" 'ca.crt: {{ index $existingSecret.data "ca.crt" }}'
  else
    # common.secrets.lookup returns the live Secret value on upgrades instead
    # of replacing it with a newly generated CA/certificate on every render.
    for key in tls.crt tls.key ca.crt; do
      require_literal "${tls_template}" "common.secrets.lookup\" (dict \"secret\" \$secretName \"key\" \"${key}\""
    done
  fi
done

require_literal "${INFRA}/helmfile/apps/messages/charts/messages/values.yaml" 'selfSigned: false'
require_literal "${INFRA}/helmfile/apps/messages/values.yaml.gotmpl" \
  'selfSigned: {{ and .Values.global.tls.enabled .Values.global.tls.selfSigned | default false }}'

# The importer must consume the exact CA key from the API, reject empty or
# malformed data, and only then invoke Nextcloud's certificate import.
require_literal "${DEPLOY_SCRIPT}" "for source in mb-keycloak:id mb-collabora:collabora mb-meet:meet mb-nextcloud:nextcloud"
require_literal "${DEPLOY_SCRIPT}" "-o jsonpath='{.data.ca\\.crt}'"
require_literal "${DEPLOY_SCRIPT}" 'openssl x509 -in "${cert_file}" -noout -checkend 0'
require_literal "${DEPLOY_SCRIPT}" 'php occ security:certificates:import'
require_literal "${DEPLOY_SCRIPT}" 'kubectl rollout status deploy/traefik -n kube-system --timeout=300s'
require_literal "${DEPLOY_SCRIPT}" 'timeout --signal=TERM --kill-after=5s 15s'
require_literal "${DEPLOY_SCRIPT}" 'php occ richdocuments:activate-config'

# Synapse cannot consume the shared HTTP backchannel: Authlib validates the
# explicit provider metadata against RFC 8414 before exchanging a token. Its
# endpoints must follow the HTTPS issuer, and self-signed mode must add only
# the Keycloak CA without disabling TLS verification.
synapse_values="${INFRA}/helmfile/apps/element/values-synapse.yaml.gotmpl"
require_literal "${synapse_values}" 'token_endpoint: {{ printf "%s/protocol/openid-connect/token" .Values.authentication.oidc.issuer | quote }}'
require_literal "${synapse_values}" 'userinfo_endpoint: {{ printf "%s/protocol/openid-connect/userinfo" .Values.authentication.oidc.issuer | quote }}'
require_literal "${synapse_values}" 'jwks_uri: {{ printf "%s/protocol/openid-connect/certs" .Values.authentication.oidc.issuer | quote }}'
require_literal "${synapse_values}" 'name: SSL_CERT_FILE'
require_literal "${synapse_values}" 'value: /synapse/oidc-ca/ca.crt'
require_literal "${synapse_values}" 'name: synapse-keycloak-oidc-ca'
if grep -Eq 'skip_verification|use_insecure_ssl_client' "${synapse_values}"; then
  echo "ERROR: Synapse OIDC must not bypass metadata or TLS verification" >&2
  exit 1
fi
require_literal "${OIDC_RESTART_SCRIPT}" 'kubectl -n mb-keycloak get secret "id.${DOMAIN}-tls"'
require_literal "${OIDC_RESTART_SCRIPT}" "-o jsonpath='{.data.ca\\.crt}'"
require_literal "${OIDC_RESTART_SCRIPT}" 'openssl x509 -in "${ca_file}" -noout -checkend 0'
require_literal "${OIDC_RESTART_SCRIPT}" 'kubectl -n mb-element create configmap synapse-keycloak-oidc-ca'
require_literal "${OIDC_RESTART_SCRIPT}" 'kubectl rollout status deploy/coredns -n kube-system --timeout=300s'
require_literal "${OIDC_RESTART_SCRIPT}" 'kubectl rollout status deploy/traefik -n kube-system --timeout=300s'
require_literal "${OIDC_RESTART_SCRIPT}" 'kubectl rollout status deploy/synapse -n mb-element --timeout=300s'

if [ -z "${DOMAIN}" ]; then
  echo "Self-signed TLS source contracts verified"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
kubectl get ingress -A -o json > "${tmp}/ingresses.json"
python3 - "${tmp}/ingresses.json" > "${tmp}/ingress-secrets.tsv" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    ingresses = json.load(source)

references = set()
for ingress in ingresses["items"]:
    namespace = ingress["metadata"]["namespace"]
    for entry in ingress.get("spec", {}).get("tls", []):
        if secret := entry.get("secretName"):
            references.add((namespace, secret))

for namespace, secret in sorted(references):
    print(f"{namespace}\t{secret}")
PY

if [ ! -s "${tmp}/ingress-secrets.tsv" ]; then
  echo "ERROR: no Ingress TLS Secret references were rendered" >&2
  exit 1
fi

validate_certificate_key() {
  local namespace="$1" secret="$2" key="$3" escaped_key cert_file
  escaped_key="${key//./\\.}"
  cert_file="${tmp}/${namespace}-${secret}-${key}.pem"
  if ! kubectl get secret -n "${namespace}" "${secret}" \
      -o "jsonpath={.data.${escaped_key}}" | base64 -d > "${cert_file}" \
      || [ ! -s "${cert_file}" ] \
      || ! openssl x509 -in "${cert_file}" -noout -checkend 0 >/dev/null 2>&1; then
    echo "ERROR: ${namespace}/${secret} key ${key} is absent, empty, expired, or not a parseable certificate" >&2
    return 1
  fi
}

# Verify the namespace-local trust anchor is an exact, valid copy of the
# Keycloak ingress CA. The private key must remain confined to mb-keycloak.
keycloak_secret="id.${DOMAIN}-tls"
validate_certificate_key mb-keycloak "${keycloak_secret}" ca.crt
kubectl -n mb-keycloak get secret "${keycloak_secret}" \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > "${tmp}/keycloak-ca.pem"
kubectl -n mb-element get configmap synapse-keycloak-oidc-ca \
  -o jsonpath='{.data.ca\.crt}' > "${tmp}/synapse-keycloak-ca.pem"
if [ ! -s "${tmp}/synapse-keycloak-ca.pem" ] \
    || ! openssl x509 -in "${tmp}/synapse-keycloak-ca.pem" -noout -checkend 0 >/dev/null 2>&1 \
    || ! cmp -s "${tmp}/keycloak-ca.pem" "${tmp}/synapse-keycloak-ca.pem"; then
  echo "ERROR: Synapse's namespace-local OIDC CA is missing, invalid, or stale" >&2
  exit 1
fi

# Exercise the actual Synapse process environment: load its rendered OIDC
# metadata, verify JWKS over HTTPS with SSL_CERT_FILE, then hit the local SSO
# redirect endpoint without following the browser redirect to Keycloak.
kubectl rollout status deploy/synapse -n mb-element --timeout=300s >/dev/null
kubectl -n mb-element exec -i deploy/synapse -c synapse -- \
  python - "${DOMAIN}" <<'PY'
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

import yaml

domain = sys.argv[1]
issuer = f"https://id.{domain}/realms/mijnbureau"
expected = {
    "issuer": issuer,
    "authorization_endpoint": f"{issuer}/protocol/openid-connect/auth",
    "token_endpoint": f"{issuer}/protocol/openid-connect/token",
    "userinfo_endpoint": f"{issuer}/protocol/openid-connect/userinfo",
    "jwks_uri": f"{issuer}/protocol/openid-connect/certs",
}

with open("/synapse/config/homeserver.yaml", encoding="utf-8") as source:
    provider = yaml.safe_load(source)["oidc_providers"][0]
for key, value in expected.items():
    if provider.get(key) != value:
        raise SystemExit(f"Synapse OIDC {key} is not the expected HTTPS endpoint")
if os.environ.get("SSL_CERT_FILE") != "/synapse/oidc-ca/ca.crt":
    raise SystemExit("Synapse SSL_CERT_FILE does not select the mirrored Keycloak CA")

with urllib.request.urlopen(expected["jwks_uri"], timeout=15) as response:
    jwks = json.load(response)
if not jwks.get("keys"):
    raise SystemExit("Keycloak returned no OIDC signing keys")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

redirect_url = "https://element.{}/".format(domain)
sso_url = "http://127.0.0.1:8448/_matrix/client/v3/login/sso/redirect?" + urllib.parse.urlencode(
    {"redirectUrl": redirect_url}
)
request = urllib.request.Request(
    sso_url,
    headers={
        "Host": f"matrix.{domain}",
        "X-Forwarded-For": "127.0.0.1",
        "X-Forwarded-Proto": "https",
    },
)
opener = urllib.request.build_opener(NoRedirect())
try:
    opener.open(request, timeout=15)
except urllib.error.HTTPError as error:
    if error.code != 302:
        raise
    location = error.headers.get("Location", "")
    target = urllib.parse.urlparse(location)
    authorization = urllib.parse.urlparse(expected["authorization_endpoint"])
    params = urllib.parse.parse_qs(target.query)
    if (target.scheme, target.netloc, target.path) != (
        authorization.scheme,
        authorization.netloc,
        authorization.path,
    ):
        raise SystemExit("Synapse SSO redirect did not target Keycloak HTTPS")
    if params.get("client_id") != ["synapse"] or params.get("response_type") != ["code"]:
        raise SystemExit("Synapse SSO redirect did not preserve the OIDC authorization flow")
    callback = f"https://matrix.{domain}/_synapse/client/oidc/callback"
    if params.get("redirect_uri") != [callback]:
        raise SystemExit("Synapse SSO redirect did not use its canonical HTTPS callback")
else:
    raise SystemExit("Synapse SSO endpoint did not return a redirect")
PY

expected_sources=(
  mb-bureaublad:bridge
  mb-collabora:collabora
  mb-docs:docs
  mb-element:element
  mb-messages:messages
)

: > "${tmp}/fingerprints"
for source in "${expected_sources[@]}"; do
  namespace="${source%%:*}"
  host="${source#*:}"
  secret="${host}.${DOMAIN}-tls"
  printf -v reference '%s\t%s' "${namespace}" "${secret}"
  if ! grep -Fqx "${reference}" "${tmp}/ingress-secrets.tsv"; then
    echo "ERROR: no Ingress references expected Secret ${namespace}/${secret}" >&2
    exit 1
  fi
  validate_certificate_key "${namespace}" "${secret}" tls.crt
  validate_certificate_key "${namespace}" "${secret}" ca.crt
  kubectl get secret -n "${namespace}" "${secret}" -o json \
    | python3 -c 'import base64, hashlib, json, sys
data = json.load(sys.stdin)["data"]
digest = hashlib.sha256(b"".join(base64.b64decode(data[key]) for key in ("tls.crt", "tls.key", "ca.crt"))).hexdigest()
print(digest)' \
    | sed "s|$|  ${namespace}/${secret}|" >> "${tmp}/fingerprints"
done

if [ -n "${BASELINE}" ]; then
  if [ -e "${BASELINE}" ]; then
    if ! diff -u "${BASELINE}" "${tmp}/fingerprints"; then
      echo "ERROR: self-signed certificates rotated during deployment convergence" >&2
      exit 1
    fi
  else
    install -D -m 0644 "${tmp}/fingerprints" "${BASELINE}"
  fi
fi

echo "Self-signed TLS Secrets are present, parseable, and convergence-safe"
