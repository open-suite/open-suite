#!/bin/sh
# Open Suite: allow Element in as many tabs/windows as the user likes (like
# Google Workspace). Element Web enforces a single active session with a
# cross-tab lock: a second tab shows "Open Suite is open in another window —
# Continue", and the displaced tab shows "connected in another tab". For a
# shared workspace that is hostile, so we skip the lock.
#
# The lock is gated by one statement at session start:
#   if(e&&!await e.getSessionLock(()=>this.onSessionLockStolen()))return;
# Removing it means the app never acquires/steals the lock and never renders
# the LOCK / LOCK_STOLEN views; each tab just loads. Default chat is non-E2EE
# (see patch-verification-reminders / synapse-disable-default-e2ee), so there
# is no crypto store to contend across tabs.
#
# Build-time patch (see Dockerfile), so a bare helmfile apply cannot revert it.
set -eu

APP="${1:-/app}"
js="$(find "${APP}/bundles" -name element-web-app.js | head -1)"
[ -n "${js}" ] || { echo "element-web-app.js not found under ${APP}/bundles" >&2; exit 1; }

# Precondition: the exact lock guard is present.
grep -F 'if(e&&!await e.getSessionLock(()=>this.onSessionLockStolen()))return;' "${js}" >/dev/null

perl -0pi -e 's/if\(e&&!await e\.getSessionLock\(\(\)=>this\.onSessionLockStolen\(\)\)\)return;//g;' "${js}"

# Postcondition: the guard is gone.
! grep -F 'if(e&&!await e.getSessionLock(()=>this.onSessionLockStolen()))return;' "${js}" >/dev/null

echo "element-web single-tab session lock removed at build time in ${js}"
