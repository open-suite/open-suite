#!/usr/bin/env bash

# Shared host-state helpers. Callers must set STATE_DIR before sourcing when
# using a non-default location in tests.
STATE_DIR="${STATE_DIR:-/etc/mijnbureau}"

opensuite_prepare_state_dir() {
  install -d -m 0700 "${STATE_DIR}"
  chmod 0700 "${STATE_DIR}"
}

opensuite_write_state() { # mode path value
  local mode="$1" path="$2" value="$3" tmp
  tmp="$(mktemp "${STATE_DIR}/.state.XXXXXX")"
  chmod 0600 "${tmp}"
  printf '%s' "${value}" > "${tmp}"
  chmod "${mode}" "${tmp}"
  mv -f "${tmp}" "${path}"
}

opensuite_record_master_fingerprint() { # password
  local password="$1" path="${STATE_DIR}/master-password.fingerprint" tmp
  tmp="$(mktemp "${STATE_DIR}/.master-password.fingerprint.XXXXXX")"
  chmod 0600 "${tmp}"
  printf '%s' "${password}" | python3 -c '
import hashlib
import os
import sys

password = sys.stdin.buffer.read()
salt = os.urandom(16)
digest = hashlib.pbkdf2_hmac("sha256", password, salt, 600_000)
print(f"pbkdf2-sha256:600000:{salt.hex()}:{digest.hex()}")
' > "${tmp}"
  mv -f "${tmp}" "${path}"
}

opensuite_master_fingerprint_matches() { # password
  local password="$1" path="${STATE_DIR}/master-password.fingerprint"
  printf '%s' "${password}" | python3 -c '
import hashlib
import hmac
import pathlib
import sys

password = sys.stdin.buffer.read()
algorithm, rounds, salt_hex, expected_hex = pathlib.Path(sys.argv[1]).read_text().strip().split(":")
if algorithm != "pbkdf2-sha256":
    raise SystemExit(2)
actual = hashlib.pbkdf2_hmac("sha256", password, bytes.fromhex(salt_hex), int(rounds))
raise SystemExit(0 if hmac.compare_digest(actual, bytes.fromhex(expected_hex)) else 1)
' "${path}"
}

opensuite_guard_install_identity() { # domain password
  local domain="$1" password="$2" existing_domain="" fingerprint
  fingerprint="${STATE_DIR}/master-password.fingerprint"
  [ -f "${STATE_DIR}/domain" ] && existing_domain="$(cat "${STATE_DIR}/domain")"

  if [ -n "${existing_domain}" ] && [ "${existing_domain}" != "${domain}" ]; then
    echo "ERROR: this host is already configured for ${existing_domain}, not ${domain}." >&2
    exit 2
  fi

  if [ -s "${fingerprint}" ]; then
    if ! opensuite_master_fingerprint_matches "${password}"; then
      echo "ERROR: master password does not match the password used for this installation." >&2
      echo "Refusing to render or apply credentials. Use the documented rotation procedure instead." >&2
      exit 2
    fi
    chmod 0600 "${fingerprint}"
    return 0
  fi

  if [ -n "${existing_domain}" ] && [ "${OPEN_SUITE_ADOPT_MASTER_PASSWORD:-false}" != "true" ]; then
    echo "ERROR: existing installation has no master-password fingerprint." >&2
    echo "Re-run once with OPEN_SUITE_ADOPT_MASTER_PASSWORD=true after verifying the original password." >&2
    exit 2
  fi

  opensuite_record_master_fingerprint "${password}"
}

opensuite_read_master_password() {
  local password_file="${OPEN_SUITE_MASTER_PASSWORD_FILE:-}"
  if [ -n "${MIJNBUREAU_MASTER_PASSWORD:-}" ]; then
    printf '%s' "${MIJNBUREAU_MASTER_PASSWORD}"
    return 0
  fi
  if [ -n "${password_file}" ]; then
    if [ ! -r "${password_file}" ]; then
      echo "ERROR: cannot read OPEN_SUITE_MASTER_PASSWORD_FILE=${password_file}" >&2
      return 2
    fi
    cat "${password_file}"
    return 0
  fi
  if [ -r /dev/tty ]; then
    local entered
    read -r -s -p "Open Suite master password: " entered </dev/tty
    printf '\n' >/dev/tty
    printf '%s' "${entered}"
    return 0
  fi
  echo "ERROR: set MIJNBUREAU_MASTER_PASSWORD or OPEN_SUITE_MASTER_PASSWORD_FILE." >&2
  return 2
}
