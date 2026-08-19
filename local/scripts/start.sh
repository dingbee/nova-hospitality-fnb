#!/usr/bin/env bash
# PRODUCTIZATION-3 Phase 8 — start the local runtime in dependency order:
#   PostgreSQL -> PostgREST -> gateway
# Each stage is health-gated, so a terminal never reaches a half-started stack.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env
nova_require NOVA_DB_AUTHENTICATOR_PASSWORD

KEY_DIR="${NOVA_KEY_DIR:-$NOVA_LOCAL_DIR/keys}"
export NOVA_KEY_DIR="$KEY_DIR"
export NOVA_JWT_PRIVATE_KEY_FILE="${NOVA_JWT_PRIVATE_KEY_FILE:-$KEY_DIR/jwt-private.pem}"
RENDERED="$NOVA_RUN_DIR/postgrest.conf"

wait_for() { # wait_for <label> <command...>
  local label="$1"; shift
  for _ in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then nova_log "$label ready"; return 0; fi
    sleep 0.5
  done
  echo "FATAL: $label did not become ready" >&2
  return 1
}

# 1. PostgreSQL ---------------------------------------------------------------
wait_for "PostgreSQL" pg_isready -h "$NOVA_DB_HOST" -p "$NOVA_DB_PORT"

# 2. Signing key + PostgREST ---------------------------------------------------
[[ -f "$NOVA_JWT_PRIVATE_KEY_FILE" ]] || bash "$NOVA_LOCAL_DIR/scripts/gen-keys.sh"

# The signing key and the environment file are the only local secrets on the
# appliance; a terminal user account must never be able to read them.
chmod 600 "$NOVA_JWT_PRIVATE_KEY_FILE"
[[ -f "${NOVA_ENV_FILE:-$NOVA_LOCAL_DIR/.env}" ]] && chmod 600 "${NOVA_ENV_FILE:-$NOVA_LOCAL_DIR/.env}"

# TLS material for the LAN origin (per installation; no cloud dependency).
if [[ "${NOVA_TLS_MODE:-auto}" != "off" ]]; then
  [[ -f "$NOVA_TLS_CERT_FILE" ]] || bash "$NOVA_LOCAL_DIR/scripts/gen-tls.sh"
  chmod 600 "$NOVA_TLS_KEY_FILE" "$NOVA_TLS_DIR/nova-local-ca.key" 2>/dev/null || true
  export NOVA_TLS_MODE NOVA_TLS_DIR NOVA_TLS_CERT_FILE NOVA_TLS_KEY_FILE NOVA_GATEWAY_TLS_PORT
fi

export NOVA_DB_HOST NOVA_DB_PORT NOVA_DB_NAME NOVA_DB_AUTHENTICATOR NOVA_DB_AUTHENTICATOR_PASSWORD
export NOVA_POSTGREST_HOST NOVA_POSTGREST_PORT NOVA_POSTGREST_SCHEMAS
# Rendered with bash only — the appliance must not depend on gettext/envsubst.
# Only ${VAR} expansion is intended: backticks, $(...) and backslashes are
# escaped first so a template comment can never execute a command.
render_template() {
  local line safe
  while IFS= read -r line; do
    safe=${line//\\/\\\\}
    safe=${safe//\"/\\\"}
    safe=${safe//\`/\\\`}
    safe=${safe//\$(/\\\$(}
    eval "printf '%s\n' \"$safe\""
  done < "$1"
}
render_template "$NOVA_LOCAL_DIR/config/postgrest.conf.template" > "$RENDERED"
chmod 600 "$RENDERED"

"${NOVA_POSTGREST_BIN:-postgrest}" "$RENDERED" > "$NOVA_RUN_DIR/postgrest.log" 2>&1 &
echo $! > "$NOVA_RUN_DIR/postgrest.pid"
wait_for "PostgREST" curl -sf -o /dev/null "http://$NOVA_POSTGREST_HOST:$NOVA_POSTGREST_PORT/"

# 3. Application UI bundle ----------------------------------------------------
# Bound to this appliance's origin before the gateway accepts terminals.
BUNDLE_DIR="${NOVA_APP_BUNDLE_DIR:-$NOVA_ROOT/dist}"
if [[ -d "$BUNDLE_DIR/client" ]]; then
  bash "$NOVA_LOCAL_DIR/scripts/verify-bundle.sh" "$BUNDLE_DIR"
  bash "$NOVA_LOCAL_DIR/scripts/stamp-ui.sh" || nova_log "WARNING: could not bind UI bundle origin"
else
  nova_log "WARNING: no application UI bundle at $BUNDLE_DIR — terminals will report the UI unavailable"
fi
export NOVA_APP_BUNDLE_DIR="$BUNDLE_DIR"

# 4. Gateway -------------------------------------------------------------------
# The gateway must never inherit hosted backend configuration from the
# developer shell or a repository .env (4F): those variables are stripped and
# the appliance's own values are supplied explicitly.
( cd "$NOVA_ROOT" && env -u VITE_SUPABASE_URL -u VITE_SUPABASE_PUBLISHABLE_KEY -u VITE_SUPABASE_ANON_KEY \
    -u VITE_SUPABASE_PROJECT_ID -u SUPABASE_URL -u SUPABASE_PUBLISHABLE_KEY -u SUPABASE_ANON_KEY \
    -u SUPABASE_SERVICE_ROLE_KEY -u SUPABASE_PROJECT_ID -u SUPABASE_DB_URL -u DATABASE_URL -u LOVABLE_API_KEY \
    NOVA_RUNTIME_MODE=local \
    bun --env-file=/dev/null run local/gateway/server.ts > "$NOVA_RUN_DIR/gateway.log" 2>&1 & echo $! > "$NOVA_RUN_DIR/gateway.pid" )
GW_URL="$(nova_gateway_url 127.0.0.1)"
wait_for "Gateway" curl -sfk -o /dev/null "$GW_URL/health"

# 5. Application readiness -----------------------------------------------------
if curl -sfk "$GW_URL/ready" >/dev/null 2>&1; then
  nova_log "Application UI ready"
else
  nova_log "WARNING: system is NOT ready — run 'novactl.sh ready' for the failing component"
fi

nova_log "Local runtime up. Terminals: $(nova_gateway_url '<this-machine>')"