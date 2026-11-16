# Demo data

Resets johndoe's public-demo account every morning so every portal widget
shows the same curated content, and nothing visitors or tests created:

- **Files** — exactly the Office files in [`files/`](files/) (everything
  else in johndoe's home, the trash, and old versions is deleted; the
  activity feed that drives the Files widget is restarted)
- **Calendar** — three upcoming events, each linking a public Meet room
- **Meet** — only those three event rooms
- **Docs** — three La Suite documents with fixed title and content; every
  other document johndoe owns is deleted
- **Mail** — a clean inbox with three unread messages
- **Projects** — one freshly rebuilt Deck board; every other board is deleted
- **Chat** — a fresh Jane ↔ John thread with one unread message

To change the Office files, edit and run `files/make-files.py` (instructions
in its docstring). Docs content lives in `seed-demo.sh` as markdown.

## Setup (once)

Create the `demo-seed` secret in `mb-bureaublad` with:

- `DOMAIN` — e.g. `demo.opensuite.online`
- `NC_LOGIN` — johndoe's Nextcloud login name (the `user_oidc` hash; from a
  one-time `POST /index.php/settings/personal/authtokens` while logged in)
- `NC_PASS` — a Nextcloud app password for johndoe (same call returns it)
- `DEMO_PASS` — johndoe's Keycloak password (used for the Meet token)

```bash
kubectl -n mb-bureaublad create secret generic demo-seed \
  --from-literal=DOMAIN=... --from-literal=NC_LOGIN=... \
  --from-literal=NC_PASS=... --from-literal=DEMO_PASS=...
```

Matrix needs no extra credentials. `seed-demo.sh` mints a short-lived local
Synapse admin token, provisions John and Jane, marks the old thread read,
purges it, and posts fresh messages.

## Run / daily reset

```bash
./seed-demo.sh          # one-off reset
sudo ./install-cron.sh  # install script, files and timer; reset immediately
```

The systemd timer runs at 06:00 UTC and has `Persistent=true`, so a missed run
is caught up after a reboot. Demo deployments install it automatically when
`OPEN_SUITE_DEMO_MODE=true`.

All deletions are scoped to the public demo identities (johndoe/janedoe). A
file someone has open in Office at reset time is locked and skipped; the next
reset removes it.

Inspect the last run and next schedule with:

```bash
systemctl status opensuite-demo-reset.service
systemctl list-timers opensuite-demo-reset.timer
tail -n 60 /var/log/opensuite-demo-reset.log
```
