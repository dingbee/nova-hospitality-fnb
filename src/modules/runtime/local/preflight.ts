/**
 * NOVA Hospitality — Restaurant & Bar OS
 * Installer pre-flight evaluation (PRODUCTIZATION-4, Phase B).
 *
 * Pure decision logic so the installer's verdicts are testable without a host.
 * The shell script collects the facts; this module judges them.
 */
import { MIN_POSTGRES_MAJOR } from "../version";

export const HOST_REQUIREMENTS = {
  supportedPlatforms: ["linux", "windows"] as const,
  supportedArchitectures: ["x86_64", "amd64", "aarch64", "arm64"] as const,
  minMemoryMb: 4096,
  minDiskMb: 20480,
  minPostgresMajor: MIN_POSTGRES_MAJOR,
  /** Ports the appliance owns. Only the gateway is LAN-exposed. */
  requiredPorts: [
    { port: 5432, component: "database", exposure: "loopback" },
    { port: 3001, component: "data-service", exposure: "loopback" },
    { port: 8000, component: "gateway", exposure: "lan" },
    { port: 8443, component: "gateway-tls", exposure: "lan" },
  ] as const,
};

export type CheckStatus = "pass" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightFacts {
  platform: string;
  architecture: string;
  memoryMb: number;
  diskFreeMb: number;
  postgresVersion?: string | null;
  /** Ports already bound on the host, with the owning process when known. */
  portsInUse?: { port: number; process?: string; ownedByNova?: boolean }[];
  /**
   * Standalone Docker mode: the appliance database is a container, so the host
   * is not required to have a PostgreSQL server or client installed.
   */
  database?: DatabaseFacts;
}

export interface DatabaseFacts {
  mode: "docker" | "host";
  dockerAvailable?: boolean;
  containerName?: string;
  containerRunning?: boolean;
  /** Server version reported by the container, e.g. "17.11". */
  serverVersion?: string | null;
  ready?: boolean;
  hostPort?: number;
  portReachable?: boolean;
}

export interface PreflightReport {
  ok: boolean;
  blocking: number;
  warnings: number;
  checks: PreflightCheck[];
}

const norm = (value: string) => value.trim().toLowerCase();

function majorOf(version?: string | null): number | null {
  if (!version) return null;
  const parsed = Number(/^(\d+)/.exec(version.trim())?.[1]);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Docker-mode database checks: the container is the appliance database. */
function dockerChecks(db: DatabaseFacts): PreflightCheck[] {
  const name = db.containerName ?? "nova-fnb-postgres";
  const major = majorOf(db.serverVersion);
  return [
    {
      id: "docker",
      label: "Docker engine",
      status: db.dockerAvailable ? "pass" : "fail",
      detail: db.dockerAvailable ? "available" : "docker not found — install Docker Desktop with WSL2 integration",
    },
    {
      id: "db-container",
      label: "Database container",
      status: db.containerRunning ? "pass" : "fail",
      detail: db.containerRunning ? `${name} running` : `${name} is not running`,
    },
    {
      id: "postgres",
      label: "PostgreSQL (container)",
      status: major === null ? "fail" : major >= HOST_REQUIREMENTS.minPostgresMajor ? "pass" : "fail",
      detail:
        major === null
          ? "container PostgreSQL version could not be determined"
          : `PostgreSQL ${db.serverVersion} in ${name}`,
    },
    {
      id: "db-ready",
      label: "Database readiness",
      status: db.ready ? "pass" : "fail",
      detail: db.ready ? "accepting connections" : "pg_isready did not report a ready database",
    },
    {
      id: "db-port",
      label: `Database port ${db.hostPort ?? 55432}`,
      status: db.portReachable ? "pass" : "fail",
      detail: db.portReachable ? "reachable on 127.0.0.1" : "not reachable from the host",
    },
  ];
}

export function evaluatePreflight(facts: PreflightFacts): PreflightReport {
  const checks: PreflightCheck[] = [];
  const platform = norm(facts.platform);
  const arch = norm(facts.architecture);

  checks.push({
    id: "platform",
    label: "Operating system",
    status: (HOST_REQUIREMENTS.supportedPlatforms as readonly string[]).includes(platform)
      ? "pass"
      : "fail",
    detail: facts.platform,
  });

  checks.push({
    id: "architecture",
    label: "CPU architecture",
    status: (HOST_REQUIREMENTS.supportedArchitectures as readonly string[]).includes(arch)
      ? "pass"
      : "fail",
    detail: facts.architecture,
  });

  checks.push({
    id: "memory",
    label: "Memory",
    status:
      facts.memoryMb >= HOST_REQUIREMENTS.minMemoryMb
        ? "pass"
        : facts.memoryMb >= HOST_REQUIREMENTS.minMemoryMb / 2
          ? "warn"
          : "fail",
    detail: `${facts.memoryMb} MB available, ${HOST_REQUIREMENTS.minMemoryMb} MB required`,
  });

  checks.push({
    id: "disk",
    label: "Disk space",
    status: facts.diskFreeMb >= HOST_REQUIREMENTS.minDiskMb ? "pass" : "fail",
    detail: `${facts.diskFreeMb} MB free, ${HOST_REQUIREMENTS.minDiskMb} MB required`,
  });

  if (facts.database?.mode === "docker") {
    // The container owns PostgreSQL; a missing host psql is not a failure.
    checks.push(...dockerChecks(facts.database));
  } else {
    const pgMajor = majorOf(facts.postgresVersion);
    checks.push({
      id: "postgres",
      label: "PostgreSQL",
      status:
        pgMajor === null ? "fail" : pgMajor >= HOST_REQUIREMENTS.minPostgresMajor ? "pass" : "fail",
      detail:
        pgMajor !== null
          ? `PostgreSQL ${pgMajor} detected`
          : "PostgreSQL not detected — install PostgreSQL 16 or newer",
    });
  }

  // A port held by a previous NOVA install is an upgrade signal, not a conflict.
  // In Docker mode the database port is owned by the container, so 5432 on the
  // host is irrelevant to us.
  const requiredPorts = HOST_REQUIREMENTS.requiredPorts.filter(
    (p) => !(facts.database?.mode === "docker" && p.component === "database"),
  );
  for (const required of requiredPorts) {
    const conflict = (facts.portsInUse ?? []).find((p) => p.port === required.port);
    checks.push({
      id: `port-${required.port}`,
      label: `Port ${required.port} (${required.component})`,
      status: !conflict ? "pass" : conflict.ownedByNova ? "warn" : "fail",
      detail: !conflict
        ? "free"
        : conflict.ownedByNova
          ? `held by an existing NOVA ${required.component}`
          : `in use by ${conflict.process ?? "another service"}`,
    });
  }

  const blocking = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  return { ok: blocking === 0, blocking, warnings, checks };
}
