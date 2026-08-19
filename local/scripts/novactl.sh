#!/usr/bin/env bash
# PRODUCTIZATION-4 Phase E — service lifecycle control.
#
#   start | stop | restart | status | health | ready | version
#   tls | backup | restore | diagnostics
#
# "status" answers "are the processes running"; "ready" answers "can the
# business trade" — the two are deliberately different questions.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

gw="$(nova_gateway_url 127.0.0.1)"
CURL=(curl -sk)   # loopback to our own appliance certificate

pid_alive() { [[ -f "$NOVA_RUN_DIR/$1.pid" ]] && kill -0 "$(cat "$NOVA_RUN_DIR/$1.pid")" 2>/dev/null; }

cmd_status() {
  pg_isready -h "$NOVA_DB_HOST" -p "$NOVA_DB_PORT" >/dev/null 2>&1 \
    && echo "  database    RUNNING" || echo "  database    STOPPED"
  pid_alive postgrest && echo "  data-service RUNNING" || echo "  data-service STOPPED"
  pid_alive gateway   && echo "  gateway      RUNNING" || echo "  gateway      STOPPED"
  # "Running" is not "serving": the UI layer is reported from health, because a
  # gateway with a missing bundle is a terminal that cannot trade.
  local ui
  ui=$("${CURL[@]}" "$gw/health" 2>/dev/null | grep -o '"id":"application-ui","status":"[a-z]*"' | sed 's/.*"status":"\([a-z]*\)".*/\1/')
  case "${ui:-}" in
    ok)   echo "  application  READY" ;;
    down) echo "  application  UNAVAILABLE (UI bundle missing or failed)" ;;
    *)    echo "  application  UNKNOWN" ;;
  esac
}

cmd_ready() {
  local code
  code=$("${CURL[@]}" -o "$NOVA_RUN_DIR/ready.json" -w '%{http_code}' "$gw/ready" || echo 000)
  cat "$NOVA_RUN_DIR/ready.json" 2>/dev/null; echo
  if [[ "$code" == "200" ]]; then nova_log "SYSTEM READY"; return 0; fi
  echo "SYSTEM NOT READY (HTTP $code)" >&2; return 1
}

case "${1:-status}" in
  start)   bash "$NOVA_LOCAL_DIR/scripts/start.sh" ;;
  stop)    bash "$NOVA_LOCAL_DIR/scripts/stop.sh" ;;      # reverse dependency order
  restart) bash "$NOVA_LOCAL_DIR/scripts/stop.sh"; bash "$NOVA_LOCAL_DIR/scripts/start.sh" ;;
  status)  cmd_status ;;
  health)  "${CURL[@]}" "$gw/health"; echo ;;
  ready)   cmd_ready ;;
  version) "${CURL[@]}" "$gw/nova/v1/system"; echo ;;
  ui)      bash "$NOVA_LOCAL_DIR/scripts/stamp-ui.sh" ;;
  build-ui) bash "$NOVA_LOCAL_DIR/scripts/build-ui.sh" ;;
  verify-ui) bash "$NOVA_LOCAL_DIR/scripts/verify-bundle.sh" "${2:-}" ;;
  tls)     bash "$NOVA_LOCAL_DIR/scripts/gen-tls.sh" "${2:-}" ;;
  backup)      bash "$NOVA_LOCAL_DIR/scripts/backup.sh" "${@:2}" ;;
  restore)     bash "$NOVA_LOCAL_DIR/scripts/restore.sh" "${@:2}" ;;
  diagnostics) bash "$NOVA_LOCAL_DIR/scripts/diagnostics.sh" "${@:2}" ;;
  *) echo "usage: novactl.sh {start|stop|restart|status|health|ready|version|tls|ui|build-ui|backup|restore|diagnostics}" >&2; exit 2 ;;
esac
