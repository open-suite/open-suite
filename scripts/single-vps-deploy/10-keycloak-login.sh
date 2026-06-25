#!/usr/bin/env bash
# Usage: ./10-keycloak-login.sh
#
# Installs the Open Suite Keycloak login theme. Branding is always enabled.
# The public demo credential panel is controlled by OPEN_SUITE_DEMO_MODE=true
# during deploy, persisted in /etc/mijnbureau/demo-mode.
set -euo pipefail

DOMAIN="$(cat /etc/mijnbureau/domain 2>/dev/null || true)"
if [ -z "${DOMAIN}" ]; then
  echo "No domain found. Pass through deploy.sh or run 01-deploy.sh first." >&2
  exit 1
fi

DEMO_MODE="$(cat /etc/mijnbureau/demo-mode 2>/dev/null || printf false)"
DEMO_USERNAME="$(cat /etc/mijnbureau/demo-username 2>/dev/null || printf johndoe)"
DEMO_PASSWORD="$(cat /etc/mijnbureau/demo-password 2>/dev/null || printf myStrongPassword123)"
DEMO_ADMIN_USERNAME="$(cat /etc/mijnbureau/demo-admin-username 2>/dev/null || printf admin)"
DEMO_ADMIN_PASSWORD="$(cat /etc/mijnbureau/demo-admin-password 2>/dev/null || true)"

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

json_string() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

DEMO_ENABLED_JS=false
case "${DEMO_MODE}" in
  1|true|TRUE|yes|YES|on|ON) DEMO_ENABLED_JS=true ;;
esac

USER_JS="$(printf '%s' "${DEMO_USERNAME}" | json_string)"
PASS_JS="$(printf '%s' "${DEMO_PASSWORD}" | json_string)"
ADMIN_USER_JS="$(printf '%s' "${DEMO_ADMIN_USERNAME}" | json_string)"
ADMIN_PASS_JS="$(printf '%s' "${DEMO_ADMIN_PASSWORD}" | json_string)"

echo "==> Installing Open Suite Keycloak login theme"
kubectl -n mb-keycloak create configmap opensuite-keycloak-theme \
  --from-literal=theme.properties='parent=keycloak.v2
import=common/keycloak
styles=css/styles.css
stylesCommon=vendor/patternfly-v5/patternfly.min.css vendor/patternfly-v5/patternfly-addons.css
scripts=js/opensuite-login.js
darkMode=false
' \
  --from-literal=styles.css=':root {
  --os-ink: #101827;
  --os-muted: #526071;
  --os-line: #d6e2ef;
  --os-blue: #245cff;
  --os-blue-dark: #1742bf;
  --os-green: #0b8f75;
  --os-panel: rgba(255, 255, 255, 0.94);
}

html.login-pf,
body#keycloak-bg {
  min-height: 100%;
  background:
    radial-gradient(circle at 78% 22%, rgba(36, 92, 255, 0.18), transparent 28rem),
    linear-gradient(135deg, #f7fbff 0%, #e8f1fb 42%, #f7f9fc 100%) !important;
  color: var(--os-ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.pf-v5-c-login__container {
  grid-template-columns: minmax(19rem, 28rem) minmax(22rem, 29rem);
  gap: clamp(2rem, 7vw, 7rem);
  min-height: 100vh;
  align-items: center;
  padding: clamp(1.5rem, 5vw, 5rem);
}

.pf-v5-c-login__header {
  align-self: center;
}

#kc-header-wrapper {
  color: var(--os-ink);
  font-size: clamp(2.4rem, 6vw, 5.25rem);
  line-height: 0.95;
  font-weight: 850;
  letter-spacing: 0;
  max-width: 8ch;
}

#kc-header-wrapper::before {
  content: "OPEN SUITE";
  display: block;
  margin-bottom: 1.2rem;
  color: var(--os-blue);
  font-size: 0.875rem;
  line-height: 1;
  font-weight: 800;
  letter-spacing: 0.16em;
}

.pf-v5-c-login__main {
  border: 1px solid rgba(151, 171, 196, 0.45);
  border-radius: 8px;
  background: var(--os-panel);
  box-shadow: 0 24px 70px rgba(18, 34, 57, 0.16);
  overflow: hidden;
}

.pf-v5-c-login__main-header,
.pf-v5-c-login__main-body,
.pf-v5-c-login__main-footer {
  padding-inline: clamp(1.25rem, 4vw, 2rem);
}

.pf-v5-c-login__main-header {
  padding-top: 1.7rem;
}

.pf-v5-c-login__main-body {
  padding-bottom: 1.6rem;
}

.pf-v5-c-title {
  color: var(--os-ink);
  font-size: 1.55rem;
  letter-spacing: 0;
}

.pf-v5-c-form-control {
  border-color: var(--os-line);
  border-radius: 6px;
}

.pf-v5-c-button.pf-m-primary {
  border-radius: 6px;
  background: var(--os-blue);
}

.pf-v5-c-button.pf-m-primary:hover {
  background: var(--os-blue-dark);
}

.opensuite-demo-panel {
  margin: 0 0 1.15rem;
  padding: 0.95rem;
  border: 1px solid rgba(36, 92, 255, 0.22);
  border-left: 4px solid var(--os-blue);
  border-radius: 8px;
  background: #f5f8ff;
}

.opensuite-demo-label {
  margin-bottom: 0.65rem;
  color: var(--os-blue-dark);
  font-size: 0.72rem;
  font-weight: 850;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.opensuite-demo-row {
  display: block;
  margin-top: 0.55rem;
  color: var(--os-muted);
  font-size: 0.92rem;
}

.opensuite-demo-row code {
  display: block;
  margin-top: 0.1rem;
  color: var(--os-ink);
  font-size: 0.9rem;
  font-weight: 750;
  white-space: normal;
  word-break: normal;
  overflow-wrap: anywhere;
}

@media (max-width: 767px) {
  .pf-v5-c-login__container {
    display: block;
    padding: 1rem;
  }

  #kc-header-wrapper {
    max-width: none;
    margin: 1rem 0 1.25rem;
    font-size: 2.35rem;
  }
}
' \
  --from-literal=opensuite-login.js="(() => {
  const demoEnabled = ${DEMO_ENABLED_JS};
  const accounts = {
    user: { label: 'Demo user account', username: ${USER_JS}, password: ${PASS_JS} },
    admin: { label: 'Demo admin account', username: ${ADMIN_USER_JS}, password: ${ADMIN_PASS_JS} },
  };

  function isAdminLogin() {
    const params = new URLSearchParams(window.location.search);
    return window.location.pathname.includes('/realms/master/') ||
      window.location.pathname.includes('/admin/') ||
      params.get('client_id') === 'security-admin-console';
  }

  function insertDemoPanel() {
    if (!demoEnabled) return;
    const account = isAdminLogin() ? accounts.admin : accounts.user;
    if (!account.username || !account.password) return;

    const formBody = document.querySelector('.pf-v5-c-login__main-body');
    if (!formBody || document.querySelector('.opensuite-demo-panel')) return;

    const panel = document.createElement('div');
    panel.className = 'opensuite-demo-panel';
    panel.setAttribute('aria-label', account.label);
    panel.innerHTML =
      '<div class=\"opensuite-demo-label\">' + account.label + '</div>' +
      '<div class=\"opensuite-demo-row\"><span>Username</span><code></code></div>' +
      '<div class=\"opensuite-demo-row\"><span>Password</span><code></code></div>';
    const codes = panel.querySelectorAll('code');
    codes[0].textContent = account.username;
    codes[1].textContent = account.password;
    formBody.prepend(panel);
  }

  document.addEventListener('DOMContentLoaded', insertDemoPanel);
})();
" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n mb-keycloak patch sts keycloak-keycloak --type strategic -p '{
  "spec": {
    "template": {
      "spec": {
        "volumes": [
          {
            "name": "opensuite-keycloak-theme",
            "configMap": {
              "name": "opensuite-keycloak-theme",
              "items": [
                {"key": "theme.properties", "path": "login/theme.properties"},
                {"key": "styles.css", "path": "login/resources/css/styles.css"},
                {"key": "opensuite-login.js", "path": "login/resources/js/opensuite-login.js"}
              ]
            }
          }
        ],
        "containers": [
          {
            "name": "keycloak",
            "volumeMounts": [
              {
                "name": "opensuite-keycloak-theme",
                "mountPath": "/opt/bitnami/keycloak/themes/opensuite",
                "readOnly": true
              }
            ]
          }
        ]
      }
    }
  }
}'

kubectl -n mb-keycloak rollout restart sts/keycloak-keycloak
kubectl -n mb-keycloak rollout status sts/keycloak-keycloak --timeout=240s

echo "==> Enabling Open Suite login theme in Keycloak realms"
kubectl -n mb-keycloak exec keycloak-keycloak-0 -c keycloak -- sh -c '
set -e
KC=/opt/bitnami/keycloak/bin/kcadm.sh
CFG=/tmp/kc.config
PW=$(cat "$KC_BOOTSTRAP_ADMIN_PASSWORD_FILE")
"$KC" config credentials --config "$CFG" --server http://localhost:8080/ --realm master --user admin --password "$PW" >/dev/null
"$KC" update realms/master --config "$CFG" \
  -s "displayName=Open Suite Admin" \
  -s "displayNameHtml=<b>Open Suite Admin</b>" \
  -s "loginTheme=opensuite"
"$KC" update realms/mijnbureau --config "$CFG" \
  -s "displayName=Open Suite" \
  -s "displayNameHtml=<b>Open Suite</b>" \
  -s "loginTheme=opensuite"
'

echo "==> Open Suite Keycloak login theme enabled for https://id.${DOMAIN}"
