#!/usr/bin/env bash
# PRODUCTIZATION-4 Phase B — NOVA Hospitality local installer.
#
#   pre-flight -> installation-state decision -> secrets -> database ->
#   migrations -> permissions -> ordered start -> readiness -> first-run URL
#
# It NEVER drops, recreates or overwrites an existing customer database.
# An existing installation stops the installer and asks for --upgrade/--repair.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

MODE="install"
case "${1:-}" in
  --upgrade) MODE="upgrade" ;;
  --repair)  MODE="repair" ;;
  --dry-run) MODE="dry-run" ;;
  "")        ;;
  *) echo "usage: install.sh [--upgrade|--repair|--dry-run]" >&2; exit 2 ;;
esac

ENV_FILE="${NOVA_ENV_FILE:-$NOVA_LOCAL_DIR/.env}"
MARKER="$NOVA_LOCAL_DIR/install.json"

nova_log "NOVA Hospitality installer ($MODE)"

# 1. Pre-flight ---------------------------------------------------------------
bash "$NOVA_LOCAL_DIR/scripts/preflight.sh"

# 2. Existing-installation detection ------------------------------------------
db_present=false; migrations=0; install_id=null; installed_version=null; foreign=false
if psql -X -q -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$PGDATABASE'" 2>/dev/null | grep -q 1; then
  db_present=true
  migrations=$(psql -X -q -tAc "SELECT count(*) FROM nova_local.schema_migrations" 2>/dev/null || echo 0)
  id=$(psql -X -q -tAc "SELECT value FROM nova_local.runtime_meta WHERE key='install_id'" 2>/dev/null || true)
  ver=$(psql -X -q -tAc "SELECT value FROM nova_local.runtime_meta WHERE key='app_version'" 2>/dev/null || true)
  [[ -n "$id" ]] && install_id="\"$id\"" || foreign=$([[ "$migrations" -gt 0 ]] && echo true || echo false)
  [[ -n "$ver" ]] && installed_version="\"$ver\""
fi
marker_present=$([[ -f "$MARKER" ]] && echo true || echo false)

export NOVA_INSTALL_FACTS="{\"installMarkerPresent\":$marker_present,\"databasePresent\":$db_present,\"migrationsApplied\":$migrations,\"installId\":$install_id,\"installedVersion\":$installed_version,\"unknownDatabaseOwner\":$foreign}"
DECISION=$(bun --silent -e "
  const { classifyInstall } = await import('$NOVA_ROOT/src/modules/runtime/local/install-state.ts');
  const d = classifyInstall(JSON.parse(process.env.NOVA_INSTALL_FACTS));
  console.log(JSON.stringify(d));
")
ACTION=$(sed -n 's/.*"action":"\([a-z]*\)".*/\1/p' <<<"$DECISION")
MESSAGE=$(sed -n 's/.*"message":"\([^"]*\)".*/\1/p' <<<"$DECISION")
nova_log "$MESSAGE"

case "$ACTION" in
  abort) echo "FATAL: installation stopped to protect existing data." >&2; exit 1 ;;
  upgrade|repair)
    if [[ "$MODE" == "install" ]]; then
      echo "FATAL: an installation already exists. Re-run with --upgrade or --repair." >&2
      exit 1
    fi ;;
esac
[[ "$MODE" == "dry-run" ]] && { nova_log "Dry run complete — nothing changed."; exit 0; }

# 3. Secrets ------------------------------------------------------------------
# Generated per installation, never shipped with the product.
if [[ ! -f "$ENV_FILE" ]]; then
  nova_log "Generating local configuration and secrets"
  install -m 600 /dev/null "$ENV_FILE"
  {
    echo "# NOVA Hospitality local installation — generated $(date -u +%FT%TZ). Do not commit."
    echo "NOVA_DB_NAME=$NOVA_DB_NAME"
    echo "NOVA_DB_SUPERUSER=$NOVA_DB_SUPERUSER"
    echo "NOVA_DB_AUTHENTICATOR=$NOVA_DB_AUTHENTICATOR"
    echo "NOVA_DB_AUTHENTICATOR_PASSWORD=$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-40)"
    echo "NOVA_GATEWAY_PORT=$NOVA_GATEWAY_PORT"
    echo "NOVA_POSTGREST_PORT=$NOVA_POSTGREST_PORT"
  } >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  nova_load_env
fi
bash "$NOVA_LOCAL_DIR/scripts/gen-keys.sh"

# 4. Database + migrations (idempotent, checksum-verified) --------------------
bash "$NOVA_LOCAL_DIR/scripts/init-db.sh"

# 4b. Synthetic demo data (opt-in, no-op unless NOVA_DEMO_SEED=true) -----------
bash "$NOVA_LOCAL_DIR/scripts/seed-demo.sh"

# 5. Permissions ---------------------------------------------------------------
chmod 700 "${NOVA_KEY_DIR:-$NOVA_LOCAL_DIR/keys}" 2>/dev/null || true
chmod 600 "${NOVA_KEY_DIR:-$NOVA_LOCAL_DIR/keys}/jwt-private.pem" 2>/dev/null || true
chmod 600 "$ENV_FILE"
mkdir -p "$NOVA_BACKUP_DIR" && chmod 700 "$NOVA_BACKUP_DIR"

# 5b. Application UI bundle ----------------------------------------------------
# Shipped with the release; built from the same source as the hosted runtime.
BUNDLE_DIR="${NOVA_APP_BUNDLE_DIR:-$NOVA_ROOT/dist}"
# A bundle left behind by hosted development is NOT usable here (4F): it would
# point the appliance at a hosted backend. Only a marked local build counts.
if [[ ! -d "$BUNDLE_DIR/client" || ! -f "$BUNDLE_DIR/server/index.mjs" || ! -f "$BUNDLE_DIR/.nova-local-build" ]]; then
  if [[ "${NOVA_BUILD_UI:-auto}" != "off" ]]; then
    nova_log "No appliance UI bundle found — building it"
    bash "$NOVA_LOCAL_DIR/scripts/build-ui.sh"
  fi
fi
if [[ ! -d "$BUNDLE_DIR/client" || ! -f "$BUNDLE_DIR/server/index.mjs" ]]; then
  echo "FATAL: application UI bundle missing at $BUNDLE_DIR — installation cannot report READY." >&2
  exit 1
fi
bash "$NOVA_LOCAL_DIR/scripts/verify-bundle.sh" "$BUNDLE_DIR"
export NOVA_APP_BUNDLE_DIR="$BUNDLE_DIR"

# 6. Ordered start + readiness -------------------------------------------------
bash "$NOVA_LOCAL_DIR/scripts/start.sh"
bash "$NOVA_LOCAL_DIR/scripts/novactl.sh" ready

# 7. Marker + result -----------------------------------------------------------
INSTALL_ID=$(psql -X -q -tAc "SELECT value FROM nova_local.runtime_meta WHERE key='install_id'" 2>/dev/null || echo unknown)
printf '{"install_id":"%s","app_version":"%s","installed_at":"%s","mode":"%s"}\n' \
  "$INSTALL_ID" "${NOVA_APP_VERSION:-1.2.0}" "$(date -u +%FT%TZ)" "$MODE" > "$MARKER"
chmod 640 "$MARKER"

HOSTIP=$(hostname -I 2>/dev/null | awk '{print $1}')
: "${HOSTIP:=<this-machine>}"
cat <<BANNER

  NOVA Hospitality — Restaurant & Bar OS
  Installation: $ACTION complete
  Install id:   $INSTALL_ID

  First-run setup:  $(nova_gateway_url "$HOSTIP")/
  Terminals (LAN):  $(nova_gateway_url "$HOSTIP")/
  Terminal trust:   install ${NOVA_TLS_DIR}/nova-local-ca.crt on each tablet

BANNER
