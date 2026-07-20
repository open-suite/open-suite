# Open Suite Element Web: the pinned upstream image with the device-verification
# reminder toasts patched out of the static bundle at build time (Phase 2.2).
# Replaces the runtime initContainer surgery that a helmfile apply reverted.
#
# The patch needs perl (multiline substitutions), which the nginx base lacks and
# whose package manager differs by base distro/arch. So patch a copy of /app in
# a perl image, then copy the result back into the pristine upstream image — the
# final image differs only by the patched bundle and nginx performance template.
ARG ELEMENT_BASE=registry-1.docker.io/vectorim/element-web:v1.12.24-rc.1

FROM ${ELEMENT_BASE} AS upstream

FROM perl:5-slim AS patcher
COPY --from=upstream /app /app
COPY --from=upstream /etc/nginx/templates/default.conf.template /tmp/default.conf.template
COPY patch-verification-reminders.sh /tmp/patch-verification-reminders.sh
COPY patch-startup-preload.sh /tmp/patch-startup-preload.sh
COPY patch-mobile-web.sh /tmp/patch-mobile-web.sh
COPY patch-session-lock.sh /tmp/patch-session-lock.sh
COPY patch-cache-bust.sh /tmp/patch-cache-bust.sh
COPY precompress-bundles.sh /tmp/precompress-bundles.sh
RUN sh /tmp/patch-verification-reminders.sh /app \
    && sh /tmp/patch-startup-preload.sh /app \
    && sh /tmp/patch-mobile-web.sh /tmp/default.conf.template \
    && sh /tmp/patch-session-lock.sh /app \
    && sh /tmp/patch-cache-bust.sh /app \
    && sh /tmp/precompress-bundles.sh /app

FROM ${ELEMENT_BASE}
COPY --from=patcher /app /app
COPY --from=patcher /tmp/default.conf.template /etc/nginx/templates/default.conf.template
COPY opensuite-performance.conf /etc/nginx/templates/opensuite-performance.conf.template
