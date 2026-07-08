# Open Suite Element Web image

`ghcr.io/open-suite/element-web` — the pinned upstream `vectorim/element-web`
image with Element's device-verification reminder toasts patched out of the
static bundle at build time.

## Why

Open Suite runs chat without default room encryption (a Slack-like experience,
`synapse-disable-default-e2ee` + `element-e2ee-default-off`). Element still
registers verification-reminder toasts from its compiled bundle, and the config
flag that used to hide them was removed upstream. The only lever left is editing
the shipped bundle.

This used to be a runtime `initContainer` (`11-element-web.sh`) that a bare
`helmfile apply` reverted — so the reminders came back on every re-apply. Baking
the edit into the image makes it survive re-applies (Phase 2.2).

## How it stays honest

`patch-verification-reminders.sh` asserts the exact minified fragments it
rewrites are present before patching and gone after. If an image bump ships a
different bundle, the build fails loudly instead of silently shipping an
un-patched Element. Bump `ELEMENT_TAG` and re-derive the match strings together.

Pinned in the demo values as `container.elementweb` (see `01-deploy.sh`).
