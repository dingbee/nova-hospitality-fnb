#!/usr/bin/env bash
# PRODUCTIZATION-4F — appliance bundle provenance gate.
#
# A bundle produced for the hosted deployment must never be served by an
# appliance: it carries the hosted backend origin and would send an offline
# venue's traffic to someone else's project. This check runs before the
# gateway is allowed to serve any bundle.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

BUNDLE="${1:-${NOVA_APP_BUNDLE_DIR:-$NOVA_ROOT/dist}}"
fail() { echo "FATAL: $*" >&2; exit 1; }

[[ -d "$BUNDLE/client" && -f "$BUNDLE/server/index.mjs" ]] || fail "no application bundle at $BUNDLE"
[[ -f "$BUNDLE/.nova-local-build" ]] || fail "bundle at $BUNDLE was not built for the appliance (missing .nova-local-build) — run: bash local/scripts/build-ui.sh"

# Any hosted backend origin baked into the shipped assets is disqualifying.
# Vendored SDKs ship documentation placeholders (xyzcompany/project-id/example)
# in their JSDoc; those are not real origins and are excluded explicitly.
# A real hosted origin is a 20-character project ref (https://<ref>.supabase.co).
HITS="$(grep -rhoE 'https://[a-z0-9]{20}\.supabase\.(co|in)' "$BUNDLE/client" "$BUNDLE/server" 2>/dev/null \
  | sort -u || true)"
if [[ -n "$HITS" ]]; then
  echo "$HITS" | head -5 >&2
  grep -rlE "$(echo "$HITS" | head -1)" "$BUNDLE/client" "$BUNDLE/server" 2>/dev/null | head -5 >&2
  fail "hosted backend origin found in the bundle — rebuild with build-ui.sh"
fi

nova_log "Bundle provenance OK: local build, no hosted backend origin ($BUNDLE)"
