#!/bin/sh
# Open Suite disables default room encryption for a Slack-like chat experience.
# Element Web 1.12.21 still registers device-verification reminder toasts from
# its static bundle, and the config feature flag that used to hide them was
# removed upstream. So we patch the shipped bundle directly.
#
# Applied at image BUILD time (see Dockerfile) — not a runtime initContainer —
# so a bare `helmfile apply` cannot revert it. The grep guards make a bundle
# drift fail the build loudly: bump the base tag and re-derive these match
# strings together, never one without the other.
set -eu

APP="${1:-/app}"
js="$(find "${APP}/bundles" -name element-web-app.js | head -1)"
[ -n "${js}" ] || { echo "element-web-app.js not found under ${APP}/bundles" >&2; exit 1; }

# Preconditions: the exact minified fragments this patch rewrites must be present.
grep -F 'F.A.sharedInstance().addOrReplaceToast({key:Ge,title:$e(e),' "${js}" >/dev/null
grep -F 'r.size>0&&o&&!c?at(r):F.A.sharedInstance().dismissToast(rt)' "${js}" >/dev/null
grep -F 'for(const e of a)kt(e);' "${js}" >/dev/null
grep -F 'this.setStateForNewView({view:cR.A.COMPLETE_SECURITY})' "${js}" >/dev/null
grep -F 'this.setStateForNewView({view:cR.A.E2E_SETUP})' "${js}" >/dev/null

perl -0pi -e '
  s/F\.A\.sharedInstance\(\)\.addOrReplaceToast\(\{key:Ge,title:\$e\(e\),/"verify_this_session"===e?F.A.sharedInstance().dismissToast(Ge):F.A.sharedInstance().addOrReplaceToast({key:Ge,title:\$e(e),/g;
  s/r\.size>0&&o&&!c\?at\(r\):F\.A\.sharedInstance\(\)\.dismissToast\(rt\)/F.A.sharedInstance().dismissToast(rt)/g;
  s/for\(const e of a\)kt\(e\);/for(const e of a)void e;/g;
  s/0==f\.r\.instance\.extensions\.cryptoSetup\.SHOW_ENCRYPTION_SETUP_UI\?this\.onShowPostLoginScreen\(\):this\.setStateForNewView\(\{view:cR\.A\.COMPLETE_SECURITY\}\)/this.onShowPostLoginScreen()/g;
  s/XC\.sharedInstance\(\)\.startInitialCryptoSetup\(e,this\.onCompleteSecurityE2eSetupFinished\),this\.setStateForNewView\(\{view:cR\.A\.E2E_SETUP\}\)/this.onShowPostLoginScreen()/g;
  s/t\?this\.setStateForNewView\(\{view:cR\.A\.COMPLETE_SECURITY\}\):this\.onShowPostLoginScreen\(\)/this.onShowPostLoginScreen()/g;
' "${js}"

# Postconditions: the rewrites landed and the originals are gone.
grep -F '"verify_this_session"===e?F.A.sharedInstance().dismissToast(Ge)' "${js}" >/dev/null
! grep -F 'r.size>0&&o&&!c?at(r):F.A.sharedInstance().dismissToast(rt)' "${js}" >/dev/null
! grep -F 'for(const e of a)kt(e);' "${js}" >/dev/null
! grep -F 'this.setStateForNewView({view:cR.A.COMPLETE_SECURITY})' "${js}" >/dev/null
! grep -F 'this.setStateForNewView({view:cR.A.E2E_SETUP})' "${js}" >/dev/null

echo "element-web verification reminders patched at build time in ${js}"
