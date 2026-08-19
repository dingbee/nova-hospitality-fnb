#!/usr/bin/env bash
# PRODUCTIZATION-4 Phase P — uninstall.
#
# Default behaviour stops services and removes runtime artefacts ONLY.
# Customer data is never destroyed without an explicit, typed confirmation.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

PURGE=false
[[ "${1:-}" == "--purge-data" ]] && PURGE=true

bash "$NOVA_LOCAL_DIR/scripts/stop.sh" || true
rm -f "$NOVA_RUN_DIR"/*.pid "$NOVA_RUN_DIR/postgrest.conf"
nova_log "Services stopped and runtime files removed."

if ! $PURGE; then
  cat <<INFO
[nova-local] Customer data was NOT touched.
             Database : $PGDATABASE (intact)
             Backups  : $NOVA_BACKUP_DIR (intact)
             Keys     : ${NOVA_KEY_DIR:-$NOVA_LOCAL_DIR/keys} (intact)
             To permanently destroy the database, re-run with --purge-data.
INFO
  exit 0
fi

cat >&2 <<WARNING

  ****  DESTRUCTIVE OPERATION  ****
  This permanently deletes database "$PGDATABASE": every order, bill,
  payment, receipt, stock movement and audit record for this property.
  Backups in $NOVA_BACKUP_DIR are NOT deleted and remain your only recovery.

WARNING
read -r -p "Type the database name to confirm destruction: " typed
if [[ "$typed" != "$PGDATABASE" ]]; then
  echo "Confirmation did not match — nothing was deleted." >&2
  exit 1
fi
psql -X -q -d postgres -c "DROP DATABASE IF EXISTS \"$PGDATABASE\""
rm -f "$NOVA_LOCAL_DIR/install.json"
nova_log "Database destroyed. Backups retained in $NOVA_BACKUP_DIR."
