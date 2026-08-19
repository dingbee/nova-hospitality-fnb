#!/usr/bin/env bash
# PRODUCTIZATION-3 Phase 3 — generate the local signing key.
#
# ES256 keypair: the gateway signs with the PRIVATE key, PostgREST verifies
# with the PUBLIC JWK only. PostgREST therefore cannot mint tokens even if the
# process is compromised. Keys are per-installation and never leave the box.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

KEY_DIR="${NOVA_KEY_DIR:-$NOVA_LOCAL_DIR/keys}"
KID="${NOVA_JWT_KID:-nova-local-1}"
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

if [[ -f "$KEY_DIR/jwt-private.pem" && "${1:-}" != "--force" ]]; then
  nova_log "Signing key already present (use --force to rotate)."
else
  openssl ecparam -name prime256v1 -genkey -noout \
    | openssl pkcs8 -topk8 -nocrypt -out "$KEY_DIR/jwt-private.pem"
  chmod 600 "$KEY_DIR/jwt-private.pem"
  nova_log "Generated ES256 signing key."
fi

bun --silent -e "
  const { publicJwkFromPrivate } = await import('$NOVA_ROOT/src/modules/runtime/local/jwt.server.ts');
  const pem = await Bun.file('$KEY_DIR/jwt-private.pem').text();
  const jwk = publicJwkFromPrivate(pem, '$KID');
  await Bun.write('$KEY_DIR/jwks.json', JSON.stringify({ keys: [jwk] }, null, 2));
" 
chmod 644 "$KEY_DIR/jwks.json"
nova_log "Public JWKS written to $KEY_DIR/jwks.json (kid=$KID)."