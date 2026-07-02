# Demo data

Populates the Open Suite demo so every portal widget shows something:

- **Calendar** — a few upcoming events (CalDAV, dates recomputed to stay future)
- **Docs** — a few La Suite documents
- **Files** — a couple of files in Nextcloud (Office → Files)
- **Chat** — a short Jane ↔ John thread (Matrix)

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

Matrix needs no extra creds — `seed-demo.sh` registers a `seedadmin` admin user
via Synapse's registration shared secret (first run; plain login after) and
uses the admin API to provision John and Jane and seed the room.

## Run / daily reset

```bash
./seed-demo.sh          # one-off, idempotent
sudo ./install-cron.sh  # daily refresh at 03:00 via /etc/cron.d
```

Re-running is safe: events upsert by fixed UID, files overwrite, docs skip if
the title exists, and the chat room is only seeded if none exists yet.
