# Open Suite Collabora CODE: the pinned upstream image with the menubar's
# SmartMenus lifecycle fixed in the shipped browser bundle.
ARG COLLABORA_BASE=registry-1.docker.io/collabora/code:26.04.1.4.1@sha256:75859dc9f9084d1877ce36cf96ec86600f495bade33289c9cbc27e0a0ee23b81
ARG PATCHER_BASE=registry-1.docker.io/library/perl:5-slim@sha256:d9e618def9ecf01ac2aafdf1ee39e6ea42833ae84a947b9feb44a677382f3f81

FROM ${COLLABORA_BASE} AS upstream

FROM ${PATCHER_BASE} AS patcher
COPY --from=upstream /usr/share/coolwsd/browser/dist/bundle.js /tmp/bundle.js
COPY patch-smartmenus-lifecycle.pl /tmp/patch-smartmenus-lifecycle.pl
RUN perl /tmp/patch-smartmenus-lifecycle.pl /tmp/bundle.js

FROM upstream
COPY --from=patcher /tmp/bundle.js /usr/share/coolwsd/browser/dist/bundle.js
