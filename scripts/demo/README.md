# Demo data

Populates the Open Suite demo so every portal widget shows something:

- **Calendar** — a few upcoming events (CalDAV, dates recomputed to stay future)
- **Docs** — a few La Suite documents
- **Files** — a couple of files in Nextcloud (Office → Files)
- **Mail** — a clean inbox with three unread messages
- **Chat** — a fresh unread Jane ↔ John thread (Matrix)

## Setup (once)

Create the `demo-seed` secret in `mb-bureaublad` with:

- `DOMAIN` — e.g. `demo.opensuite.online`
- `NC_LOGIN` — johndoe's Nextcloud login name (the `user_oidc` hash; from a
  one-time `POST /index.php/settings/personal/authtokens` while logged in)
- `NC_PASS` — a Nextcloud app password for johndoe (same call returns it)
- `DEMO_PASS` — johndoe's Keycloak password (used for the La Suite Docs token)

```bash
kubectl -n mb-bureaublad create secret generic demo-seed \
  --from-literal=DOMAIN=... --from-literal=NC_LOGIN=... \
  --from-literal=NC_PASS=... --from-literal=DEMO_PASS=...
```

Matrix needs no extra credentials. `seed-demo.sh` mints a short-lived local
Synapse admin token, provisions John and Jane, purges the old seeded DM, and
creates a fresh unread room.

## Run / daily reset

```bash
./seed-demo.sh          # one-off reset
sudo ./install-cron.sh  # install timer and reset immediately
```

The systemd timer runs at 06:00 UTC and has `Persistent=true`, so a missed run
is caught up after a reboot. Demo deployments install it automatically when
`OPEN_SUITE_DEMO_MODE=true`.

Re-running is scoped to the public demo identities: events upsert by fixed UID,
Docs skip existing titles, Mail deletes only threads visible to the
`johndoe`/`janedoe` mailboxes, and Chat purges only their registered direct
message rooms.

Inspect the last run and next schedule with:

```bash
systemctl status opensuite-demo-reset.service
systemctl list-timers opensuite-demo-reset.timer
journalctl -u opensuite-demo-reset.service
```
