# Open Suite Nextcloud: the pinned upstream image plus our apps baked in.
# The build context must contain the exact, CI-verified whiteboard/ and patched
# user_oidc/ release trees; neither app is downloaded at container startup.
ARG NEXTCLOUD_BASE=registry-1.docker.io/library/nextcloud:34.0.0-apache
FROM ${NEXTCLOUD_BASE}
COPY meetcal/ /usr/src/opensuite/meetcal/
COPY user_oidc/ /usr/src/opensuite/user_oidc/
COPY whiteboard/ /usr/src/opensuite/whiteboard/
COPY hooks/10-opensuite-apps.sh /usr/local/bin/opensuite-sync-apps
COPY hooks/20-opensuite-whiteboard.sh /usr/local/bin/opensuite-configure-whiteboard
# The upstream entrypoint runs post-installation after pre-installation, and
# `occ upgrade` after pre-upgrade. Put our baked app code in place before both;
# before-starting remains the same-version image-update/restart fallback.
RUN chmod +x /usr/local/bin/opensuite-sync-apps /usr/local/bin/opensuite-configure-whiteboard \
 && for phase in pre-installation pre-upgrade before-starting; do \
      ln -s /usr/local/bin/opensuite-sync-apps \
        "/docker-entrypoint-hooks.d/${phase}/10-opensuite-apps.sh"; \
      test "$(readlink "/docker-entrypoint-hooks.d/${phase}/10-opensuite-apps.sh")" \
        = /usr/local/bin/opensuite-sync-apps; \
    done \
 && ln -s /usr/local/bin/opensuite-configure-whiteboard \
      /docker-entrypoint-hooks.d/before-starting/20-opensuite-whiteboard.sh \
 && test "$(sed -n 's:.*<version>\([^<]*\)</version>.*:\1:p' /usr/src/opensuite/whiteboard/appinfo/info.xml)" = 1.5.9 \
 && grep -Fq '<nextcloud min-version="28" max-version="34"/>' /usr/src/opensuite/whiteboard/appinfo/info.xml \
 && grep -Fq "registerEventListener(LoadViewer::class, LoadViewerListener::class)" /usr/src/opensuite/whiteboard/lib/AppInfo/Application.php \
 && grep -Fq "mimes:[\"application/vnd.excalidraw+json\"]" /usr/src/opensuite/whiteboard/js/whiteboard-main.mjs \
 && grep -Fq '"whiteboard": ["application/vnd.excalidraw+json"]' /usr/src/nextcloud/resources/config/mimetypemapping.dist.json \
 && grep -Fq '"application/vnd.excalidraw+json": "whiteboard"' /usr/src/nextcloud/resources/config/mimetypealiases.dist.json
