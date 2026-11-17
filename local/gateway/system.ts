/**
 * Product / system information (PRODUCTIZATION-4, Phase N).
 *
 * Deliberately narrow: versions, identity and operational state. It reads no
 * configuration file and returns nothing that could be a credential.
 */
import type { SQL } from "bun";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { collectHealth } from "./health";
import type { SystemInformation } from "../../src/modules/runtime/local/diagnostics";
import { APP_VERSION, NOVA_PRODUCT, REQUIRED_SCHEMA_VERSION } from "../../src/modules/runtime/version";

function lastBackup(dir: string): { at: string | null; status: SystemInformation["lastBackupStatus"] } {
  try {
    const manifests = readdirSync(dir)
      .filter((f) => f.endsWith(".manifest.json"))
      .map((f) => `${dir}/${f}`)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const latest = manifests[0];
    if (!latest) return { at: null, status: "none" };
    const manifest = JSON.parse(readFileSync(latest, "utf8")) as Record<string, unknown>;
    return {
      at: (manifest["created_at"] as string) ?? new Date(statSync(latest).mtimeMs).toISOString(),
      // A manifest without a checksum cannot be proven intact.
      status: manifest["sha256"] ? "verified" : "unverified",
    };
  } catch {
    return { at: null, status: "none" };
  }
}

export async function collectSystemInformation(sql: SQL, postgrestUrl: string, ui?: { status: "ok" | "down"; detail: string }): Promise<SystemInformation & { product: string }> {
  const health = await collectHealth(sql, postgrestUrl, ui);
  const down = health.components.some((c) => c.status === "down");
  const degraded = health.components.some((c) => c.status === "degraded");

  let installId: string | null = null;
  let schemaVersion: string | null = health.schemaVersion ?? null;
  let postgresVersion: string | null = null;
  let migrationsApplied: number | null = null;

  try {
    const rows = (await sql`SELECT key, value FROM nova_local.runtime_meta`) as { key: string; value: string }[];
    const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    installId = meta["install_id"] ?? null;
    schemaVersion = meta["schema_version"] ?? schemaVersion;
    const [v] = await sql`SELECT current_setting('server_version') AS v`;
    postgresVersion = (v?.v as string) ?? null;
    const [m] = await sql`SELECT count(*)::int AS n FROM nova_local.schema_migrations`;
    migrationsApplied = m?.n ?? null;
  } catch {
    /* health already reports the failure; system info degrades honestly */
  }

  const backup = lastBackup(process.env["NOVA_BACKUP_DIR"] ?? "local/backups");

  return {
    product: NOVA_PRODUCT,
    appVersion: health.appVersion ?? APP_VERSION,
    requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
    schemaVersion,
    runtime: "local",
    installId,
    postgresVersion,
    migrationsApplied,
    lastBackupAt: backup.at,
    lastBackupStatus: backup.status,
    health: down ? "down" : degraded ? "degraded" : "ok",
    uiStatus: ui?.status ?? "unknown",
    uiVersion: ui ? APP_VERSION : null,
    // Ready means "the business can trade": APIs AND the terminal UI.
    ready: !down,
  };
}
