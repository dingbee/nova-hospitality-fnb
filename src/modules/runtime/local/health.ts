/**
 * Local runtime health model (PRODUCTIZATION-3, Phase 9).
 * Pure aggregation logic — no secrets are ever placed in a health payload.
 */
export type ComponentStatus = "ok" | "degraded" | "down" | "unknown";

export interface HealthComponent {
  id:
    | "application"
    | "application-ui"
    | "database"
    | "postgrest"
    | "auth"
    | "schema"
    | "migrations"
    | "extensions"
    | "storage";
  status: ComponentStatus;
  detail?: string;
}

export interface HealthReport {
  runtime: "hosted" | "local";
  appVersion: string;
  schemaVersion: string | null;
  overall: ComponentStatus;
  checkedAt: string;
  components: HealthComponent[];
}

const RANK: Record<ComponentStatus, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

export function rollUp(components: HealthComponent[]): ComponentStatus {
  if (components.length === 0) return "unknown";
  return components.reduce<ComponentStatus>(
    (worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst),
    "ok",
  );
}

/**
 * A runtime is only READY when nothing is down and nothing is unknown.
 * "Degraded" (e.g. optional WAN services) still serves operations.
 */
export function isReady(report: HealthReport): boolean {
  return report.components.every((c) => c.status === "ok" || c.status === "degraded");
}

export function buildReport(input: {
  runtime: "hosted" | "local";
  appVersion: string;
  schemaVersion: string | null;
  components: HealthComponent[];
  checkedAt?: string;
}): HealthReport {
  return {
    runtime: input.runtime,
    appVersion: input.appVersion,
    schemaVersion: input.schemaVersion,
    components: input.components,
    overall: rollUp(input.components),
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

const SECRET_HINTS = ["password", "secret", "token", "jwt_key", "credential"];

/** Guard used by tests: no health payload may leak a secret-looking field. */
export function containsSecretLikeField(payload: unknown): boolean {
  const seen = JSON.stringify(payload ?? {}).toLowerCase();
  return SECRET_HINTS.some((hint) => seen.includes(hint));
}