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
set -eu
printf 'BENCH user_oidc start_ms=%s\n' "$(date +%s%3N)"

# The optimized image has already copied user_oidc from /usr/src/opensuite in
# pre-installation. Nextcloud reports that precise state with exit 1; accept no
# download, successful install, warning, or other failure as equivalent.
if install_output="$(php /var/www/html/occ app:install user_oidc 2>&1)"; then
  echo "ERROR: app:install unexpectedly succeeded instead of finding the bundled app" >&2
  exit 1
else
  install_rc="$?"
fi
if [ "${install_rc}" -ne 1 ] || [ "${install_output}" != 'user_oidc already installed' ]; then
  printf 'ERROR: unexpected app:install result (exit %s):\n%s\n' \
    "${install_rc}" "${install_output}" >&2
  exit 1
fi
printf '%s\n' "${install_output}"

# This must succeed; the benchmark is invalid if it times a container with the
# app merely copied but disabled.
php /var/www/html/occ app:enable user_oidc

bundled_version="$(php -r '
  $info = simplexml_load_file("/usr/src/opensuite/user_oidc/appinfo/info.xml");
  if ($info === false) { exit(1); }
  echo (string) $info->version;
')"
installed_version="$(php /var/www/html/occ config:app:get user_oidc installed_version)"
enabled="$(php /var/www/html/occ config:app:get user_oidc enabled)"
if [ -z "${bundled_version}" ] || [ "${installed_version}" != "${bundled_version}" ]; then
  printf 'ERROR: user_oidc installed_version=%s, bundled version=%s\n' \
    "${installed_version}" "${bundled_version}" >&2
  exit 1
fi
if [ "${enabled}" != yes ]; then
  echo "ERROR: user_oidc enabled=${enabled}, expected yes" >&2
  exit 1
fi

status_json="$(php /var/www/html/occ status --output=json)"
printf '%s' "${status_json}" | php -r '
  $status = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
  $valid = ($status["installed"] ?? null) === true
    && ($status["maintenance"] ?? null) === false
    && ($status["needsDbUpgrade"] ?? null) === false;
  if (!$valid) {
    fwrite(STDERR, "ERROR: unexpected Nextcloud status: " . json_encode($status) . PHP_EOL);
    exit(1);
  }
'
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

# Test the built artifact, not only the Dockerfile text. Every lifecycle hook
# must remain executable and resolve to the single installed sync script.
docker run --rm --pull=never --entrypoint sh "${image}" -ec '
  for phase in pre-installation pre-upgrade before-starting; do
    hook="/docker-entrypoint-hooks.d/${phase}/10-opensuite-apps.sh"
    test -L "${hook}"
    test -x "${hook}"
    test "$(readlink -f "${hook}")" = /usr/local/bin/opensuite-sync-apps
  done
'

# Assert the mounted chart-equivalent ini wins over the base image defaults.
docker run --rm --pull=never \
  -e "EXPECTED_JIT=${jit}" \
  -e "EXPECTED_JIT_BUFFER=${jit_buffer}" \
  -v "${tmpdir}/opcache.ini:/usr/local/etc/php/conf.d/zz-opensuite-opcache.ini:ro" \
  --entrypoint php "${image}" -r '
    $expected = [
      "opcache.jit" => getenv("EXPECTED_JIT"),
      "opcache.jit_buffer_size" => getenv("EXPECTED_JIT_BUFFER"),
      "opcache.enable" => "1",
      "opcache.enable_cli" => "1",
      "opcache.validate_timestamps" => "0",
    ];
    foreach ($expected as $key => $value) {
      $actual = ini_get($key);
      if ($actual !== $value) {
        fwrite(STDERR, "ERROR: {$key}={$actual}, expected {$value}\n");
        exit(1);
      }
    }
  '

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
    -e WHITEBOARD_COLLAB_BACKEND_URL=https://localhost/whiteboard \
    -e WHITEBOARD_JWT_SECRET=benchmark-only-whiteboard-secret \
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
    if [ "$(docker inspect -f '{{.State.Running}}' "${nextcloud}")" != true ]; then
      docker logs "${nextcloud}" >&2
      echo "ERROR: Nextcloud exited before answering status.php" >&2
      exit 1
    fi
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
  auth_code="${auth_metrics%%$'\t'*}"
  if [ "${auth_code}" != 200 ]; then
    echo "ERROR: authenticated request returned HTTP ${auth_code}, expected 200" >&2
    exit 1
  fi

  logs="$(docker logs "${nextcloud}" 2>&1)"
  hook_start_count="$(printf '%s\n' "${logs}" \
    | grep -Ec '^BENCH user_oidc start_ms=[0-9]+$' || true)"
  hook_end_count="$(printf '%s\n' "${logs}" \
    | grep -Ec '^BENCH user_oidc end_ms=[0-9]+$' || true)"
  if [ "${hook_start_count}" -ne 1 ] || [ "${hook_end_count}" -ne 1 ]; then
    printf 'ERROR: expected one hook marker pair, found start=%s end=%s\n' \
      "${hook_start_count}" "${hook_end_count}" >&2
    exit 1
  fi
  hook_start="$(printf '%s\n' "${logs}" \
    | sed -n 's/^BENCH user_oidc start_ms=//p')"
  hook_end="$(printf '%s\n' "${logs}" \
    | sed -n 's/^BENCH user_oidc end_ms=//p')"

  printf '%s\t%s\t%s\t%s\n' \
    "${sample}" \
    "$(((ready_ns - start_ns) / 1000000))" \
    "$((hook_end - hook_start))" \
    "${auth_metrics}"
done
