#!/usr/bin/env bash
# Stop the local runtime in reverse dependency order: gateway -> PostgREST.
# PostgreSQL is left running; it is managed by the host service manager.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

for component in gateway postgrest; do
  pidfile="$NOVA_RUN_DIR/$component.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    nova_log "stopped $component"
  fi
  rm -f "$pidfile"
done