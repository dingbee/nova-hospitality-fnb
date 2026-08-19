#!/usr/bin/env bash
# NOVA Hospitality — Restaurant & Bar OS — local runtime shared shell helpers.
set -euo pipefail

NOVA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NOVA_LOCAL_DIR="$NOVA_ROOT/local"

# Authoritative environment resolution.
# Order: explicit NOVA_ENV_FILE -> standalone/.env (standalone package) ->
#        local/.env (host appliance install). Exactly one file wins and is
#        exported so every child script inherits the same environment.
nova_resolve_env_file() {
  if [[ -n "${NOVA_ENV_FILE:-}" && -f "$NOVA_ENV_FILE" ]]; then
    echo "$NOVA_ENV_FILE"; return 0
  fi
  if [[ -f "$NOVA_ROOT/standalone/.env" ]]; then
    echo "$NOVA_ROOT/standalone/.env"; return 0
  fi
  echo "${NOVA_ENV_FILE:-$NOVA_LOCAL_DIR/.env}"
}

nova_load_env() {
  local env_file
  env_file="$(nova_resolve_env_file)"
  export NOVA_ENV_FILE="$env_file"
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
  # Relative migration/seed paths in the env file resolve against the repo root.
  case "${NOVA_MIGRATIONS_DIR:-}" in ./*) NOVA_MIGRATIONS_DIR="$NOVA_ROOT/${NOVA_MIGRATIONS_DIR#./}";; esac
  case "${NOVA_SEED_DIR:-}" in ./*) NOVA_SEED_DIR="$NOVA_ROOT/${NOVA_SEED_DIR#./}";; esac
  [[ -n "${NOVA_MIGRATIONS_DIR:-}" ]] && export NOVA_MIGRATIONS_DIR
  [[ -n "${NOVA_SEED_DIR:-}" ]] && export NOVA_SEED_DIR
  : "${NOVA_DB_HOST:=127.0.0.1}"
  : "${NOVA_DB_PORT:=5432}"
  : "${NOVA_DB_NAME:=nova_local}"
  : "${NOVA_DB_SUPERUSER:=nova_superuser}"
  : "${NOVA_DB_AUTHENTICATOR:=nova_authenticator}"
  : "${NOVA_POSTGREST_PORT:=3001}"
  : "${NOVA_POSTGREST_HOST:=127.0.0.1}"
  : "${NOVA_POSTGREST_SCHEMAS:=public,storage}"
  : "${NOVA_GATEWAY_HOST:=0.0.0.0}"
  : "${NOVA_GATEWAY_PORT:=8000}"
  : "${NOVA_GATEWAY_TLS_PORT:=8443}"
  : "${NOVA_TLS_MODE:=auto}"
  : "${NOVA_TLS_DIR:=${NOVA_KEY_DIR:-$NOVA_LOCAL_DIR/keys}/tls}"
  : "${NOVA_TLS_CERT_FILE:=$NOVA_TLS_DIR/gateway.crt}"
  : "${NOVA_TLS_KEY_FILE:=$NOVA_TLS_DIR/gateway.key}"
  : "${NOVA_BACKUP_DIR:=$NOVA_LOCAL_DIR/backups}"
  : "${NOVA_RUN_DIR:=$NOVA_LOCAL_DIR/run}"
  export PGHOST="$NOVA_DB_HOST" PGPORT="$NOVA_DB_PORT" PGUSER="$NOVA_DB_SUPERUSER" PGDATABASE="$NOVA_DB_NAME"
  export PGSSLMODE="${PGSSLMODE:-prefer}"
  [[ -n "${NOVA_DB_SUPERUSER_PASSWORD:-}" ]] && export PGPASSWORD="$NOVA_DB_SUPERUSER_PASSWORD"
  mkdir -p "$NOVA_RUN_DIR"
}

nova_require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "FATAL: required configuration '$name' is not set (see local/.env.example)" >&2
    exit 1
  fi
}

nova_psql() {
  psql -v ON_ERROR_STOP=1 -X -q "$@"
}

# The scheme depends on whether this installation has TLS material, so every
# script asks here instead of hardcoding http://.
nova_gateway_url() {
  local host="${1:-127.0.0.1}"
  if [[ "$NOVA_TLS_MODE" != "off" && -f "$NOVA_TLS_CERT_FILE" && -f "$NOVA_TLS_KEY_FILE" ]]; then
    echo "https://$host:$NOVA_GATEWAY_TLS_PORT"
  else
    echo "http://$host:$NOVA_GATEWAY_PORT"
  fi
}

# Local curl against our own appliance certificate: the CA is pinned, never
# --insecure.
nova_curl() {
  local ca="$NOVA_TLS_DIR/nova-local-ca.crt"
  if [[ -f "$ca" ]]; then curl --cacert "$ca" --resolve "$(hostname):$NOVA_GATEWAY_TLS_PORT:127.0.0.1" "$@"
  else curl "$@"; fi
}

nova_log() { printf '[nova-local] %s\n' "$*"; }