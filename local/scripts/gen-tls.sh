#!/usr/bin/env bash
# PRODUCTIZATION-4C Phase C — per-installation TLS material for the LAN origin.
#
#   nova-local-ca.crt   distribute to terminals (public, world-readable)
#   nova-local-ca.key   0600, never leaves the appliance
#   gateway.crt/.key    served by the gateway; key 0600
#
# There is NO cloud certificate dependency: the appliance is its own authority
# and every install has its own CA. Certificate validation is never disabled.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

TLS_DIR="${NOVA_TLS_DIR:-${NOVA_KEY_DIR:-$NOVA_LOCAL_DIR/keys}/tls}"
mkdir -p "$TLS_DIR"; chmod 700 "$TLS_DIR"

CA_CRT="$TLS_DIR/nova-local-ca.crt"; CA_KEY="$TLS_DIR/nova-local-ca.key"
SRV_CRT="$TLS_DIR/gateway.crt";      SRV_KEY="$TLS_DIR/gateway.key"

if [[ -f "$SRV_CRT" && "${1:-}" != "--force" ]]; then
  nova_log "TLS certificate already present (use --force to re-issue)."
  openssl x509 -in "$SRV_CRT" -noout -enddate
  exit 0
fi

# Overridable so an appliance behind a NAT/port-proxy (e.g. WSL2 on Windows)
# can put the address terminals actually dial into the certificate.
HOSTNAMES="${NOVA_TLS_HOSTNAMES:-$(hostname 2>/dev/null || echo nova)}"
IPS="${NOVA_TLS_IPS:-$(hostname -I 2>/dev/null || true)}"
export NOVA_TLS_HOSTNAMES="$HOSTNAMES" NOVA_TLS_IPS="$IPS"
SAN=$(bun --silent -e "
  const { buildSanList } = await import('$NOVA_ROOT/src/modules/runtime/local/tls.ts');
  const split = (s) => (s || '').split(/\s+/).filter(Boolean);
  console.log(buildSanList({
    hostnames: [...split(process.env.NOVA_TLS_HOSTNAMES), 'nova'],
    ipAddresses: split(process.env.NOVA_TLS_IPS),
  }).join(','));
")
nova_log "Issuing appliance certificate for: $SAN"

if [[ ! -f "$CA_KEY" ]]; then
  openssl req -x509 -newkey rsa:4096 -sha256 -days "${NOVA_TLS_CA_DAYS:-3650}" -nodes \
    -keyout "$CA_KEY" -out "$CA_CRT" \
    -subj "/O=NOVA Hospitality/CN=NOVA Hospitality Local CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
  nova_log "Generated installation certificate authority."
fi

openssl req -newkey rsa:2048 -sha256 -nodes -keyout "$SRV_KEY" -out "$TLS_DIR/gateway.csr" \
  -subj "/O=NOVA Hospitality/CN=NOVA Hospitality Appliance" >/dev/null 2>&1
openssl x509 -req -in "$TLS_DIR/gateway.csr" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
  -days "${NOVA_TLS_DAYS:-397}" -sha256 -out "$SRV_CRT" \
  -extfile <(printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$SAN") >/dev/null 2>&1
rm -f "$TLS_DIR/gateway.csr"

chmod 600 "$CA_KEY" "$SRV_KEY"
chmod 644 "$CA_CRT" "$SRV_CRT"
openssl x509 -in "$SRV_CRT" -noout -enddate
nova_log "TLS material in $TLS_DIR — install $CA_CRT on each terminal to trust the appliance."
