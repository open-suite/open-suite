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
#   DOMAIN     e.g. demo.opensuite.online
#   NC_LOGIN   Nextcloud login name for johndoe (the user_oidc hash)
#   NC_PASS    a Nextcloud app password for that user
# Matrix is seeded via the Synapse pod (no extra creds needed).
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# --- config (from env, falling back to the demo-seed secret) -----------------
load_secret() {
  local key="$1"
  kubectl -n mb-bureaublad get secret demo-seed -o jsonpath="{.data.$key}" 2>/dev/null | base64 -d
}
DOMAIN="${DOMAIN:-$(load_secret DOMAIN)}"
NC_LOGIN="${NC_LOGIN:-$(load_secret NC_LOGIN)}"
NC_PASS="${NC_PASS:-$(load_secret NC_PASS)}"
DEMO_PASS="${DEMO_PASS:-$(load_secret DEMO_PASS)}"   # johndoe's Keycloak password
: "${DOMAIN:?}"; : "${NC_LOGIN:?}"; : "${NC_PASS:?}"; : "${DEMO_PASS:?}"

NC="https://nextcloud.${DOMAIN}/remote.php/dav"
CAL="${NC}/calendars/${NC_LOGIN}/personal"
FILES="${NC}/files/${NC_LOGIN}"

# Opinionation: Nextcloud is files + Collabora office only. La Suite Docs is the
# single block editor, so disable Nextcloud Text — otherwise opening a file in
# Nextcloud presents a second, competing notes editor. (Idempotent.)
echo "==> Enforcing one block editor (disable Nextcloud Text)"
kubectl -n mb-nextcloud exec deploy/nextcloud -c nextcloud -- \
  sh -c "cd /var/www/html && php occ app:disable text" >/dev/null 2>&1 || true

echo "==> [1/3] Calendar — upcoming events (each with a Meet link)"
# Meet is OIDC-native; mint johndoe a token (direct-access grant on the meet
# client) so we can create a room per event. Its URL goes in the event location,
# which the portal surfaces as a "Join" button.
MEET_CID=$(kubectl -n mb-keycloak get secret keycloak-keycloak-config-cli -o jsonpath="{.data.MB_CLIENT_SECRET_MEET}" | base64 -d)
kubectl -n mb-keycloak exec keycloak-keycloak-0 -c keycloak -- sh -c '
KC=/opt/bitnami/keycloak/bin/kcadm.sh; CFG=/tmp/kc.config
PW=$(cat $KC_BOOTSTRAP_ADMIN_PASSWORD_FILE)
$KC config credentials --config $CFG --server http://localhost:8080/ --realm master --user admin --password "$PW" >/dev/null 2>&1
ID=$($KC get clients -r mijnbureau --config $CFG -q clientId=meet --fields id 2>/dev/null | grep -oE "[0-9a-f-]{36}" | head -1)
$KC update clients/$ID -r mijnbureau --config $CFG -s directAccessGrantsEnabled=true >/dev/null 2>&1
' || true
MEET_TOK=$(curl -fsS --max-time 20 -X POST "https://id.${DOMAIN}/realms/mijnbureau/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=meet -d client_secret="${MEET_CID}" \
  -d username=johndoe -d password="${DEMO_PASS}" -d scope=openid \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))")

# Create (idempotently) a Meet room for an event and echo its slug. On a re-run
# the room already exists (La Suite 400s with a slug error list), so fall back
# to looking the room up by name to get its real slug.
meet_slug() {
  local resp slug
  resp=$(curl -s --max-time 20 -X POST "https://meet.${DOMAIN}/api/v1.0/rooms/" \
    -H "Authorization: Bearer ${MEET_TOK}" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\"}")
  slug=$(printf '%s' "$resp" | python3 -c "import json,sys
try:
    s = json.load(sys.stdin).get('slug')
    print(s if isinstance(s, str) else '')
except Exception:
    print('')")
  if [ -z "$slug" ]; then
    slug=$(curl -s --max-time 20 "https://meet.${DOMAIN}/api/v1.0/rooms/?page_size=200" \
      -H "Authorization: Bearer ${MEET_TOK}" | python3 -c "import json,sys
name = sys.argv[1]
try: d = json.load(sys.stdin)
except Exception: d = {}
rooms = d.get('results', []) if isinstance(d, dict) else (d or [])
print(next((r.get('slug','') for r in rooms if r.get('name') == name), ''))" "$1")
  fi
  printf '%s' "$slug"
}

# Fixed UIDs so re-runs replace (no duplicates); dates relative to today so they
# always stay in the near future.
put_event() {
  local uid="$1" days="$2" hour="$3" dur="$4" summary="$5"
  local d start end meet=""
  d=$(date -u -d "+${days} days" +%Y%m%d 2>/dev/null || date -u -v+"${days}"d +%Y%m%d)
  start="${d}T${hour}0000Z"
  end="${d}T$(printf '%02d' $((10#${hour}+dur)))0000Z"
  [ -n "${MEET_TOK}" ] && meet="https://meet.${DOMAIN}/$(meet_slug "${summary}")"
  curl -fsS -u "${NC_LOGIN}:${NC_PASS}" -X PUT "${CAL}/${uid}.ics" \
    -H "Content-Type: text/calendar" --data-binary @- >/dev/null <<ICS
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
put_event demo-standup-os    1 09 1 "Team standup"
put_event demo-review-os      3 14 1 "Q3 deck review with Jane"
put_event demo-1on1-os        5 11 1 "1:1 John and Jane"

echo "==> [2/3] Docs — La Suite documents"
# La Suite Docs is OIDC-native; mint johndoe a token via Keycloak direct-access
# grant on the docs client (ensure that grant is enabled first).
DOCS_CID=$(kubectl -n mb-keycloak get secret keycloak-keycloak-config-cli -o jsonpath="{.data.MB_CLIENT_SECRET_DOCS}" | base64 -d)
kubectl -n mb-keycloak exec keycloak-keycloak-0 -c keycloak -- sh -c '
KC=/opt/bitnami/keycloak/bin/kcadm.sh; CFG=/tmp/kc.config
PW=$(cat $KC_BOOTSTRAP_ADMIN_PASSWORD_FILE)
$KC config credentials --config $CFG --server http://localhost:8080/ --realm master --user admin --password "$PW" >/dev/null 2>&1
ID=$($KC get clients -r mijnbureau --config $CFG -q clientId=docs --fields id 2>/dev/null | grep -oE "[0-9a-f-]{36}" | head -1)
$KC update clients/$ID -r mijnbureau --config $CFG -s directAccessGrantsEnabled=true >/dev/null 2>&1
' || true
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
kubectl -n mb-element exec "${SYN}" -c synapse -- sh -c '
set -e
B=http://localhost:8448
SERVER=matrix.demo.opensuite.online
JOHN=@johndoe:$SERVER; JANE=@janedoe:$SERVER
AT="Authorization: Bearer syt_seedadmintokenjohn0001"
# Idempotent: skip if John already has a DM with Jane (m.direct account data).
HAS=$(curl -s "$B/_matrix/client/v3/user/$JOHN/account_data/m.direct" -H "$AT" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print(\"yes\" if isinstance(d,dict) and d.get(\"$JANE\") else \"no\")")
if [ "$HAS" = "yes" ]; then echo "    DM already present — skipping"; exit 0; fi
# Ensure Jane exists and get her token.
curl -s -X PUT "$B/_synapse/admin/v2/users/$JANE" -H "$AT" -H "Content-Type: application/json" -d "{\"displayname\":\"Jane Doe\"}" >/dev/null
JT=$(curl -s -X POST "$B/_synapse/admin/v1/users/$JANE/login" -H "$AT" -H "Content-Type: application/json" -d "{}" | python3 -c "import json,sys;print(json.load(sys.stdin)[\"access_token\"])")
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
'

echo "==> Demo data seeded."
