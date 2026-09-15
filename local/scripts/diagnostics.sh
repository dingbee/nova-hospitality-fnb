#!/usr/bin/env bash
# PRODUCTIZATION-4 Phase O — support diagnostic bundle.
#
# Everything written here passes through the product's redaction logic
# (src/modules/runtime/local/diagnostics.ts). No secrets, ever.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nova_load_env

OUT_DIR="${1:-$NOVA_LOCAL_DIR/diagnostics}"
mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/nova-diagnostics-$STAMP.json"

gw="$(nova_gateway_url 127.0.0.1)"
HEALTH=$(curl -sk "$gw/health" || echo '{}')
SYSTEM=$(curl -sk "$gw/nova/v1/system" || echo '{}')
LAST_BACKUP=$( (ls -1t "$NOVA_BACKUP_DIR"/*.manifest.json 2>/dev/null || true) | head -1 )
BACKUP_META=$([[ -n "$LAST_BACKUP" ]] && cat "$LAST_BACKUP" || echo '{}')

export NOVA_DIAG_HEALTH="$HEALTH" NOVA_DIAG_SYSTEM="$SYSTEM" NOVA_DIAG_BACKUP="$BACKUP_META"
export NOVA_DIAG_GATEWAY_LOG="$(tail -n 200 "$NOVA_RUN_DIR/gateway.log" 2>/dev/null || echo '')"
export NOVA_DIAG_PGRST_LOG="$(tail -n 200 "$NOVA_RUN_DIR/postgrest.log" 2>/dev/null || echo '')"
# Only configuration metadata — the redaction layer is the second line of defence.
export NOVA_DIAG_ENV="$(env | grep '^NOVA_' | grep -v '^NOVA_DIAG_' || true)"

bun --silent -e "
  const { buildDiagnosticBundle } = await import('$NOVA_ROOT/src/modules/runtime/local/diagnostics.ts');
  const j = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
  const health = j(process.env.NOVA_DIAG_HEALTH);
  const system = j(process.env.NOVA_DIAG_SYSTEM);
  const backup = j(process.env.NOVA_DIAG_BACKUP);
  const config = Object.fromEntries(
    (process.env.NOVA_DIAG_ENV || '').split('\n').filter(Boolean).map((l) => {
      const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
  const bundle = buildDiagnosticBundle({
    system: {
      schemaVersion: system.schemaVersion ?? health.schemaVersion ?? null,
      appVersion: system.appVersion ?? health.appVersion ?? undefined,
      installId: system.installId ?? null,
      postgresVersion: system.postgresVersion ?? null,
      migrationsApplied: system.migrationsApplied ?? null,
      lastBackupAt: backup.created_at ?? null,
      lastBackupStatus: backup.sha256 ? 'verified' : 'none',
      health: (health.components ?? []).some((c) => c.status === 'down') ? 'down'
        : (health.components ?? []).some((c) => c.status === 'degraded') ? 'degraded'
        : (health.components ?? []).length ? 'ok' : 'unknown',
      ready: !((health.components ?? []).some((c) => c.status === 'down')),
    },
    services: (health.components ?? []).map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
    configuration: config,
    logs: [
      { source: 'gateway', lines: (process.env.NOVA_DIAG_GATEWAY_LOG || '').split('\n') },
      { source: 'data-service', lines: (process.env.NOVA_DIAG_PGRST_LOG || '').split('\n') },
    ],
  });
  await Bun.write('$OUT', JSON.stringify(bundle, null, 2));
"
chmod 600 "$OUT"
nova_log "Diagnostic bundle written: $OUT"
