#!/usr/bin/env bash
# Usage: ./seed-demo.sh
#
# Populates the Open Suite demo with light, realistic data so every portal
# widget shows something: upcoming calendar events, a couple of files, and a
# short chat thread between Jane and John. Idempotent — safe to run daily as a
# reset (fixed ids/paths are overwritten; event dates are recomputed to stay
# upcoming; the chat room is only seeded once).
#
# Requires (env or the `demo-seed` secret in mb-bureaublad):
#   DOMAIN     e.g. suite.example.com
#   NC_LOGIN   Nextcloud login name for johndoe (the user_oidc hash)
#   NC_PASS    a Nextcloud app password for that user
# Matrix is seeded via the Synapse pod (no extra creds needed).
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Prevent cron, a manual repair, and a smoke-adjacent run from mutating the same
# fixtures or Keycloak client settings concurrently.
exec 9>/run/lock/opensuite-demo-seed.lock
if ! flock -n 9; then
  echo "==> seed-demo: another run holds the lock; skipping"
  exit 0
fi

# --- config (from env, falling back to the demo-seed secret) -----------------
# load_secret must not fail hard under set -e: a missing secret would kill the
# script inside the assignment with no message (this hid an empty demo for
# days). Return empty instead and let the explicit check below report it.
load_secret() {
  local key="$1"
  kubectl -n mb-bureaublad get secret demo-seed -o jsonpath="{.data.$key}" 2>/dev/null | base64 -d || true
}
DOMAIN="${DOMAIN:-$(load_secret DOMAIN)}"
NC_LOGIN="${NC_LOGIN:-$(load_secret NC_LOGIN)}"
NC_PASS="${NC_PASS:-$(load_secret NC_PASS)}"
DEMO_PASS="${DEMO_PASS:-$(load_secret DEMO_PASS)}"   # johndoe's Keycloak password
for v in DOMAIN NC_LOGIN NC_PASS DEMO_PASS; do
  if [ -z "${!v}" ]; then
    echo "!! seed-demo: $v is unset and the demo-seed secret in mb-bureaublad is missing or incomplete — seeding ABORTED" >&2
    exit 1
  fi
done

# WebDAV uses johndoe's app password (basic auth), which the edge auth gate
# does not pass through — it 302s to the login page and curl treats that as
# success. Talk to the Nextcloud service in-cluster instead, with the public
# Host so Nextcloud accepts the request.
NC_SVC=$(kubectl -n mb-nextcloud get svc nextcloud -o jsonpath='{.spec.clusterIP}')
NC_HOST="nextcloud.${DOMAIN}"
NC="http://${NC_SVC}:8080/remote.php/dav"
CAL="${NC}/calendars/${NC_LOGIN}/personal"

# curl -f does not fail on redirects; assert an actual 2xx so a gate/login
# bounce can never again masquerade as a successful write.
dav() { # method url [curl args...]
  local method="$1" url="$2" code; shift 2
  code=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' \
    -u "${NC_LOGIN}:${NC_PASS}" -H "Host: ${NC_HOST}" -X "${method}" "$url" "$@")
  case "$code" in 2*) return 0 ;; *)
    echo "!! seed-demo: ${method} ${url} returned HTTP ${code}" >&2; return 1 ;;
  esac
}

# Direct-access grants are enabled on the meet/docs clients only for the
# duration of the run (needed to mint johndoe tokens) and re-disabled on exit,
# including on failure.
set_direct_access() { # clientId true|false
  kubectl -n mb-keycloak exec -i keycloak-keycloak-0 -c keycloak -- sh -s -- "$1" "$2" <<'SH'
set -e
CLIENT_ID="$1"; VALUE="$2"
KC=/opt/bitnami/keycloak/bin/kcadm.sh; CFG=/tmp/kc.config
PW=$(cat "$KC_BOOTSTRAP_ADMIN_PASSWORD_FILE")
"$KC" config credentials --config "$CFG" --server http://localhost:8080/ --realm master --user admin --password "$PW" >/dev/null 2>&1
ID=$("$KC" get clients -r mijnbureau --config "$CFG" -q clientId="$CLIENT_ID" --fields id 2>/dev/null | grep -oE "[0-9a-f-]{36}" | head -1)
"$KC" update "clients/$ID" -r mijnbureau --config "$CFG" -s "directAccessGrantsEnabled=$VALUE" >/dev/null 2>&1
SH
}
restore_direct_access() {
  local rc=0
  set_direct_access meet false || rc=1
  set_direct_access docs false || rc=1
  return "$rc"
}

# The Synapse admin token minted for step 3 lives only for this run.
SEED_ADMIN_TOKEN=""
synapse_sql() { # SQL on stdin
  local pw
  pw=$(kubectl -n mb-element get secret element-cluster-rw -o jsonpath='{.data.password}' | base64 -d)
  kubectl -n mb-element exec -i element-cluster-rw-0 -- \
    env PGPASSWORD="${pw}" psql -qAt -h 127.0.0.1 -U synapse -d synapse
}
cleanup_matrix_token() {
  [ -n "${SEED_ADMIN_TOKEN}" ] || return 0
  printf "DELETE FROM access_tokens WHERE token = '%s';\n" "${SEED_ADMIN_TOKEN}" | \
    synapse_sql >/dev/null 2>&1 || true
}
seed_cleanup() { # original exit status
  local original_status="$1" cleanup_status=0
  trap - EXIT
  set +e
  restore_direct_access || {
    echo "!! seed-demo: CRITICAL: failed to disable temporary Keycloak direct grants" >&2
    cleanup_status=1
  }
  cleanup_matrix_token || cleanup_status=1
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap 'seed_cleanup $?' EXIT

# Opinionation: Nextcloud is files + Collabora office only. La Suite Docs is the
# single block editor, so disable Nextcloud Text — otherwise opening a file in
# Nextcloud presents a second, competing notes editor. (Idempotent.)
echo "==> Enforcing one block editor (disable Nextcloud Text)"
kubectl -n mb-nextcloud exec deploy/nextcloud -c nextcloud -- \
  sh -c "cd /var/www/html && php occ app:disable text" >/dev/null 2>&1 || true

# The CI smoke proves Collabora works by creating (and then deleting) a
# Document.docx on every run; the file goes but its create/delete activity
# entries stay and surface in the portal's NextCloud widget. Purge them as
# part of the daily reset so the widget only shows real demo files.
echo "==> Purging smoke-test activity entries"
NC_DB_USER=$(kubectl -n mb-nextcloud get secret nextcloud-externaldatabase -o jsonpath='{.data.username}' | base64 -d)
NC_DB_PASS=$(kubectl -n mb-nextcloud get secret nextcloud-externaldatabase -o jsonpath='{.data.password}' | base64 -d)
kubectl -n mb-nextcloud exec nextcloud-cluster-rw-0 -c postgresql -- \
  env PGPASSWORD="${NC_DB_PASS}" psql -qAt -h 127.0.0.1 -U "${NC_DB_USER}" -d nextcloud \
  -c "DELETE FROM oc_activity WHERE file ~ '/Document( \\(\\d+\\))?\\.docx$'" >/dev/null || \
  echo "    !! activity purge failed (non-fatal)"

echo "==> [1/3] Calendar — upcoming events (each with a Meet link)"
# Meet is OIDC-native; mint johndoe a token (direct-access grant on the meet
# client) so we can create a room per event. Its URL goes in the event location,
# which the portal surfaces as a "Join" button.
MEET_CID=$(kubectl -n mb-keycloak get secret keycloak-keycloak-config-cli -o jsonpath="{.data.MB_CLIENT_SECRET_MEET}" | base64 -d)
set_direct_access meet true
MEET_TOK=$(curl -fsS --max-time 20 -X POST "https://id.${DOMAIN}/realms/mijnbureau/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=meet -d client_secret="${MEET_CID}" \
  -d username=johndoe -d password="${DEMO_PASS}" -d scope=openid \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))")

# Create (idempotently) a Meet room for an event and echo its slug. Each seeded
# event owns one fixed code-format name; on a re-run La Suite returns a duplicate
# error, so look up that same name instead of creating another public room.
meet_slug() { # stable code-format room name
  # La Suite Meet only treats code-format slugs (xxx-yyyy-zzz) as joinable, and
  # rooms default to "restricted" (owner only). Use the event's fixed code (not
  # its mutable title) and make it public, like the meetcal app does.
  local code="$1" resp slug
  resp=$(curl -s --max-time 20 -X POST "https://meet.${DOMAIN}/api/v1.0/rooms/" \
    -H "Authorization: Bearer ${MEET_TOK}" -H "Content-Type: application/json" \
    -d "{\"name\":\"${code}\",\"access_level\":\"public\"}")
  slug=$(printf '%s' "$resp" | python3 -c "import json,sys
try:
    s = json.load(sys.stdin).get('slug')
    print(s if isinstance(s, str) else '')
except Exception:
    print('')")
  printf '%s' "$slug"
}

# Fixed UIDs so re-runs replace (no duplicates); dates relative to today so they
# always stay in the near future.
put_event() {
  local uid="$1" days="$2" hour="$3" dur="$4" code="$5" summary="$6"
  local d start end meet=""
  d=$(date -u -d "+${days} days" +%Y%m%d 2>/dev/null || date -u -v+"${days}"d +%Y%m%d)
  start="${d}T${hour}0000Z"
  end="${d}T$(printf '%02d' $((10#${hour}+dur)))0000Z"
  [ -n "${MEET_TOK}" ] && meet="https://meet.${DOMAIN}/$(meet_slug "${code}")"
  dav PUT "${CAL}/${uid}.ics" \
    -H "Content-Type: text/calendar" --data-binary @- <<ICS
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Open Suite//demo//EN
BEGIN:VEVENT
UID:${uid}
DTSTAMP:${start}
DTSTART:${start}
DTEND:${end}
SUMMARY:${summary}
LOCATION:${meet}
END:VEVENT
END:VCALENDAR
ICS
  echo "    + ${summary} (in ${days}d) -> ${meet:-no meet link}"
}
put_event demo-standup-os 1 09 1 dmo-stnd-upx "Team standup"
put_event demo-review-os  3 14 1 dmo-rviw-qtr "Q3 deck review with Jane"
put_event demo-1on1-os    5 11 1 dmo-oneo-one "1:1 John and Jane"

echo "==> [2/3] Docs — La Suite documents"
# La Suite Docs is OIDC-native; mint johndoe a token via Keycloak direct-access
# grant on the docs client (ensure that grant is enabled first).
DOCS_CID=$(kubectl -n mb-keycloak get secret keycloak-keycloak-config-cli -o jsonpath="{.data.MB_CLIENT_SECRET_DOCS}" | base64 -d)
set_direct_access docs true
DTOK=$(curl -fsS --max-time 20 -X POST "https://id.${DOMAIN}/realms/mijnbureau/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=docs -d client_secret="${DOCS_CID}" \
  -d username=johndoe -d password="${DEMO_PASS}" -d scope=openid \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))")
DOCSAPI="https://docs.${DOMAIN}/api/v1.0/documents/"
have_doc() { # title — true if a doc with that title already exists
  curl -fsS --max-time 20 "${DOCSAPI}?page_size=100" -H "Authorization: Bearer ${DTOK}" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(any(x.get('title')==sys.argv[1] for x in d.get('results',[])))" "$1"
}
make_doc() { # title
  if [ "$(have_doc "$1")" = "True" ]; then echo "    = $1 (exists)"; return; fi
  curl -fsS --max-time 20 -X POST "${DOCSAPI}" -H "Authorization: Bearer ${DTOK}" \
    -H "Content-Type: application/json" -d "{\"title\":\"$1\"}" >/dev/null && echo "    + $1"
}
if [ -n "${DTOK}" ]; then
  make_doc "Welcome to Open Suite"
  make_doc "Q3 plan"
  make_doc "Onboarding checklist"
else
  echo "    !! could not obtain a Docs token — skipping"
fi

echo "==> [3/3] Chat — Jane ↔ John direct message"
SYN=$(kubectl -n mb-element get pods -o name | grep -i "synapse-" | grep -iv keygen | head -1)
# Mint a run-scoped Synapse admin token. Password login is disabled (OIDC-only
# Synapse), so shared-secret registration is unusable; bootstrap a seedadmin
# user + token straight in the DB instead. The token expires after an hour and
# is deleted by the exit trap. The id offset keeps clear of Synapse's in-memory
# id generator, which hands out ids from the max it saw at startup.
SEED_ADMIN_TOKEN="syt_seed_$(openssl rand -hex 16)"
synapse_sql >/dev/null <<SQL
INSERT INTO users (name, creation_ts, admin)
VALUES ('@seedadmin:matrix.${DOMAIN}', extract(epoch from now())::bigint, 1)
ON CONFLICT (name) DO UPDATE SET admin = 1;
INSERT INTO access_tokens (id, user_id, device_id, token, valid_until_ms)
VALUES ((SELECT COALESCE(MAX(id), 0) + 100000 FROM access_tokens),
        '@seedadmin:matrix.${DOMAIN}', 'seed', '${SEED_ADMIN_TOKEN}',
        (extract(epoch from now())::bigint + 3600) * 1000);
SQL
kubectl -n mb-element exec -i "${SYN}" -c synapse -- sh -s -- "${DOMAIN}" "${SEED_ADMIN_TOKEN}" <<'SH'
set -e
DOMAIN="$1"
B=http://localhost:8448
SERVER=matrix.$DOMAIN
JOHN=@johndoe:$SERVER; JANE=@janedoe:$SERVER
AAT="Authorization: Bearer $2"
# Ensure both demo users exist, and act as them via admin login (no passwords).
curl -s -X PUT "$B/_synapse/admin/v2/users/$JOHN" -H "$AAT" -H "Content-Type: application/json" -d "{\"displayname\":\"John Doe\"}" >/dev/null
curl -s -X PUT "$B/_synapse/admin/v2/users/$JANE" -H "$AAT" -H "Content-Type: application/json" -d "{\"displayname\":\"Jane Doe\"}" >/dev/null
AT="Authorization: Bearer $(curl -s -X POST "$B/_synapse/admin/v1/users/$JOHN/login" -H "$AAT" -H "Content-Type: application/json" -d "{}" | python3 -c "import json,sys;print(json.load(sys.stdin)[\"access_token\"])")"
# Idempotent: skip if John already has a DM with Jane (m.direct account data).
HAS=$(curl -s "$B/_matrix/client/v3/user/$JOHN/account_data/m.direct" -H "$AT" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print(\"yes\" if isinstance(d,dict) and d.get(\"$JANE\") else \"no\")")
if [ "$HAS" = "yes" ]; then echo "    DM already present — skipping"; exit 0; fi
JT=$(curl -s -X POST "$B/_synapse/admin/v1/users/$JANE/login" -H "$AAT" -H "Content-Type: application/json" -d "{}" | python3 -c "import json,sys;print(json.load(sys.stdin)[\"access_token\"])")
# Create a real DM: no name, is_direct, so clients show it as the other person.
RID=$(curl -s -X POST "$B/_matrix/client/v3/createRoom" -H "$AT" -H "Content-Type: application/json" -d "{\"is_direct\":true,\"invite\":[\"$JANE\"],\"preset\":\"trusted_private_chat\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)[\"room_id\"])")
# Mark it as a direct message for both users so it renders as a DM.
curl -s -X PUT "$B/_matrix/client/v3/user/$JOHN/account_data/m.direct" -H "$AT" -H "Content-Type: application/json" -d "{\"$JANE\":[\"$RID\"]}" >/dev/null
curl -s -X POST "$B/_matrix/client/v3/rooms/$RID/join" -H "Authorization: Bearer $JT" >/dev/null
curl -s -X PUT "$B/_matrix/client/v3/user/$JANE/account_data/m.direct" -H "Authorization: Bearer $JT" -H "Content-Type: application/json" -d "{\"$JOHN\":[\"$RID\"]}" >/dev/null
i=0
snd(){ i=$((i+1)); curl -s -X PUT "$B/_matrix/client/v3/rooms/$RID/send/m.room.message/seed$i" -H "$1" -H "Content-Type: application/json" -d "{\"msgtype\":\"m.text\",\"body\":\"$2\"}" >/dev/null; }
snd "$AT" "Hi Jane, did you get the Q3 deck?"
snd "Authorization: Bearer $JT" "Hey John, yes reviewing it now."
snd "$AT" "Great, lets sync after standup."
snd "Authorization: Bearer $JT" "Works for me, see you at 10."
echo "    seeded DM thread"
SH

echo "==> Demo data seeded."
