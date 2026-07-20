#!/usr/bin/env bash
# Usage: ./seed-demo.sh
#
# Resets the stateful public-demo fixtures and refreshes the idempotent ones:
# upcoming calendar events, La Suite Docs, a clean unread Mail inbox, and a
# fresh unread chat thread between Jane and John.
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

# The Synapse admin token minted for the Chat step lives only for this run.
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

# Remove the junk "Document*.docx" the smoke test leaves in johndoe's files so
# the portal Files widget shows only curated demo files (Q3-themed). Object
# storage is keyed by fileid, so dropping the filecache row is enough; a
# curated "Q3 planning notes.docx" / "Q3 Deck.docx" remain.
echo "==> Removing smoke-test Document*.docx from Files"
kubectl -n mb-nextcloud exec nextcloud-cluster-rw-0 -c postgresql -- \
  env PGPASSWORD="${NC_DB_PASS}" psql -qAt -h 127.0.0.1 -U "${NC_DB_USER}" -d nextcloud \
  -c "DELETE FROM oc_filecache WHERE path ~ '^files/Document( \\(\\d+\\))?\\.docx$'" >/dev/null || \
  echo "    !! file purge failed (non-fatal)"

# La Suite Docs: give any untitled doc a Q3-themed name so the portal Docs
# widget never shows "Untitled Document". Deterministic per row so re-runs are
# stable. (Docs stores the title in impress_document.title.)
echo "==> Titling untitled Docs (Q3 theme)"
DOCS_DB_PASS=$(kubectl -n mb-docs get secret docs-cluster-rw -o jsonpath='{.data.password}' | base64 -d)
kubectl -n mb-docs exec -i docs-cluster-rw-0 -c postgresql -- \
  env PGPASSWORD="${DOCS_DB_PASS}" psql -qAt -h 127.0.0.1 -U docs -d docs <<'SQL' >/dev/null 2>&1 || echo "    !! docs titling failed (non-fatal)"
WITH untitled AS (
  SELECT id, row_number() OVER (ORDER BY updated_at DESC) AS rn
  FROM impress_document WHERE title IS NULL OR title = ''
)
UPDATE impress_document d SET title = CASE u.rn
    WHEN 1 THEN 'Q3 Deck — Outline'
    WHEN 2 THEN 'Q3 Deck — Financials'
    WHEN 3 THEN 'Q3 Deck — Speaker Notes'
    ELSE 'Q3 Deck — Draft ' || u.rn END
FROM untitled u WHERE d.id = u.id;
SQL

echo "==> [1/4] Calendar — upcoming events (each with a Meet link)"
# Meet is OIDC-native; mint johndoe a token (direct-access grant on the meet
# client) so we can create a room per event. Its URL goes in the event location,
# which the portal surfaces as a "Join" button.
MEET_CID=$(kubectl -n mb-keycloak get secret keycloak-keycloak-config-cli -o jsonpath="{.data.MB_CLIENT_SECRET_MEET}" | base64 -d)
set_direct_access meet true
MEET_TOK=$(curl -fsS --max-time 20 -X POST "https://id.${DOMAIN}/realms/mijnbureau/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=meet -d client_secret="${MEET_CID}" \
  -d username=johndoe -d password="${DEMO_PASS}" -d scope=openid \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))")
[ -n "${MEET_TOK}" ] || { echo "!! seed-demo: Keycloak returned no Meet access token" >&2; exit 1; }

# Create (idempotently) a Meet room for an event and echo its slug. Each seeded
# event owns one fixed code-format name; on a re-run La Suite returns a duplicate
# error, so look up that same name instead of creating another public room.
meet_slug() { # stable code-format room name
  # La Suite Meet only treats code-format slugs (xxx-yyyy-zzz) as joinable, and
  # rooms default to "restricted" (owner only). Use the event's fixed code (not
  # its mutable title) and make it public, like the meetcal app does.
  local code="$1" response body status slug
  response=$(curl -sS --max-time 20 -w $'\n%{http_code}' \
    -X POST "https://meet.${DOMAIN}/api/v1.0/rooms/" \
    -H "Authorization: Bearer ${MEET_TOK}" -H "Content-Type: application/json" \
    -d "{\"name\":\"${code}\",\"access_level\":\"public\"}")
  status=${response##*$'\n'}
  body=${response%$'\n'*}

  case "$status" in
    2*) ;;
    400|409)
      # A fixed room from an earlier seed is expected. Fetching it by slug also
      # proves this user owns it; an unknown slug would return no usable slug.
      body=$(curl -fsS --max-time 20 \
        -H "Authorization: Bearer ${MEET_TOK}" \
        "https://meet.${DOMAIN}/api/v1.0/rooms/${code}/") || {
          echo "!! seed-demo: Meet rejected room ${code} (HTTP ${status}) and lookup failed" >&2
          return 1
        }
      ;;
    *)
      echo "!! seed-demo: Meet room create for ${code} returned HTTP ${status}" >&2
      return 1
      ;;
  esac

  slug=$(printf '%s' "$body" | python3 -c "import json,sys
try:
    s = json.load(sys.stdin).get('slug')
    print(s if isinstance(s, str) else '')
except Exception:
    print('')")
  if [ "$slug" != "$code" ]; then
    echo "!! seed-demo: Meet returned unexpected slug '${slug}' for ${code}" >&2
    return 1
  fi
  printf '%s' "$slug"
}

# Fixed UIDs so re-runs replace (no duplicates); dates relative to today so they
# always stay in the near future.
put_event() {
  local uid="$1" days="$2" hour="$3" dur="$4" code="$5" summary="$6"
  local d start end slug meet
  d=$(date -u -d "+${days} days" +%Y%m%d 2>/dev/null || date -u -v+"${days}"d +%Y%m%d)
  start="${d}T${hour}0000Z"
  end="${d}T$(printf '%02d' $((10#${hour}+dur)))0000Z"
  slug=$(meet_slug "${code}")
  meet="https://meet.${DOMAIN}/${slug}"
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

echo "==> [2/4] Docs — La Suite documents"
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

echo "==> [3/4] Mail — reset demo inbox and add unread messages"
if kubectl -n mb-messages get deploy messages-backend >/dev/null 2>&1; then
  # Delete only threads visible to the named public-demo mailboxes. This uses
  # the application's ORM so cascade and blob lifecycle rules stay intact.
  kubectl -n mb-messages exec deploy/messages-backend -- \
    python manage.py shell -c "
from core.models import Thread
demo_local_parts = ['johndoe', 'janedoe']
threads = Thread.objects.filter(
    accesses__mailbox__local_part__in=demo_local_parts,
    accesses__mailbox__domain__name='${DOMAIN}',
).distinct()
count = threads.count()
threads.delete()
print(f'    - removed {count} demo mail threads')
"

  seed_mail() { # sender name, sender address, subject, message id suffix, body
    local sender_name="$1" sender_address="$2" subject="$3" suffix="$4" body="$5"
    printf 'From: %s <%s>\r\nTo: John Doe <johndoe@%s>\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s-%s@%s>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n' \
      "${sender_name}" "${sender_address}" "${DOMAIN}" "${subject}" \
      "$(LC_ALL=C date -R)" "$(date -u +%Y%m%d)" "${suffix}" "${DOMAIN}" "${body}" |
      curl -fsS --max-time 20 --url smtp://127.0.0.1:25 \
        --mail-from "${sender_address}" --mail-rcpt "johndoe@${DOMAIN}" \
        --upload-file - >/dev/null
    echo "    + ${subject}"
  }

  seed_mail "Jane Doe" "janedoe@${DOMAIN}" \
    "Q3 deck review" "q3-review" \
    "Hi John,

I added my comments to the Q3 deck. Can you review the final two slides before our meeting?

Jane"
  seed_mail "People Operations" "people@${DOMAIN}" \
    "Complete your team profile" "team-profile" \
    "Please add your working hours and emergency contact to your team profile this week."
  seed_mail "Procurement" "procurement@${DOMAIN}" \
    "Laptop renewal approved" "laptop-renewal" \
    "Your laptop renewal request has been approved. We will send the delivery details shortly."

  # The MTA hands messages to the backend asynchronously. Local demo senders
  # can cause the inbound pipeline to initialize read_at while it resolves both
  # sides of a thread, so first wait for delivery to settle and then make the
  # recipient state explicitly unread through model saves. Saving each access
  # also schedules the Messages search-index refresh.
  mail_delivered=false
  for _ in $(seq 1 20); do
    mail_count=$(kubectl -n mb-messages exec deploy/messages-backend -- \
      python manage.py shell -c "
from core.models import Message
print(Message.objects.filter(
    thread__accesses__mailbox__local_part='johndoe',
    thread__accesses__mailbox__domain__name='${DOMAIN}',
).distinct().count())
" | tail -1)
    if [ "${mail_count}" = "3" ]; then
      mail_delivered=true
      break
    fi
    sleep 1
  done
  [ "${mail_delivered}" = true ] || {
    echo "!! seed-demo: Mail delivery did not converge (expected 3 messages, got ${mail_count:-unknown})" >&2
    exit 1
  }

  kubectl -n mb-messages exec deploy/messages-backend -- \
    python manage.py shell -c "
from core.models import ThreadAccess
accesses = ThreadAccess.objects.filter(
    mailbox__local_part='johndoe',
    mailbox__domain__name='${DOMAIN}',
)
for access in accesses:
    access.read_at = None
    access.save(update_fields=['read_at'])
print(f'    = marked {accesses.count()} demo threads unread')
"

  # Give deferred ingestion/index work time to run before checking the durable
  # database state. This prevents a transient null read_at from passing.
  sleep 2
  mail_state=$(kubectl -n mb-messages exec deploy/messages-backend -- \
    python manage.py shell -c "
from core.models import Message, ThreadAccess
messages = Message.objects.filter(
    thread__accesses__mailbox__local_part='johndoe',
    thread__accesses__mailbox__domain__name='${DOMAIN}',
).distinct().count()
unread = ThreadAccess.objects.filter(
    mailbox__local_part='johndoe',
    mailbox__domain__name='${DOMAIN}',
).filter(ThreadAccess.unread_filter()).count()
print(f'{messages}:{unread}')
" | tail -1)
  [ "${mail_state}" = "3:3" ] || {
    echo "!! seed-demo: Mail reset did not converge (expected 3 messages/3 unread, got ${mail_state:-unknown})" >&2
    exit 1
  }
else
  echo "    messages app is disabled — skipping"
fi

echo "==> [4/4] Chat — reset Jane ↔ John direct message"
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
JT=$(curl -s -X POST "$B/_synapse/admin/v1/users/$JANE/login" -H "$AAT" -H "Content-Type: application/json" -d "{}" | python3 -c "import json,sys;print(json.load(sys.stdin)[\"access_token\"])")
# Keep one stable DM room. Recreating it on every reset leaves purged rooms in
# Element's local cache, where they render as duplicate "Jane Doe" conversations
# even though Synapse only knows about the newest room.
ROOMS=$(curl -s "$B/_matrix/client/v3/user/$JOHN/account_data/m.direct" -H "$AT" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
rooms=d.get(\"$JANE\", []) if isinstance(d,dict) else []
print(\" \".join(x for x in rooms if isinstance(x,str)))")
RID=""
for CANDIDATE in $ROOMS; do
  MEMBERS=$(curl -fsS "$B/_matrix/client/v3/rooms/$CANDIDATE/joined_members" -H "$AT" 2>/dev/null || true)
  VALID=$(printf '%s' "$MEMBERS" | python3 -c "import json,sys
try: d=json.load(sys.stdin).get('joined', {})
except Exception: d={}
print('yes' if '$JOHN' in d and '$JANE' in d else 'no')")
  if [ "$VALID" = yes ] && [ -z "$RID" ]; then
    RID="$CANDIDATE"
    continue
  fi

  # A second live DM must be retired through each user's client API before
  # the admin purge. The leave event removes it from syncing clients; forget
  # prevents it from returning on a later full sync.
  if [ "$VALID" = yes ]; then
    curl -fsS -X POST "$B/_matrix/client/v3/rooms/$CANDIDATE/leave" -H "$AT" -H "Content-Type: application/json" -d '{}' >/dev/null
    curl -fsS -X POST "$B/_matrix/client/v3/rooms/$CANDIDATE/leave" -H "Authorization: Bearer $JT" -H "Content-Type: application/json" -d '{}' >/dev/null
    curl -fsS -X DELETE "$B/_matrix/client/v3/rooms/$CANDIDATE/forget" -H "$AT" >/dev/null
    curl -fsS -X DELETE "$B/_matrix/client/v3/rooms/$CANDIDATE/forget" -H "Authorization: Bearer $JT" >/dev/null
  fi
  STATUS=$(curl -s -o /tmp/demo-room-delete.json -w '%{http_code}' \
    -X DELETE "$B/_synapse/admin/v1/rooms/$CANDIDATE" \
    -H "$AAT" -H "Content-Type: application/json" \
    -d '{"block":false,"purge":true}')
  case "$STATUS" in
    2*|404) echo "    - retired extra DM ${CANDIDATE}" ;;
    *) echo "!! seed-demo: Synapse could not purge ${CANDIDATE} (HTTP ${STATUS})" >&2; cat /tmp/demo-room-delete.json >&2; exit 1 ;;
  esac
done

if [ -z "$RID" ]; then
  # Create a real DM: no name, is_direct, so clients show the other person.
  RID=$(curl -fsS -X POST "$B/_matrix/client/v3/createRoom" -H "$AT" -H "Content-Type: application/json" \
    -d "{\"is_direct\":true,\"invite\":[\"$JANE\"],\"preset\":\"trusted_private_chat\"}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)[\"room_id\"])")
  curl -fsS -X POST "$B/_matrix/client/v3/rooms/$RID/join" -H "Authorization: Bearer $JT" >/dev/null
  i=0
  snd(){ i=$((i+1)); curl -fsS -X PUT "$B/_matrix/client/v3/rooms/$RID/send/m.room.message/seed$i" -H "$1" -H "Content-Type: application/json" -d "{\"msgtype\":\"m.text\",\"body\":\"$2\"}" >/dev/null; }
  snd "$AT" "Hi Jane, did you get the Q3 deck?"
  snd "Authorization: Bearer $JT" "Hey John, yes reviewing it now."
  snd "$AT" "Great, lets sync after standup."
  snd "Authorization: Bearer $JT" "Works for me, see you at 10."
  echo "    + created demo DM thread"
else
  # Wipe the thread's message history before re-seeding, otherwise every daily
  # reset appends another line and the room fills with duplicate "Morning John"
  # messages. purge_history removes events older than the timestamp; purge up to
  # now, then post a fresh short thread so the demo always shows the same clean
  # 1-2 unread messages. The purge is async — poll it to completion so the new
  # messages (sent after) are never caught by it.
  PURGE_ID=$(curl -s -X POST "$B/_synapse/admin/v1/purge_history/$RID" \
    -H "$AAT" -H "Content-Type: application/json" \
    -d "{\"purge_up_to_ts\": $(($(date +%s000) - 1000)), \"delete_local_events\": true}" \
    | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('purge_id',''))
except Exception: print('')")
  if [ -n "$PURGE_ID" ]; then
    for _ in $(seq 1 30); do
      PS=$(curl -s "$B/_synapse/admin/v1/purge_history_status/$PURGE_ID" -H "$AAT" \
        | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('status',''))
except Exception: print('')")
      [ "$PS" = complete ] && break
      [ "$PS" = failed ] && { echo "!! seed-demo: chat history purge failed" >&2; break; }
      sleep 1
    done
  fi
  i=0
  snd(){ i=$((i+1)); curl -fsS -X PUT "$B/_matrix/client/v3/rooms/$RID/send/m.room.message/reset$(date +%s)-$i" -H "$1" -H "Content-Type: application/json" -d "{\"msgtype\":\"m.text\",\"body\":\"$2\"}" >/dev/null; }
  snd "$AT" "Morning Jane, ready for standup?"
  snd "Authorization: Bearer $JT" "Morning John, I left a new comment on the Q3 deck."
  echo "    + reset demo DM thread (purged history, posted fresh)"
fi

# Keep both users' direct-room metadata canonical even if an old entry was
# invalid or an extra room was retired above.
curl -fsS -X PUT "$B/_matrix/client/v3/user/$JOHN/account_data/m.direct" -H "$AT" -H "Content-Type: application/json" -d "{\"$JANE\":[\"$RID\"]}" >/dev/null
curl -fsS -X PUT "$B/_matrix/client/v3/user/$JANE/account_data/m.direct" -H "Authorization: Bearer $JT" -H "Content-Type: application/json" -d "{\"$JOHN\":[\"$RID\"]}" >/dev/null

# --- Team channel: a public room both users are in, with a fresh unread message
# each reset so the portal Chat widget always shows a channel alongside the DM.
TALIAS="%23team:$SERVER"   # #team:<server>, URL-encoded '#'
TRID=$(curl -s "$B/_matrix/client/v3/directory/room/$TALIAS" -H "$AT" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('room_id',''))
except Exception: print('')")
if [ -z "$TRID" ]; then
  TRID=$(curl -fsS -X POST "$B/_matrix/client/v3/createRoom" -H "$AT" -H "Content-Type: application/json" \
    -d "{\"preset\":\"public_chat\",\"name\":\"Team\",\"room_alias_name\":\"team\",\"invite\":[\"$JANE\"]}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)[\"room_id\"])")
  curl -fsS -X POST "$B/_matrix/client/v3/rooms/$TRID/join" -H "Authorization: Bearer $JT" >/dev/null
  echo "    + created #team channel"
else
  # Ensure both are joined (idempotent), then purge history so it stays a clean
  # single fresh message, matching the DM's reset behaviour.
  curl -fsS -X POST "$B/_synapse/admin/v1/join/$TRID" -H "$AAT" -H "Content-Type: application/json" -d "{\"user_id\":\"$JOHN\"}" >/dev/null || true
  curl -fsS -X POST "$B/_synapse/admin/v1/join/$TRID" -H "$AAT" -H "Content-Type: application/json" -d "{\"user_id\":\"$JANE\"}" >/dev/null || true
  TPID=$(curl -s -X POST "$B/_synapse/admin/v1/purge_history/$TRID" -H "$AAT" -H "Content-Type: application/json" \
    -d "{\"purge_up_to_ts\": $(($(date +%s000) - 1000)), \"delete_local_events\": true}" \
    | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('purge_id',''))
except Exception: print('')")
  if [ -n "$TPID" ]; then
    for _ in $(seq 1 30); do
      TPS=$(curl -s "$B/_synapse/admin/v1/purge_history_status/$TPID" -H "$AAT" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('status',''))
except Exception: print('')")
      [ "$TPS" = complete ] && break; [ "$TPS" = failed ] && break; sleep 1
    done
  fi
  echo "    + reset #team channel"
fi
# Fresh unread message from Jane (John has not read it -> shows in the widget).
curl -fsS -X PUT "$B/_matrix/client/v3/rooms/$TRID/send/m.room.message/team$(date +%s)" \
  -H "Authorization: Bearer $JT" -H "Content-Type: application/json" \
  -d "{\"msgtype\":\"m.text\",\"body\":\"Reminder: Q3 deck review at 4pm today. Please add your slides.\"}" >/dev/null
SH

echo "==> Demo reset complete."
