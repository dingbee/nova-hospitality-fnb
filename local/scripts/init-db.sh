#!/usr/bin/env bash
# PRODUCTIZATION-3 Phase 2 — initialise a clean PostgreSQL 16/17 database.
#
#   CLEAN POSTGRESQL -> APPLY EXISTING MIGRATIONS -> DATABASE READY
#
# The product migrations under supabase/migrations remain the single
# authoritative schema definition. Nothing is duplicated here.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env
nova_require NOVA_DB_AUTHENTICATOR_PASSWORD

SCHEMA_VERSION="${NOVA_SCHEMA_VERSION:-2026.08.17}"
APP_VERSION="${NOVA_APP_VERSION:-1.2.0}"

nova_log "Target database: $PGDATABASE @ $PGHOST:$PGPORT"

# 1. Database + authenticator role -------------------------------------------
psql -X -q -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$PGDATABASE'" \
  | grep -q 1 || psql -X -q -d postgres -c "CREATE DATABASE \"$PGDATABASE\""

# 2. Platform compatibility layer (roles, extensions, auth shim, stubs) ------
for f in "$NOVA_LOCAL_DIR"/sql/pre/*.sql; do
  nova_log "pre: $(basename "$f")"
  nova_psql -f "$f"
done

nova_psql -c "DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$NOVA_DB_AUTHENTICATOR') THEN
    CREATE ROLE $NOVA_DB_AUTHENTICATOR LOGIN NOINHERIT PASSWORD '$NOVA_DB_AUTHENTICATOR_PASSWORD';
  ELSE
    ALTER ROLE $NOVA_DB_AUTHENTICATOR PASSWORD '$NOVA_DB_AUTHENTICATOR_PASSWORD';
  END IF;
END
\$\$;"
nova_psql -c "GRANT anon, authenticated, service_role TO $NOVA_DB_AUTHENTICATOR;"

# 3. Product migrations (authoritative, applied in filename order) -----------
"$NOVA_LOCAL_DIR/scripts/apply-migrations.sh"

# 4. Local runtime schema (identity, sessions, bootstrap, health) ------------
for f in "$NOVA_LOCAL_DIR"/sql/post/*.sql; do
  nova_log "post: $(basename "$f")"
  nova_psql -f "$f"
done

# 5. Version + install identity ----------------------------------------------
nova_psql -c "INSERT INTO nova_local.runtime_meta(key, value) VALUES
  ('schema_version', '$SCHEMA_VERSION'),
  ('app_version', '$APP_VERSION'),
  ('install_id', gen_random_uuid()::text),
  ('installed_at', now()::text)
 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();"

nova_log "Database ready (schema $SCHEMA_VERSION, app $APP_VERSION)."