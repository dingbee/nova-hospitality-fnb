#!/usr/bin/env bash
# PRODUCTIZATION-3 Phase 2 — apply the authoritative product migrations.
#
# Migrations are applied in filename (timestamp) order and recorded with a
# checksum in nova_local.schema_migrations. Re-running is a no-op; a changed
# checksum on an already-applied migration is a hard failure, because silently
# diverging schema is how installations become unrestorable.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

# Default: the host product's authoritative migrations. A standalone
# installation points this at the extracted Restaurant & Bar OS schema.
# The standalone product owns its migrations under standalone/db/migrations.
# supabase/migrations is only present when this tree is embedded in a hosted
# project, so it is a fallback, never a requirement.
if [[ -n "${NOVA_MIGRATIONS_DIR:-}" ]]; then
  MIGRATIONS_DIR="$NOVA_MIGRATIONS_DIR"
elif [[ -d "$NOVA_ROOT/standalone/db/migrations" ]]; then
  MIGRATIONS_DIR="$NOVA_ROOT/standalone/db/migrations"
else
  MIGRATIONS_DIR="$NOVA_ROOT/supabase/migrations"
fi
nova_log "migrations source: $MIGRATIONS_DIR"

# The ledger must exist before the product migrations so re-runs are safe;
# the full nova_local schema is created afterwards by sql/post.
nova_psql -c "CREATE SCHEMA IF NOT EXISTS nova_local;
CREATE TABLE IF NOT EXISTS nova_local.schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);"
nova_psql -c "ALTER TABLE nova_local.schema_migrations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'applied',
  ADD COLUMN IF NOT EXISTS note text;"

SKIP_FILE="$NOVA_LOCAL_DIR/migrations.skip"

nova_skip_reason() {
  [[ -f "$SKIP_FILE" ]] || return 1
  grep -E "^[[:space:]]*$1([[:space:]]|#|$)" "$SKIP_FILE" | head -1 | sed -E 's/^[^#]*#[[:space:]]*//'
}

# Platform-only extensions that do not exist outside Supabase. The local
# runtime provides inert stubs for their APIs (see sql/pre/03-supabase-compat.sql);
# these CREATE EXTENSION statements are neutralised at apply time. The
# migration files themselves are never modified.
UNSUPPORTED_EXTENSIONS='pg_net|pgmq|supabase_vault|pg_cron'

nova_transform() {
  sed -E "s/^([[:space:]]*)CREATE EXTENSION([^;]*)(${UNSUPPORTED_EXTENSIONS})([^;]*);/\1-- [nova-local] CREATE EXTENSION \3 replaced by local compatibility stub/I" "$1"
}

applied=0
skipped=0
not_applicable=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$file")"
  checksum="$(sha256sum "$file" | cut -d' ' -f1)"
  recorded="$(psql -X -tAc "SELECT checksum FROM nova_local.schema_migrations WHERE filename = '$name'")"

  if [[ -n "$recorded" ]]; then
    if [[ "$recorded" != "$checksum" ]]; then
      echo "FATAL: migration $name changed after it was applied (checksum mismatch)." >&2
      exit 1
    fi
    skipped=$((skipped + 1))
    continue
  fi

  if reason="$(nova_skip_reason "$name")" && [[ -n "$reason" ]]; then
    nova_log "skip (not applicable): $name — $reason"
    nova_psql -c "INSERT INTO nova_local.schema_migrations(filename, checksum, status, note)
      VALUES ('$name', '$checksum', 'skipped', '$(printf '%s' "$reason" | sed "s/'/''/g")');"
    not_applicable=$((not_applicable + 1))
    continue
  fi

  nova_log "migrate: $name"
  # Each migration applies atomically together with its ledger row, so a
  # failure never leaves a half-applied schema behind.
  { nova_transform "$file"
    printf "\nINSERT INTO nova_local.schema_migrations(filename, checksum) VALUES ('%s', '%s');\n" "$name" "$checksum"
  } | nova_psql --single-transaction -f -
  applied=$((applied + 1))
done

nova_log "Migrations applied=$applied already-present=$skipped not-applicable=$not_applicable"