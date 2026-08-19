#!/usr/bin/env bash
# Loads synthetic demo data. Never runs unless NOVA_DEMO_SEED=true, and the
# seed files themselves contain no real operational data of any kind.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

if [[ "${NOVA_DEMO_SEED:-false}" != "true" ]]; then
  nova_log "demo seed disabled (NOVA_DEMO_SEED != true)"
  exit 0
fi

SEED_DIR="${NOVA_SEED_DIR:-$NOVA_ROOT/standalone/db/seed/demo}"
if [[ ! -d "$SEED_DIR" ]]; then
  nova_log "no seed directory at $SEED_DIR — nothing to load"
  exit 0
fi

shopt -s nullglob
for f in "$SEED_DIR"/*.sql; do
  nova_log "seed: $(basename "$f")"
  nova_psql --single-transaction -f "$f"
done
nova_log "demo seed complete"
