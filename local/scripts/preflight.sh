#!/usr/bin/env bash
# PRODUCTIZATION-4 Phase B — host pre-flight.
#
# Collects host facts and hands them to the product's decision logic
# (src/modules/runtime/local/preflight.ts) so the installer and the tests
# judge a machine by exactly the same rules.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
[[ "$platform" == mingw* || "$platform" == msys* || "$platform" == cygwin* ]] && platform="windows"
arch="$(uname -m)"

if [[ "$platform" == "linux" ]]; then
  memory_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1024 ))
else
  memory_mb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1048576 ))
fi
disk_mb=$(df -Pm "$NOVA_LOCAL_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
: "${disk_mb:=0}"

# --- database facts ---------------------------------------------------------
# Standalone installs run PostgreSQL in the nova-fnb-postgres container, so the
# host is never required to carry a PostgreSQL server or client. Every probe
# below is read-only and must never abort the script (set -e / pipefail).
NOVA_DB_CONTAINER="${NOVA_DB_CONTAINER:-nova-fnb-postgres}"
db_mode="host"
if [[ "${NOVA_DB_MODE:-auto}" == "docker" ]]; then
  db_mode="docker"
elif [[ "${NOVA_DB_MODE:-auto}" == "auto" ]] && command -v docker >/dev/null 2>&1 &&
     docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$NOVA_DB_CONTAINER"; then
  db_mode="docker"
fi

pg_version=""
database_json="null"

if [[ "$db_mode" == "docker" ]]; then
  docker_available=false; container_running=false; db_ready=false; port_reachable=false
  container_pg_version=""
  command -v docker >/dev/null 2>&1 && docker_available=true
  if [[ "$docker_available" == true ]]; then
    [[ "$(docker inspect -f '{{.State.Running}}' "$NOVA_DB_CONTAINER" 2>/dev/null || echo false)" == "true" ]] &&
      container_running=true
    if [[ "$container_running" == true ]]; then
      container_pg_version="$(docker exec "$NOVA_DB_CONTAINER" postgres --version 2>/dev/null | awk '{print $3}' || true)"
      docker exec "$NOVA_DB_CONTAINER" pg_isready -U "${NOVA_DB_SUPERUSER}" >/dev/null 2>&1 && db_ready=true
    fi
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/${NOVA_DB_PORT}") 2>/dev/null && port_reachable=true
  database_json="{\"mode\":\"docker\",\"dockerAvailable\":$docker_available,\"containerName\":\"$NOVA_DB_CONTAINER\",\"containerRunning\":$container_running,\"serverVersion\":$( [[ -n "$container_pg_version" ]] && echo "\"$container_pg_version\"" || echo null ),\"ready\":$db_ready,\"hostPort\":${NOVA_DB_PORT},\"portReachable\":$port_reachable}"
else
  pg_version="$( { psql --version 2>/dev/null || true; } | awk '{print $3}')"
  [[ -z "$pg_version" ]] && pg_version="$( { postgres --version 2>/dev/null || true; } | awk '{print $3}')"
  database_json="{\"mode\":\"host\"}"
fi

# Ports: a port held by our own pidfile process is an upgrade, not a conflict.
ports_json="[]"
collect_ports() {
  local entries=()
  for port in 5432 "$NOVA_POSTGREST_PORT" "$NOVA_GATEWAY_PORT" "$NOVA_GATEWAY_TLS_PORT"; do
    local owner
    owner="$(ss -lntp 2>/dev/null | awk -v p=":$port$" '$4 ~ p {print $NF}' | head -1)"
    [[ -z "$owner" ]] && continue
    local ours=false
    for pidfile in "$NOVA_RUN_DIR"/*.pid; do
      [[ -f "$pidfile" ]] || continue
      grep -q "pid=$(cat "$pidfile")," <<<"$owner" && ours=true
    done
    entries+=("{\"port\":$port,\"process\":\"$(sed 's/"/\\"/g' <<<"$owner" | cut -c1-60)\",\"ownedByNova\":$ours}")
  done
  local IFS=,
  ports_json="[${entries[*]}]"
}
collect_ports

FACTS=$(cat <<JSON
{"platform":"$platform","architecture":"$arch","memoryMb":$memory_mb,"diskFreeMb":$disk_mb,
 "postgresVersion":$( [[ -n "$pg_version" ]] && echo "\"$pg_version\"" || echo null ),
 "database":$database_json,"portsInUse":$ports_json}
JSON
)

export NOVA_PREFLIGHT_FACTS="$FACTS"
bun --silent -e "
  const { evaluatePreflight } = await import('$NOVA_ROOT/src/modules/runtime/local/preflight.ts');
  const report = evaluatePreflight(JSON.parse(process.env.NOVA_PREFLIGHT_FACTS));
  for (const c of report.checks) {
    const mark = c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(\`  [\${mark}] \${c.label.padEnd(30)} \${c.detail}\`);
  }
  console.log(report.ok ? '[nova-local] pre-flight OK' : \`[nova-local] pre-flight FAILED (\${report.blocking} blocking)\`);
  process.exit(report.ok ? 0 : 1);
"
