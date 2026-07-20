#!/usr/bin/env bash
# Reproduce the fresh-start samples documented in README.md.
# Usage: sudo ./benchmark-startup.sh IMAGE JIT_MODE [SAMPLES]
# JIT_MODE is "on" for the PHP 8.4 image default or "off" for Open Suite.
set -euo pipefail

image="${1:?usage: $0 IMAGE JIT_MODE [SAMPLES]}"
jit_mode="${2:?usage: $0 IMAGE JIT_MODE [SAMPLES]}"
samples="${3:-3}"

case "${jit_mode}" in
  on)
    jit='1255'
    jit_buffer='8M'
    ;;
  off)
    jit='disable'
    jit_buffer='0'
    ;;
  *)
    echo "ERROR: JIT_MODE must be on or off" >&2
    exit 2
    ;;
esac

for command in docker curl; do
  command -v "${command}" >/dev/null || {
    echo "ERROR: missing command: ${command}" >&2
    exit 1
  }
done

id="opensuite-nc-bench-$$"
network="${id}"
postgres="${id}-postgres"
redis="${id}-redis"
nextcloud="${id}-nextcloud"
html_volume="${id}-html"
postgres_volume="${id}-postgres"
tmpdir="$(mktemp -d)"

cleanup() {
  docker rm -f "${nextcloud}" "${postgres}" "${redis}" >/dev/null 2>&1 || true
  docker volume rm "${html_volume}" "${postgres_volume}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
  rm -rf "${tmpdir}"
}
trap cleanup EXIT

mkdir -p "${tmpdir}/post-installation"
cat >"${tmpdir}/post-installation/user_oidc.sh" <<'EOF'
#!/bin/bash
set -u
printf 'BENCH user_oidc start_ms=%s\n' "$(date +%s%3N)"
php /var/www/html/occ status >/dev/null
php /var/www/html/occ app:install user_oidc
php /var/www/html/occ app:enable user_oidc
printf 'BENCH user_oidc end_ms=%s\n' "$(date +%s%3N)"
EOF
chmod +x "${tmpdir}/post-installation/user_oidc.sh"

cat >"${tmpdir}/apcu.ini" <<'EOF'
apc.enabled=1
apc.enable_cli=1
apc.shm_size=128M
EOF
cat >"${tmpdir}/opcache.ini" <<EOF
opcache.enable=1
opcache.enable_cli=1
opcache.memory_consumption=256
opcache.interned_strings_buffer=32
opcache.max_accelerated_files=50000
opcache.validate_timestamps=0
opcache.revalidate_freq=0
opcache.save_comments=1
opcache.jit=${jit}
opcache.jit_buffer_size=${jit_buffer}
EOF

docker network create "${network}" >/dev/null
docker volume create "${postgres_volume}" >/dev/null
docker run -d --name "${postgres}" --network "${network}" --pull=never \
  -e POSTGRES_DB=nextcloud \
  -e POSTGRES_USER=nextcloud \
  -e POSTGRES_PASSWORD=benchmark-password \
  -v "${postgres_volume}:/var/lib/postgresql/data" \
  postgres:17-bookworm >/dev/null
docker run -d --name "${redis}" --network "${network}" --pull=never \
  redis:8-bookworm >/dev/null

for attempt in $(seq 1 120); do
  if docker exec "${postgres}" pg_isready -U nextcloud -d nextcloud >/dev/null 2>&1; then
    break
  fi
  if [ "${attempt}" = 120 ]; then
    echo "ERROR: PostgreSQL did not become ready" >&2
    exit 1
  fi
  sleep 0.25
done

printf 'sample\tstartup_to_status_ms\tuser_oidc_hook_ms\tauth_code\tauth_seconds\n'
for sample in $(seq 1 "${samples}"); do
  docker rm -f "${nextcloud}" >/dev/null 2>&1 || true
  docker volume rm "${html_volume}" >/dev/null 2>&1 || true
  docker volume create "${html_volume}" >/dev/null
  docker exec "${postgres}" dropdb --force -U nextcloud nextcloud
  docker exec "${postgres}" createdb -U nextcloud nextcloud

  start_ns="$(date +%s%N)"
  docker run -d --name "${nextcloud}" --network "${network}" --pull=never \
    -p 127.0.0.1::80 \
    -e NEXTCLOUD_ADMIN_USER=benchmark-admin \
    -e NEXTCLOUD_ADMIN_PASSWORD=benchmark-password \
    -e NEXTCLOUD_TRUSTED_DOMAINS=localhost \
    -e POSTGRES_DB=nextcloud \
    -e POSTGRES_USER=nextcloud \
    -e POSTGRES_PASSWORD=benchmark-password \
    -e "POSTGRES_HOST=${postgres}" \
    -e "REDIS_HOST=${redis}" \
    -v "${html_volume}:/var/www/html" \
    -v "${tmpdir}/post-installation:/docker-entrypoint-hooks.d/post-installation:ro" \
    -v "${tmpdir}/apcu.ini:/usr/local/etc/php/conf.d/zz-opensuite-apcu.ini:ro" \
    -v "${tmpdir}/opcache.ini:/usr/local/etc/php/conf.d/zz-opensuite-opcache.ini:ro" \
    "${image}" >/dev/null
  port="$(docker port "${nextcloud}" 80/tcp | head -n 1 | sed 's/.*://')"

  code=''
  for attempt in $(seq 1 3000); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:${port}/status.php" 2>/dev/null || true)"
    [ "${code}" = 200 ] && break
    if [ "${attempt}" = 3000 ]; then
      docker logs "${nextcloud}" >&2
      echo "ERROR: Nextcloud did not answer status.php" >&2
      exit 1
    fi
    sleep 0.02
  done
  ready_ns="$(date +%s%N)"

  auth_metrics="$(curl -sS \
    -u benchmark-admin:benchmark-password \
    -H 'OCS-APIRequest: true' \
    -o /dev/null \
    -w $'%{http_code}\t%{time_total}' \
    "http://127.0.0.1:${port}/ocs/v2.php/cloud/user?format=json")"
  hook_start="$(docker logs "${nextcloud}" 2>&1 \
    | sed -n 's/.*BENCH user_oidc start_ms=//p' | tail -n 1)"
  hook_end="$(docker logs "${nextcloud}" 2>&1 \
    | sed -n 's/.*BENCH user_oidc end_ms=//p' | tail -n 1)"

  printf '%s\t%s\t%s\t%s\n' \
    "${sample}" \
    "$(((ready_ns - start_ns) / 1000000))" \
    "$((hook_end - hook_start))" \
    "${auth_metrics}"
done
