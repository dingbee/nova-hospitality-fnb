/**
 * Runtime health collection (PRODUCTIZATION-3, Phase 9).
 * Every check is cheap and read-only; failures are reported, never thrown.
 */
import type { SQL } from "bun";
import {
  buildReport,
  type HealthComponent,
  type HealthReport,
} from "../../src/modules/runtime/local/health";

export async function collectHealth(
  sql: SQL,
  postgrestUrl: string,
  ui?: { status: "ok" | "down"; detail: string },
): Promise<HealthReport> {
  const components: HealthComponent[] = [
    { id: "application", status: "ok", detail: "gateway responding" },
  ];
  // A terminal with no UI cannot trade, so this is a first-class component:
  // /ready must fail honestly when the application bundle is unavailable.
  if (ui) components.push({ id: "application-ui", status: ui.status, detail: ui.detail });
  let schemaVersion: string | null = null;
  let appVersion = "unknown";

  try {
    const [row] = await sql`SELECT nova_local.health() AS health`;
    const health = (row?.health ?? {}) as Record<string, unknown>;
    schemaVersion = (health["schema_version"] as string) ?? null;
    appVersion = (health["app_version"] as string) ?? "unknown";

    components.push({
      id: "database",
      status: "ok",
      detail: `PostgreSQL ${String(health["database_version"] ?? "").split(" ")[0]}`,
    });
    components.push({
      id: "migrations",
      status: "ok",
      detail: `${health["migrations_applied"]} recorded`,
    });

    const unprotected = Number(health["rls_tables_without_policies"] ?? 0);
    components.push({
      id: "schema",
      status: unprotected === 0 ? "ok" : "degraded",
      detail:
        unprotected === 0
          ? "all tables have access policies"
          : `${unprotected} table(s) with row security but no policy`,
    });
    components.push({
      id: "auth",
      status: Number(health["administrators"] ?? 0) > 0 ? "ok" : "degraded",
      detail:
        Number(health["administrators"] ?? 0) > 0
          ? "administrator present"
          : "awaiting first-run setup",
    });
  } catch (error) {
    components.push({ id: "database", status: "down", detail: operatorDetail("database", error) });
    components.push({ id: "auth", status: "unknown" });
  }

  try {
    const response = await fetch(`${postgrestUrl}/`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    components.push({
      id: "postgrest",
      status: response.ok || response.status === 401 ? "ok" : "degraded",
      detail: `HTTP ${response.status}`,
    });
  } catch (error) {
    components.push({ id: "postgrest", status: "down", detail: operatorDetail("postgrest", error) });
  }

  return buildReport({ runtime: "local", appVersion, schemaVersion, components });
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Connection strings can carry credentials — report the shape, not the value.
  return message.replace(/postgres(ql)?:\/\/[^\s]*/gi, "[connection]").slice(0, 160);
}

/**
 * Health is read by on-site staff, not by developers: report the component and
 * the remedy in plain language. The raw driver/fetch error stays in the log.
 */
function operatorDetail(component: "database" | "postgrest", error: unknown): string {
  console.error(`[health:${component}]`, describe(error));
  return component === "database"
    ? "not reachable — check that the database service is running"
    : "not reachable — check that the data service is running";
}