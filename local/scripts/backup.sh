#!/usr/bin/env bash
# PRODUCTIZATION-3 Phase 10 — local backup.
#
# A backup is a single verifiable artifact: a compressed custom-format pg_dump
# of the operational database plus a manifest carrying the versions, checksum
# and size needed to decide whether a restore is safe. Nothing is transmitted
# anywhere; the appliance owner keeps custody of their data.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

OUT_DIR="${1:-$NOVA_BACKUP_DIR}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$OUT_DIR/nova-$PGDATABASE-$STAMP"
DUMP="$BASE.dump"
MANIFEST="$BASE.manifest.json"

read_meta() { psql -X -tAc "SELECT value FROM nova_local.runtime_meta WHERE key = '$1'" 2>/dev/null | tr -d '[:space:]'; }
APP_VERSION="$(read_meta app_version)"
SCHEMA_VERSION="$(read_meta schema_version)"
INSTALL_ID="$(read_meta install_id)"
MIGRATIONS="$(psql -X -tAc "SELECT count(*) FROM nova_local.schema_migrations WHERE status = 'applied'" | tr -d '[:space:]')"
TENANTS="$(psql -X -tAc "SELECT coalesce(json_agg(json_build_object('id', id, 'slug', slug))::text, '[]') FROM public.restaurant_tenants")"

nova_log "backup: $DUMP"
# Custom format: compressed, selectively restorable, and restore-order aware.
# Privileges ARE included: PostgREST resolves the anon/authenticated/service_role
# grants at runtime, and a restore without them leaves a silently unreadable
# database. Ownership is not, because the restoring superuser may differ.
pg_dump --format=custom --compress=9 \
        --file="$DUMP" "$PGDATABASE"

CHECKSUM="$(sha256sum "$DUMP" | cut -d' ' -f1)"
SIZE="$(stat -c%s "$DUMP")"

cat > "$MANIFEST" <<JSON
{
  "product": "NOVA Hospitality — Restaurant & Bar OS",
  "artifact": "$(basename "$DUMP")",
  "format": "pg_dump/custom",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "app_version": "$APP_VERSION",
  "schema_version": "$SCHEMA_VERSION",
  "install_id": "$INSTALL_ID",
  "database": "$PGDATABASE",
  "postgres_version": "$(psql -X -tAc 'SHOW server_version' | tr -d '[:space:]')",
  "migrations_applied": $MIGRATIONS,
  "tenants": $TENANTS,
  "size_bytes": $SIZE,
  "checksum_sha256": "$CHECKSUM",
  "includes_auth_material": true,
  "transmitted_offsite": false
}
JSON

# Prove the artifact is readable before declaring success.
pg_restore --list "$DUMP" > /dev/null || { echo "FATAL: backup artifact is not readable" >&2; exit 1; }
nova_log "backup ok: $SIZE bytes, sha256 $CHECKSUM"
echo "$DUMP"
