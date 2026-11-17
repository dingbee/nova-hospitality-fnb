#!/usr/bin/env bash
# PRODUCTIZATION-3 Phase 11 — local restore.
#
#   restore.sh <dump-file> [target-database] [--yes]
#
# Restore verifies the manifest checksum first: an artifact that does not match
# its manifest is never applied. The target database is created fresh, so a
# restore never merges into live data by accident.
#
# Restore is destructive for the target database, so the target is validated
# (never inferred from a stray flag) and overwriting the live database must be
# confirmed, either interactively or with --yes.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

DUMP=""; TARGET=""; ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --target) shift; TARGET="${1:?--target needs a database name}" ;;
    -*) echo "FATAL: unknown option '$1'. usage: restore.sh <dump-file> [target-database] [--yes]" >&2; exit 2 ;;
    *)
      if [[ -z "$DUMP" ]]; then DUMP="$1"
      elif [[ -z "$TARGET" ]]; then TARGET="$1"
      else echo "FATAL: unexpected argument '$1'" >&2; exit 2; fi ;;
  esac
  shift
done
[[ -n "$DUMP" ]] || { echo "usage: restore.sh <dump-file> [target-database] [--yes]" >&2; exit 2; }
TARGET="${TARGET:-$PGDATABASE}"
[[ "$TARGET" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "FATAL: invalid target database name '$TARGET'." >&2; exit 2; }
MANIFEST="${DUMP%.dump}.manifest.json"

[[ -f "$DUMP" ]] || { echo "FATAL: $DUMP not found" >&2; exit 1; }

if [[ -f "$MANIFEST" ]]; then
  EXPECTED="$(grep -o '"checksum_sha256": *"[^"]*"' "$MANIFEST" | sed 's/.*"\([a-f0-9]\{64\}\)"/\1/')"
  ACTUAL="$(sha256sum "$DUMP" | cut -d' ' -f1)"
  if [[ -n "$EXPECTED" && "$EXPECTED" != "$ACTUAL" ]]; then
    echo "FATAL: backup checksum mismatch — refusing to restore a corrupted artifact." >&2
    exit 1
  fi
  nova_log "manifest verified (sha256 $ACTUAL)"
else
  nova_log "WARNING: no manifest beside $DUMP; restoring without checksum verification"
fi

nova_log "restore -> database $TARGET"
if [[ "$ASSUME_YES" -ne 1 ]]; then
  if [[ -t 0 ]]; then
    read -r -p "This REPLACES database \"$TARGET\" and everything in it. Type the database name to continue: " confirm
    [[ "$confirm" == "$TARGET" ]] || { echo "Restore cancelled; nothing was changed." >&2; exit 1; }
  else
    echo "FATAL: refusing to replace database \"$TARGET\" without confirmation. Re-run with --yes." >&2
    exit 1
  fi
fi
psql -X -q -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$TARGET'" | grep -q 1 \
  && {
    # Terminals and the data service hold sessions open; without closing them
    # the drop fails and the operator is left with no restore at all.
    psql -X -q -d postgres -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$TARGET' AND pid <> pg_backend_pid()" >/dev/null
    psql -X -q -d postgres -c "DROP DATABASE \"$TARGET\""
  }
psql -X -q -d postgres -c "CREATE DATABASE \"$TARGET\""

# Roles live in the cluster, not the dump; recreate the compatibility roles so
# ownership and grants resolve on a machine that has never run this product.
for f in "$NOVA_LOCAL_DIR"/sql/pre/00-roles.sql; do
  PGDATABASE="$TARGET" nova_psql -d "$TARGET" -f "$f" >/dev/null
done

pg_restore --dbname="$TARGET" --no-owner --exit-on-error "$DUMP"

COUNT="$(psql -X -d "$TARGET" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" | tr -d '[:space:]')"
nova_log "restore complete: $COUNT public tables in $TARGET"

# The data service caches the schema and holds pooled connections to a database
# that no longer exists; ask it to reconnect and reload so terminals can trade
# again without a full appliance restart.
if [[ -f "$NOVA_RUN_DIR/postgrest.pid" ]] && kill -0 "$(cat "$NOVA_RUN_DIR/postgrest.pid")" 2>/dev/null; then
  kill -USR1 "$(cat "$NOVA_RUN_DIR/postgrest.pid")" 2>/dev/null || true
  nova_log "data service asked to reconnect and reload its schema"
else
  nova_log "data service is not running — start the appliance with: novactl.sh start"
fi
