#!/bin/sh
# Runs after app source synchronization and after any core/app upgrade, but
# before Apache starts. This covers fresh installs, persisted-volume upgrades,
# same-core-version image changes and ordinary restarts.
set -eu

# A manual web installation has no config yet. Automated installs reach this
# hook only after maintenance:install and can be reconciled immediately.
if [ ! -f /var/www/html/config/config.php ]; then
  exit 0
fi

: "${WHITEBOARD_COLLAB_BACKEND_URL:?missing Whiteboard collaboration backend URL}"
: "${WHITEBOARD_JWT_SECRET:?missing Whiteboard JWT secret}"

php /var/www/html/occ app:enable whiteboard
php /var/www/html/occ config:app:set whiteboard collabBackendUrl \
  --value="${WHITEBOARD_COLLAB_BACKEND_URL}"
php /var/www/html/occ config:app:set whiteboard jwt_secret_key \
  --value="${WHITEBOARD_JWT_SECRET}"
