# Open Suite (formerly work-eu / Keep Office)

Opinionated self-hostable digital-workplace distribution. Curates MinBZK
**bureaublad** portal + La Suite Numérique + Nextcloud + Keycloak behind one login.

## Repos (GitHub org: Keep-Office)
- **Keep-Office/open-suite** — this distribution repo (deploy scripts, overlays, patches). Old `ritza-co/open-suite` redirects here.
- **Keep-Office/open-suite-portal** — detached public fork of `MinBZK/bureaublad` @ `v0.9.3`. We own the portal now; brand/UI changes go here directly (not as patches). Already rebranded to "Open Suite".

## Demo VPS
- **`ssh root@95.217.109.206`** — single-VPS k3s happy-path deploy.
- Domain: `mijnbureau.ritzademo.com` (in `/etc/mijnbureau/domain`). Portal at https://mijnbureau.ritzademo.com
- Portal runs in k8s namespace `mb-bureaublad`; use `KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl ...`.
- Frontend is an **nginx static export** (read-only rootfs) served from `/usr/share/nginx/html`. To patch a running frontend: build a thin image `FROM` the current one that seds the html, `docker save | k3s ctr -n k8s.io images import -`, then `kubectl patch deploy bureaublad-frontend` image + `imagePullPolicy: Never`.
- Docker dev workflow lives on the VPS (many `localhost/bureaublad-frontend:<tag>` images). Current Open Suite patch image: `localhost/bureaublad-frontend:opensuite-1`.

## Login page (Keycloak) branding
- The login/SSO page is **Keycloak** (Bitnami), namespace `mb-keycloak`, realm `mijnbureau`, served at `https://id.mijnbureau.ritzademo.com`.
- Brand on the login card = realm `displayName` / `displayNameHtml`. Declarative source: configmap `keycloak-keycloak-keycloak-config-cli-configmap` (applied by keycloak-config-cli at deploy). Note the fork's `keycloak/import/mijnbureau.json` does **not** set these — the cluster configmap does.
- Patch live via kcadm (admin pw in secret `keycloak-keycloak` key `admin-password`, but the working creds were the **bootstrap** file `$KC_BOOTSTRAP_ADMIN_PASSWORD_FILE`, user `admin`). kcadm's `/` HOME is read-only → must pass `--config /tmp/kc.config`:
  ```
  kubectl -n mb-keycloak exec keycloak-keycloak-0 -c keycloak -- sh -c '
   KC=/opt/bitnami/keycloak/bin/kcadm.sh; CFG=/tmp/kc.config
   PW=$(cat $KC_BOOTSTRAP_ADMIN_PASSWORD_FILE)
   $KC config credentials --config $CFG --server http://localhost:8080/ --realm master --user admin --password "$PW"
   $KC update realms/mijnbureau --config $CFG -s "displayName=Open Suite" -s "displayNameHtml=<b>Open Suite</b>"'
  ```
- Runtime change; reverts if config-cli re-imports. Durable fix: update the configmap (and ideally add displayName to the fork's realm json).

## Brand strings (in open-suite-portal)
`frontend/messages/{en,nl}.json` → `HomePage.title` (header), `HomePage.welcome`, `Footer.copyright`; `frontend/src/app/layout.jsx` → tab `<title>`. All set to "Open Suite".
