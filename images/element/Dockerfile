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

# The upstream image already contains /app. Using it as the final stage and
# copying our patched /app over that directory keeps both complete trees in the
# registry layers. Flatten the non-app runtime separately so the published
# image contains Element exactly once. COPY preserves the upstream filesystem
# metadata; the scratch final stage deliberately re-declares its runtime
# contract below rather than silently losing inherited settings.
FROM upstream AS runtime-files
USER root
RUN rm -rf /app

FROM registry-1.docker.io/library/perl:5-slim AS patcher
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

FROM scratch
COPY --from=runtime-files / /
COPY --from=patcher /app /app
COPY --from=patcher /tmp/default.conf.template /etc/nginx/templates/default.conf.template
COPY opensuite-performance.conf /etc/nginx/templates/opensuite-performance.conf.template

# Keep these in lockstep with ELEMENT_BASE. ci/test-element-image-runtime.mjs
# guards the settings that a scratch stage cannot inherit.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NGINX_VERSION=1.31.2 \
    PKG_RELEASE=1 \
    DYNPKG_RELEASE=1 \
    ELEMENT_WEB_PORT=80
EXPOSE 8080
STOPSIGNAL SIGQUIT
WORKDIR /
USER nginx
HEALTHCHECK --start-period=5s CMD wget -q --spider http://localhost:$ELEMENT_WEB_PORT/config.json
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
