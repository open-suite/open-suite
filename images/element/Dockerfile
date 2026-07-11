# Open Suite Element Web: the pinned upstream image with the device-verification
# reminder toasts patched out of the static bundle at build time (Phase 2.2).
# Replaces the runtime initContainer surgery that a helmfile apply reverted.
#
# The patch needs perl (multiline substitutions), which the nginx base lacks and
# whose package manager differs by base distro/arch. So patch a copy of /app in
# a perl image, then copy the result back into the pristine upstream image — the
# final image differs only by the patched bundle and nginx performance template.
ARG ELEMENT_BASE=registry-1.docker.io/vectorim/element-web:v1.12.21

FROM ${ELEMENT_BASE} AS upstream

FROM perl:5-slim AS patcher
COPY --from=upstream /app /app
COPY patch-verification-reminders.sh /tmp/patch-verification-reminders.sh
RUN sh /tmp/patch-verification-reminders.sh /app

FROM ${ELEMENT_BASE}
COPY --from=patcher /app /app
COPY opensuite-performance.conf /etc/nginx/templates/opensuite-performance.conf.template
