#!/usr/bin/env bash
# Usage: ./seed-demo.sh
#
# Resets johndoe's public-demo account to a curated, known state every day:
# upcoming calendar events with Meet rooms, La Suite Docs, Nextcloud Files, a
# clean unread Mail inbox, a Deck project board, and a fresh unread chat thread
# between Jane and John. Anything visitors or tests created in those apps is
# removed, so the portal widgets only ever show the curated fixtures.
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

# The direct-access grant is enabled on the meet client only for the duration
# of the run (needed to mint a johndoe token) and re-disabled on exit,
# including on failure. The docs client is re-disabled too: earlier versions
# of this script enabled it.
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

echo "==> [1/6] Files — curated Office files only"
# Visitors and the CI smoke create files in johndoe's home every day. Delete
# every top-level entry that is not a curated file, empty the trash and old
# versions, then re-upload the curated set so its content is pristine too.
FILES_DIR="${SEED_FILES_DIR:-$(cd "$(dirname "$0")" && pwd)/files}"
mapfile -t CURATED_FILES < <(find "${FILES_DIR}" -maxdepth 1 -type f \
  \( -name '*.docx' -o -name '*.xlsx' -o -name '*.pptx' \) -printf '%f\n' | sort)
[ "${#CURATED_FILES[@]}" -gt 0 ] || {
  echo "!! seed-demo: no curated files found in ${FILES_DIR}" >&2; exit 1; }
NC_FILES="${NC}/files/${NC_LOGIN}"
urlquote() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1"; }
listing=$(curl -fsS --max-time 20 -u "${NC_LOGIN}:${NC_PASS}" -H "Host: ${NC_HOST}" \
  -X PROPFIND -H "Depth: 1" "${NC_FILES}/")
mapfile -t EXISTING_FILES < <(printf '%s' "$listing" | python3 -c "import sys, urllib.parse, xml.etree.ElementTree as ET
root = ET.fromstring(sys.stdin.read())
for href in root.iter('{DAV:}href'):
    name = urllib.parse.unquote(href.text.rstrip('/').rsplit('/', 1)[-1])
    if name != sys.argv[1]:
        print(name)" "${NC_LOGIN}")
for name in "${EXISTING_FILES[@]}"; do
  keep=false
  for curated in "${CURATED_FILES[@]}"; do [ "$name" = "$curated" ] && keep=true; done
  [ "$keep" = true ] && continue
  code=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -u "${NC_LOGIN}:${NC_PASS}" \
    -H "Host: ${NC_HOST}" -X DELETE "${NC_FILES}/$(urlquote "$name")")
  case "$code" in
    2*) echo "    - ${name}" ;;
    # Someone has it open in Office right now; the next reset removes it.
    423) echo "    ~ ${name} is locked (open in Office); skipped" ;;
    *) echo "!! seed-demo: DELETE ${name} returned HTTP ${code}" >&2; exit 1 ;;
  esac
done
occ() { kubectl -n mb-nextcloud exec deploy/nextcloud -c nextcloud -- \
  sh -c 'cd /var/www/html && php occ "$@"' occ "$@"; }
occ trashbin:cleanup -- "${NC_LOGIN}" >/dev/null
occ versions:cleanup -- "${NC_LOGIN}" >/dev/null
# The portal Files widget is the Nextcloud activity feed. Start it empty so it
# lists exactly the uploads below (newest first), not yesterday's activity.
NC_DB_USER=$(kubectl -n mb-nextcloud get secret nextcloud-externaldatabase -o jsonpath='{.data.username}' | base64 -d)
NC_DB_PASS=$(kubectl -n mb-nextcloud get secret nextcloud-externaldatabase -o jsonpath='{.data.password}' | base64 -d)
echo "DELETE FROM oc_activity WHERE affecteduser = :'login';" | \
  kubectl -n mb-nextcloud exec -i nextcloud-cluster-rw-0 -c postgresql -- \
  env PGPASSWORD="${NC_DB_PASS}" psql -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "${NC_DB_USER}" -d nextcloud \
  -v login="${NC_LOGIN}" >/dev/null
for curated in "${CURATED_FILES[@]}"; do
  dav PUT "${NC_FILES}/$(urlquote "$curated")" --data-binary @"${FILES_DIR}/${curated}"
  echo "    + ${curated}"
done

echo "==> [2/6] Calendar — upcoming events (each with a Meet link)"
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

# Every "Start instant meeting" click by a visitor leaves a room behind, and
# the Meet widget lists them ahead of the event rooms. Keep only the rooms
# the events above link to.
kubectl -n mb-meet exec -i deploy/meet-backend -- python manage.py shell <<'PY' | tail -1
from core.models import Room, User

KEEP = {"dmo-stnd-upx", "dmo-rviw-qtr", "dmo-oneo-one"}
demo_users = User.objects.filter(email__istartswith="johndoe@")
stale = Room.objects.filter(accesses__user__in=demo_users).exclude(slug__in=KEEP)
ids = list(stale.values_list("pk", flat=True).distinct())
Room.objects.filter(pk__in=ids).delete()
print(f"    - removed {len(ids)} other Meet rooms")
PY

echo "==> [3/6] Docs — curated La Suite documents"
# Hard-delete every document johndoe owns except the curated ones (including
# the trash and any sub-pages visitors added), then reset the curated
# documents' title and content. Runs through the Docs ORM and the converter
# the server-to-server create endpoint uses, so no user token is needed.
kubectl -n mb-docs exec -i deploy/docs-backend -- python manage.py shell <<'PY' | grep '^    '
from core import models
from core.services import mime_types
from core.services.converter_services import Converter
from core.utils.treebeard import create_tree_node_with_retry

# Saved in this order, so the last one is the most recently updated and the
# portal Docs widget lists it first. Docs shows the title above the content,
# so the markdown has no H1, and paragraphs stay on one line because the
# converter keeps soft line breaks.
CURATED = [
    ("Onboarding checklist", """Welcome to the team! Work through this list in your first week.

- [ ] Log in once to Open Suite. Every app uses the same account.
- [ ] Add your working hours and an emergency contact to your team profile.
- [ ] Say hello to Jane in Chat.
- [ ] Join the team standup from the Calendar (the event has a Meet link).
- [ ] Open the **Open Suite website launch** board in Projects and pick a card.
"""),
    ("Q3 plan", """## Goals

1. Launch the new Open Suite website before the end of the quarter.
2. Move the whole team onto shared calendars, chat and video calls.
3. Keep every file and conversation hosted in the EU.

## Milestones

| Month | Milestone |
| --- | --- |
| July | Hosting region chosen, team mail connected |
| August | Accessibility review and onboarding guide |
| September | Launch announcement and website go-live |

## Owners

John owns the launch board. Jane owns the Q3 deck and budget review.
"""),
    ("Welcome to Open Suite", """This is **Docs**, the collaborative editor in Open Suite. Everything here is saved automatically, and anyone you share a document with can edit it with you in real time.

## Try it

- Type `/` to insert headings, lists, tables, images and more.
- Select text to format it or leave a comment.
- Use **Share** to invite a colleague or publish a read-only link.

## The rest of your workspace

- **Mail** and **Chat** for conversations
- **Meet** for video calls, linked from your Calendar events
- **Office** for documents, spreadsheets and presentations
- **Projects** for task boards

This demo resets every morning, so feel free to experiment.
"""),
]

johns = list(models.User.objects.filter(email__istartswith="johndoe@"))
if len(johns) != 1:
    raise SystemExit(f"expected one johndoe Docs user, found {len(johns)}")
john = johns[0]
titles = [title for title, _ in CURATED]

owned_ids = models.DocumentAccess.objects.filter(
    user=john, role=models.RoleChoices.OWNER
).values_list("document_id", flat=True)
owned_roots = models.Document.objects.filter(pk__in=owned_ids, depth=1).order_by("created_at")

keep = {}
remove = []
for doc in owned_roots:
    if doc.title in titles and doc.title not in keep and doc.deleted_at is None:
        keep[doc.title] = doc
    else:
        remove.append(doc.pk)
# Queryset delete on treebeard nodes also removes their descendants.
models.Document.objects.filter(pk__in=remove).delete()
print(f"    - removed {len(remove)} other documents")

converter = Converter()
for title, markdown in CURATED:
    doc = keep.get(title)
    if doc is None:
        doc = create_tree_node_with_retry(
            lambda: models.Document.add_root(title=title, creator=john)
        )
        models.DocumentAccess.objects.create(
            document=doc, role=models.RoleChoices.OWNER, user=john
        )
    else:
        for child in doc.get_children():
            child.delete()
        doc.refresh_from_db()
    doc.title = title
    doc.content = converter.convert(markdown, mime_types.MARKDOWN, mime_types.YJS)
    doc.save()
    print(f"    = {title}")
PY

echo "==> [4/6] Mail — reset demo inbox and add unread messages"
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

echo "==> [5/6] Projects — Open Suite launch board"
DECK_API="http://${NC_SVC}:8080/index.php/apps/deck/api/v1.0"
DECK_OCS="http://${NC_SVC}:8080/ocs/v2.php/apps/deck/api/v1.0"
deck_request() { # method path [JSON body] [base URL]
  local method="$1" path="$2" body="${3:-}" base="${4:-$DECK_API}" response status payload
  local args=(-sS --max-time 20 -u "${NC_LOGIN}:${NC_PASS}" -H "Host: ${NC_HOST}" \
    -H "OCS-APIRequest: true" -H "Accept: application/json")
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" --data-binary "$body")
  fi
  response=$(curl "${args[@]}" -X "$method" -w $'\n%{http_code}' "${base}${path}")
  status=${response##*$'\n'}
  payload=${response%$'\n'*}
  case "$status" in
    2*) printf '%s' "$payload" ;;
    *) echo "!! seed-demo: Deck ${method} ${path} returned HTTP ${status}" >&2; return 1 ;;
  esac
}

DECK_BOARD_TITLE="Open Suite website launch"
# Visitors move, add and delete cards, and Deck seeds a "Welcome to Nextcloud
# Deck!" board on first login. Delete every board johndoe owns and rebuild the
# curated one, so the Projects widget always shows the same single board.
boards=$(deck_request GET "/boards")
mapfile -t old_boards < <(printf '%s' "$boards" | python3 -c "import json,sys
login = sys.argv[1]
for board in json.load(sys.stdin):
    owner = board.get('owner') or {}
    if owner.get('uid') == login and not board.get('deletedAt', 0):
        print(board['id'])" "$NC_LOGIN")
for old_board in "${old_boards[@]}"; do
  deck_request DELETE "/boards/${old_board}" >/dev/null
done
echo "    - removed ${#old_boards[@]} boards"

board_id=$(deck_request POST "/boards" \
  "{\"title\":\"${DECK_BOARD_TITLE}\",\"color\":\"E85D4A\"}" |
  python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "    + ${DECK_BOARD_TITLE}"

# A new board comes with Deck's default lists; replace them with ours.
mapfile -t default_stacks < <(deck_request GET "/boards/${board_id}/stacks" |
  python3 -c "import json,sys
for stack in json.load(sys.stdin): print(stack['id'])")
for stack in "${default_stacks[@]}"; do
  deck_request DELETE "/boards/${board_id}/stacks/${stack}" >/dev/null
done
make_stack() { # title order
  deck_request POST "/boards/${board_id}/stacks" "{\"title\":\"$1\",\"order\":$2}" |
    python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"
}
todo_id=$(make_stack "To do" 0)
doing_id=$(make_stack "In progress" 1)
done_id=$(make_stack "Done" 2)

make_card() { # stack id, title, description
  deck_request POST "/boards/${board_id}/stacks/$1/cards" \
    "{\"title\":\"$2\",\"description\":\"$3\"}" >/dev/null
  echo "    + $2"
}
make_card "$todo_id" "Finalise accessibility review" "Check keyboard navigation and contrast before launch."
make_card "$todo_id" "Prepare launch announcement" "Draft the public launch note for the team."
make_card "$doing_id" "Review onboarding guide" "Make the first-run path clear for new colleagues."
make_card "$done_id" "Choose hosting region" "EU-hosted infrastructure selected."
make_card "$done_id" "Connect team mail" "Mail is available from the shared Open Suite header."

# Mark the final list as Deck's semantic done column. This is idempotent and
# also marks cards in that list complete, which powers the portal progress.
deck_request PUT "/stacks/${done_id}/done" \
  "{\"boardId\":${board_id},\"isDone\":true}" "$DECK_OCS" >/dev/null

echo "==> [6/6] Chat — reset Jane ↔ John direct message"
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
  #
  # Purging events does not decrement Synapse's per-room unread counter, so
  # without a read receipt first the badge grew by one every day (44 by
  # November). Mark the old history read as John, then purge.
  LAST_EVENT=$(curl -fsS "$B/_matrix/client/v3/rooms/$RID/messages?dir=b&limit=1" -H "$AT" | python3 -c "import json,sys
chunk = json.load(sys.stdin).get('chunk', [])
print(chunk[0]['event_id'] if chunk else '')")
  if [ -n "$LAST_EVENT" ]; then
    curl -fsS -X POST "$B/_matrix/client/v3/rooms/$RID/read_markers" -H "$AT" -H "Content-Type: application/json" \
      -d "{\"m.fully_read\":\"$LAST_EVENT\",\"m.read\":\"$LAST_EVENT\"}" >/dev/null
  fi
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
SH

echo "==> Demo reset complete."
