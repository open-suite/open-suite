# Open Suite (formerly work-eu)

Opinionated self-hostable digital-workplace distribution. Curates MinBZK
**bureaublad** portal + La Suite Numérique + Nextcloud + Keycloak behind one login.

## Repos (GitHub org: open-suite)
- **open-suite/open-suite** — this distribution repo (deploy scripts, overlays, patches). Old `ritza-co/open-suite` redirects here.
- **open-suite/open-suite-portal** — detached public fork of `MinBZK/bureaublad` @ `v0.9.3`. We own the portal now; brand/UI changes go here directly (not as patches). Already rebranded to "Open Suite".

## PR & deploy policy (overrides global Rule 3 for `open-suite/` repos)
- Opening PRs is fine without asking first — this is our OSS, fast and loose, not client work. Give Gareth the PR link for feature work.
- You may push to the demo env (`demo.opensuite.online`) and then open a PR if it looks good.
- Everything is MIT/public and our reputation rides on it: quality bar is high, zero slop. If a change looks bad, half-baked, or you're unsure it's fit to be seen publicly, STOP and check with Gareth instead of opening the PR.

## Demo VPS
- **`ssh root@95.217.109.206`** — single-VPS k3s happy-path deploy.
- Domain: `demo.opensuite.online` (in `/etc/mijnbureau/domain`). Portal at https://bridge.demo.opensuite.online
- Deploy entry point: `deploy.sh <domain> <email> <master-password>`, run as root from a checkout (`/root/open-suite` on the box); it runs `scripts/single-vps-deploy/01..12` (gaps = steps made declarative; images are pinned in the demo values). Idempotent.
- Namespaces (`kubectl get ns`): `mb-bureaublad` (portal + auth gate), `mb-keycloak`, `mb-nextcloud`, `mb-collabora`, `mb-docs`, `mb-grist`, `mb-element`, `mb-meet`, `mb-livekit`, plus `cert-manager`. Use `KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl ...`.
- Portal changes go in the `open-suite/open-suite-portal` fork; `08-open-suite-portal.sh` builds and deploys it from `@main`. (The old "sed the html into a thin image" workflow is superseded.)

## Login page (Keycloak) branding
- The login/SSO page is **Keycloak** (Bitnami), namespace `mb-keycloak`, realm `mijnbureau`, served at `https://id.demo.opensuite.online`.
- Brand on the login card = realm `displayName` / `displayNameHtml`. Declarative source: configmap `keycloak-keycloak-keycloak-config-cli-configmap` (applied by keycloak-config-cli at deploy). Note the fork's `keycloak/import/mijnbureau.json` does **not** set these — the cluster configmap does.
- Patch live via kcadm (admin pw in secret `keycloak-keycloak` key `admin-password`, but the working creds were the **bootstrap** file `$KC_BOOTSTRAP_ADMIN_PASSWORD_FILE`, user `admin`). kcadm's `/` HOME is read-only → must pass `--config /tmp/kc.config`:
  ```
  kubectl -n mb-keycloak exec keycloak-keycloak-0 -c keycloak -- sh -c '
   KC=/opt/bitnami/keycloak/bin/kcadm.sh; CFG=/tmp/kc.config
   PW=$(cat $KC_BOOTSTRAP_ADMIN_PASSWORD_FILE)
   $KC config credentials --config $CFG --server http://localhost:8080/ --realm master --user admin --password "$PW"
   $KC update realms/mijnbureau --config $CFG -s "displayName=Open Suite" -s "displayNameHtml=<b>Open Suite</b>"'
  ```
- Declarative source of truth: `patches/local/keycloak-realm-open-suite-branding.patch` (displayName + login theme) and `keycloak-realm-session-lifetimes.patch` — both patch the realm import in the vendored infra, so config-cli re-imports keep them. kcadm is for inspection/experiments only.

## Brand strings (in open-suite-portal)
`frontend/messages/{en,nl}.json` → `HomePage.title` (header), `HomePage.welcome`, `Footer.copyright`; `frontend/src/app/layout.jsx` → tab `<title>`. All set to "Open Suite".
