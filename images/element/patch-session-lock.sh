#!/bin/sh
# Open Suite: allow Element in as many tabs/windows as the user likes (like
# Google Workspace). Element enforces a single active session with a cross-tab
# lock: a second tab shows "Open Suite is open in another window — Continue",
# the displaced tab shows "connected in another tab". Two code paths enforce it:
#   - init.js: the real SessionLock (getSessionLock -> ie()), which runs at
#     startup and renders the "another window" acquire prompt.
#   - element-web-app.js: a session-start guard that re-checks the lock.
# Neutralise both so every tab just loads. Default chat is non-E2EE (see
# patch-verification-reminders / synapse-disable-default-e2ee), so there is no
# crypto store to contend across tabs.
#
# Build-time patch (see Dockerfile), so a bare helmfile apply cannot revert it.
set -eu

APP="${1:-/app}"
app_js="$(find "${APP}/bundles" -name element-web-app.js | head -1)"
init_js="$(find "${APP}/bundles" -name init.js | head -1)"
[ -n "${app_js}" ] || { echo "element-web-app.js not found under ${APP}/bundles" >&2; exit 1; }
[ -n "${init_js}" ] || { echo "init.js not found under ${APP}/bundles" >&2; exit 1; }

# Preconditions: the exact lock code is present in each file.
grep -F 'if(e&&!await e.getSessionLock(()=>this.onSessionLockStolen()))return;' "${app_js}" >/dev/null
grep -F 'async getSessionLock(e){return ie(e)}' "${init_js}" >/dev/null

# init.js: make getSessionLock always acquire immediately (no ping/claim wait,
# no acquire prompt, no steal). This is the primary bypass.
perl -0pi -e 's/async getSessionLock\(e\)\{return ie\(e\)\}/async getSessionLock(e){return!0}/g;' "${init_js}"

# element-web-app.js: drop the redundant session-start guard.
perl -0pi -e 's/if\(e&&!await e\.getSessionLock\(\(\)=>this\.onSessionLockStolen\(\)\)\)return;//g;' "${app_js}"

# Postconditions: the lock code is gone from both.
grep -F 'async getSessionLock(e){return!0}' "${init_js}" >/dev/null
! grep -F 'async getSessionLock(e){return ie(e)}' "${init_js}" >/dev/null
! grep -F 'if(e&&!await e.getSessionLock(()=>this.onSessionLockStolen()))return;' "${app_js}" >/dev/null

echo "element-web single-tab session lock removed at build time (init.js + element-web-app.js)"
