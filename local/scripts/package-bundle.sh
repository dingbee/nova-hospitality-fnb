#!/usr/bin/env bash
# NOVA Hospitality — appliance bundle packaging (PRODUCTIZATION-4D/4G).
#
# The application build may emit its output in one of two layouts depending on
# the Vite/Nitro version in use:
#
#   .output/public + .output/server/index.mjs   (Nitro default)
#   .output/client + .output/server/index.mjs   (newer TanStack Start)
#   dist/client    + dist/server/index.mjs      (already the appliance contract)
#
# The appliance runtime contract (gateway, verify-bundle.sh, tests) is ALWAYS
# dist/client + dist/server/index.mjs, so this script normalises whichever
# layout the build produced into that contract. Deterministic, real file
# copies, never symlinks.
#
# Usage: bash package-bundle.sh <root>
set -euo pipefail

ROOT="${1:?usage: package-bundle.sh <root>}"
log() { printf '[nova-local] %s\n' "$*"; }

log "Checking build output under $ROOT"
CLIENT_SRC=""
for cand in "$ROOT/.output/public" "$ROOT/.output/client" "$ROOT/dist/client"; do
  if [[ -d "$cand" ]]; then CLIENT_SRC="$cand"; break; fi
done
SERVER_SRC=""
for cand in "$ROOT/.output/server" "$ROOT/dist/server"; do
  if [[ -f "$cand/index.mjs" ]]; then SERVER_SRC="$cand"; break; fi
done

if [[ -z "$CLIENT_SRC" || -z "$SERVER_SRC" ]]; then
  echo "FATAL: application build completed but expected Nitro output was not found" >&2
  echo "       client candidates: $ROOT/.output/public, $ROOT/.output/client, $ROOT/dist/client" >&2
  echo "       server candidates: $ROOT/.output/server/index.mjs, $ROOT/dist/server/index.mjs" >&2
  ls -la "$ROOT/.output" 2>/dev/null >&2 || echo "       (no $ROOT/.output directory)" >&2
  ls -la "$ROOT/dist" 2>/dev/null >&2 || echo "       (no $ROOT/dist directory)" >&2
  exit 1
fi
log "Client output: $CLIENT_SRC"
log "Server output: $SERVER_SRC/index.mjs"

# PWA artefacts (sw.js, workbox-*.js) may be emitted directly into dist/ by the
# client build. They are kept as-is; only the two appliance directories are
# recreated, so they can never interfere with the Nitro contract.
mkdir -p "$ROOT/dist"
STAGE="$ROOT/dist/.nova-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/client" "$STAGE/server"
cp -a "$CLIENT_SRC/." "$STAGE/client/"
cp -a "$SERVER_SRC/." "$STAGE/server/"

# Never ship environment files or key material inside the served bundle.
find "$STAGE" \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \) -type f -delete 2>/dev/null || true

rm -rf "$ROOT/dist/client" "$ROOT/dist/server"
mv "$STAGE/client" "$ROOT/dist/client"
mv "$STAGE/server" "$ROOT/dist/server"
rmdir "$STAGE" 2>/dev/null || rm -rf "$STAGE"

[[ -d "$ROOT/dist/client" ]] || { echo "FATAL: dist/client missing after packaging" >&2; exit 1; }
[[ -f "$ROOT/dist/server/index.mjs" ]] || { echo "FATAL: dist/server/index.mjs missing after packaging" >&2; exit 1; }
log "Packaged appliance bundle: $ROOT/dist/client + $ROOT/dist/server/index.mjs"
