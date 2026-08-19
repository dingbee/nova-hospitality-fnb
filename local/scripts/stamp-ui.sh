#!/usr/bin/env bash
# PRODUCTIZATION-4D — bind the UI bundle to THIS appliance's origin.
#
# The bundle ships with a sentinel origin. At install (and whenever the origin
# changes) it is rewritten in place to the LAN origin the terminals use, so the
# UI talks to its own gateway same-origin, offline, with no hosted dependency.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

SENTINEL="${NOVA_ORIGIN_SENTINEL:-https://nova-appliance.invalid}"
BUNDLE="${NOVA_APP_BUNDLE_DIR:-$NOVA_ROOT/dist}"
HOSTNAME_LAN="${NOVA_TERMINAL_HOST:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
: "${HOSTNAME_LAN:=127.0.0.1}"
ORIGIN="${NOVA_APP_ORIGIN:-$(nova_gateway_url "$HOSTNAME_LAN")}"

[[ -d "$BUNDLE/client" ]] || { echo "FATAL: UI bundle not found at $BUNDLE/client — run build-ui.sh" >&2; exit 1; }

count=0
while IFS= read -r -d '' file; do
  if grep -q "$SENTINEL" "$file" 2>/dev/null; then
    # Same-length-agnostic literal replacement; no regex metacharacters in URLs.
    python3 - "$file" "$SENTINEL" "$ORIGIN" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
data = open(path, "r", encoding="utf-8", errors="surrogateescape").read()
open(path, "w", encoding="utf-8", errors="surrogateescape").write(data.replace(old, new))
PY
    count=$((count + 1))
  fi
done < <(find "$BUNDLE" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.html' -o -name '*.json' -o -name '*.webmanifest' \) -print0)

printf '%s\n' "$ORIGIN" > "$BUNDLE/.nova-origin"
nova_log "UI bundle bound to $ORIGIN ($count file(s) updated)"
