import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { inspectBundle, resolveBundle } from "../../../../local/gateway/app";
import { evaluatePreflight, HOST_REQUIREMENTS } from "./preflight";
import { classifyInstall } from "./install-state";
import {
  buildDiagnosticBundle,
  canRestoreBackup,
  canRunDiagnostics,
  redactRecord,
  redactText,
} from "./diagnostics";
import {
  buildSanList,
  evaluateCertificate,
  pwaInstallability,
  resolveTlsConfig,
  terminalOrigin,
} from "./tls";
import { checkCompatibility, APP_VERSION, REQUIRED_SCHEMA_VERSION } from "../version";

const healthyFacts = {
  platform: "linux",
  architecture: "x86_64",
  memoryMb: 8192,
  diskFreeMb: 51200,
  postgresVersion: "17.9",
  portsInUse: [],
};

describe("installer pre-flight", () => {
  it("passes on a supported clean host", () => {
    const report = evaluatePreflight(healthyFacts);
    expect(report.ok).toBe(true);
    expect(report.blocking).toBe(0);
    expect(report.checks.length).toBe(5 + HOST_REQUIREMENTS.requiredPorts.length);
  });

  it("blocks unsupported platform, architecture, memory, disk and PostgreSQL", () => {
    const report = evaluatePreflight({
      platform: "darwin",
      architecture: "ppc64",
      memoryMb: 512,
      diskFreeMb: 1024,
      postgresVersion: "14.2",
    });
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => c.status === "fail").map((c) => c.id);
    expect(failed).toEqual(
      expect.arrayContaining(["platform", "architecture", "memory", "disk", "postgres"]),
    );
  });

  it("treats a foreign port holder as blocking and a NOVA port holder as a warning", () => {
    const foreign = evaluatePreflight({
      ...healthyFacts,
      portsInUse: [{ port: 8000, process: "nginx" }],
    });
    expect(foreign.ok).toBe(false);

    const ours = evaluatePreflight({
      ...healthyFacts,
      portsInUse: [{ port: 8000, process: "nova-gateway", ownedByNova: true }],
    });
    expect(ours.ok).toBe(true);
    expect(ours.warnings).toBe(1);
  });

  it("fails when PostgreSQL is absent", () => {
    const report = evaluatePreflight({ ...healthyFacts, postgresVersion: null });
    expect(report.checks.find((c) => c.id === "postgres")?.status).toBe("fail");
  });
});

describe("standalone Docker PostgreSQL pre-flight (P-4F)", () => {
  const dockerDb = {
    mode: "docker" as const,
    dockerAvailable: true,
    containerName: "nova-fnb-postgres",
    containerRunning: true,
    serverVersion: "17.11",
    ready: true,
    hostPort: 55432,
    portReachable: true,
  };

  it("passes with a Docker PostgreSQL 17 container and no host psql", () => {
    const report = evaluatePreflight({ ...healthyFacts, postgresVersion: null, database: dockerDb });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === "postgres")?.status).toBe("pass");
    // The host's 5432 is irrelevant in Docker mode.
    expect(report.checks.find((c) => c.id === "port-5432")).toBeUndefined();
  });

  it("still fails on an incompatible container PostgreSQL version", () => {
    const report = evaluatePreflight({
      ...healthyFacts,
      postgresVersion: null,
      database: { ...dockerDb, serverVersion: "14.2" },
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "postgres")?.status).toBe("fail");
  });

  it("fails when Docker, the container, readiness or the port is unavailable", () => {
    const report = evaluatePreflight({
      ...healthyFacts,
      database: {
        mode: "docker",
        dockerAvailable: false,
        containerRunning: false,
        serverVersion: null,
        ready: false,
        portReachable: false,
      },
    });
    const failed = report.checks.filter((c) => c.status === "fail").map((c) => c.id);
    expect(failed).toEqual(
      expect.arrayContaining(["docker", "db-container", "postgres", "db-ready", "db-port"]),
    );
  });

  it("keeps host-mode behaviour unchanged", () => {
    const report = evaluatePreflight({ ...healthyFacts, database: { mode: "host" } });
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBe(5 + HOST_REQUIREMENTS.requiredPorts.length);
  });
});

describe("installation state", () => {
  it("classifies a clean machine as fresh install", () => {
    expect(classifyInstall({ installMarkerPresent: false, databasePresent: false, migrationsApplied: 0 })).toMatchObject(
      { state: "fresh", action: "install" },
    );
  });

  it("never destroys an existing installation", () => {
    const decision = classifyInstall({
      installMarkerPresent: true,
      databasePresent: true,
      migrationsApplied: 98,
      installId: "11111111-1111-1111-1111-111111111111",
      installedVersion: "1.2.0",
    });
    expect(decision.state).toBe("existing");
    expect(decision.action).toBe("upgrade");
    expect(decision.destructive).toBe(false);
  });

  it("classifies a half-finished install as repair", () => {
    expect(
      classifyInstall({ installMarkerPresent: true, databasePresent: true, migrationsApplied: 0 }),
    ).toMatchObject({ state: "interrupted", action: "repair" });
  });

  it("aborts when the database belongs to something else", () => {
    expect(
      classifyInstall({
        installMarkerPresent: false,
        databasePresent: true,
        migrationsApplied: 0,
        unknownDatabaseOwner: true,
      }),
    ).toMatchObject({ state: "foreign", action: "abort" });
  });
});

describe("diagnostics redaction", () => {
  it("removes connection strings, private keys and JWTs from text", () => {
    const text = [
      "connecting to postgresql://nova:sup3rs3cret@127.0.0.1:5432/nova_local",
      "token eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl",
      "-----BEGIN PRIVATE KEY-----MIIBVgIBADAN-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactText(text);
    expect(out).not.toMatch(/sup3rs3cret/);
    expect(out).not.toMatch(/eyJhbGciOiJFUzI1NiJ9/);
    expect(out).not.toMatch(/MIIBVgIBADAN/);
  });

  it("redacts sensitive keys in configuration records, recursively", () => {
    const out = redactRecord({
      NOVA_DB_HOST: "127.0.0.1",
      NOVA_DB_SUPERUSER_PASSWORD: "hunter2",
      nested: { refresh_token: "abc123", gatewayPort: 8000 },
    });
    expect(out["NOVA_DB_HOST"]).toBe("127.0.0.1");
    expect(out["NOVA_DB_SUPERUSER_PASSWORD"]).toBe("[redacted]");
    expect((out["nested"] as Record<string, unknown>)["refresh_token"]).toBe("[redacted]");
    expect((out["nested"] as Record<string, unknown>)["gatewayPort"]).toBe(8000);
  });

  it("builds a support bundle with versions and no secrets", () => {
    const bundle = buildDiagnosticBundle({
      system: { schemaVersion: REQUIRED_SCHEMA_VERSION, installId: "abc", health: "ok", ready: true },
      configuration: { NOVA_JWT_PRIVATE_KEY_FILE: "/opt/nova/keys/jwt-private.pem", NOVA_DB_SUPERUSER_PASSWORD: "x" },
      logs: [{ source: "gateway", lines: ["listening", "db=postgresql://u:p@localhost/nova"] }],
    });
    expect(bundle.system.appVersion).toBe(APP_VERSION);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toMatch(/hunter2|postgresql:\/\/u:p/);
    expect(bundle.configuration["NOVA_DB_SUPERUSER_PASSWORD"]).toBe("[redacted]");
  });

  it("restricts diagnostics and restore by role", () => {
    expect(canRunDiagnostics("admin")).toBe(true);
    expect(canRunDiagnostics("cashier")).toBe(false);
    expect(canRestoreBackup("admin")).toBe(false);
    expect(canRestoreBackup("owner")).toBe(true);
  });
});

describe("version contract", () => {
  it("accepts the shipped schema and rejects drift", () => {
    expect(checkCompatibility({ schemaVersion: REQUIRED_SCHEMA_VERSION, postgresVersion: "17.9" }).compatible).toBe(true);
    expect(checkCompatibility({ schemaVersion: "2020.01.01", postgresVersion: "17.9" }).reason).toBe("schema-behind");
    expect(checkCompatibility({ schemaVersion: REQUIRED_SCHEMA_VERSION, postgresVersion: "14.1" }).reason).toBe(
      "postgres-too-old",
    );
  });
});

describe("local TLS origin (P-4C)", () => {
  const present = { certPresent: true, keyPresent: true };

  it("enables HTTPS when certificate material exists", () => {
    const cfg = resolveTlsConfig({}, present);
    expect(cfg).toMatchObject({ enabled: true, httpsPort: 8443, httpPort: 8000 });
    expect(terminalOrigin(cfg, "10.0.0.5")).toBe("https://10.0.0.5:8443");
  });

  it("stays on HTTP, with a stated reason, when material is missing or disabled", () => {
    const missing = resolveTlsConfig({}, { certPresent: false, keyPresent: true });
    expect(missing.enabled).toBe(false);
    expect(missing.reason).toMatch(/certificate/i);
    const off = resolveTlsConfig({ NOVA_TLS_MODE: "off" }, present);
    expect(off.enabled).toBe(false);
    expect(terminalOrigin(off, "10.0.0.5")).toBe("http://10.0.0.5:8000");
  });

  it("covers hostname, mDNS name and LAN address in the certificate", () => {
    const san = buildSanList({
      hostnames: ["nova-appliance", "localhost"],
      ipAddresses: ["192.168.1.20", "169.254.3.4", "127.0.0.1"],
    });
    expect(san).toContain("DNS:localhost");
    expect(san).toContain("DNS:nova-appliance");
    expect(san).toContain("DNS:nova-appliance.local");
    expect(san).toContain("IP:192.168.1.20");
    expect(san).not.toContain("IP:169.254.3.4");
    expect(san.filter((s) => s === "IP:127.0.0.1")).toHaveLength(1);
  });

  it("reports certificate lifecycle honestly", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(evaluateCertificate("2027-01-01T00:00:00Z", now).status).toBe("ok");
    expect(evaluateCertificate("2026-01-20T00:00:00Z", now).status).toBe("expiring");
    expect(evaluateCertificate("2025-12-01T00:00:00Z", now).status).toBe("expired");
    expect(evaluateCertificate(null, now).status).toBe("unknown");
  });

  it("does not claim PWA installability on an untrusted or insecure origin", () => {
    expect(pwaInstallability({ https: false, certificateTrustedByDevice: true, host: "192.168.1.20" }).installable).toBe(false);
    expect(pwaInstallability({ https: true, certificateTrustedByDevice: false, host: "192.168.1.20" }).installable).toBe(false);
    expect(pwaInstallability({ https: true, certificateTrustedByDevice: true, host: "192.168.1.20" }).installable).toBe(true);
  });
});

// --- PRODUCTIZATION-4D: local application UI serving -------------------------
describe("local application UI bundle", () => {
  const root = "/tmp/nova-ui-bundle-test";

  it("resolves the bundle beside the runtime by default", () => {
    const bundle = resolveBundle("/opt/nova", {});
    expect(bundle.clientDir).toBe("/opt/nova/dist/client");
    expect(bundle.serverEntry).toBe("/opt/nova/dist/server/index.mjs");
  });

  it("honours an explicit bundle directory", () => {
    expect(resolveBundle("/opt/nova", { NOVA_APP_BUNDLE_DIR: "/srv/ui" }).clientDir).toBe(
      "/srv/ui/client",
    );
  });

  it("reports a missing bundle as down rather than ready", () => {
    const state = inspectBundle(resolveBundle("/nonexistent-appliance", {}));
    expect(state.status).toBe("down");
    expect(state.detail).toMatch(/missing/);
  });

  it("reports a truncated server bundle as down", () => {
    mkdirSync(`${root}/client`, { recursive: true });
    mkdirSync(`${root}/server`, { recursive: true });
    writeFileSync(`${root}/server/index.mjs`, "x");
    expect(inspectBundle(resolveBundle(root, { NOVA_APP_BUNDLE_DIR: root })).status).toBe("down");

    writeFileSync(`${root}/server/index.mjs`, "x".repeat(2048));
    expect(inspectBundle(resolveBundle(root, { NOVA_APP_BUNDLE_DIR: root })).status).toBe("ok");
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps application UI state out of secret-bearing payloads", () => {
    const bundle = buildDiagnosticBundle({ system: { uiStatus: "ok", uiVersion: APP_VERSION } });
    expect(bundle.system.uiStatus).toBe("ok");
    expect(JSON.stringify(bundle)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });
});
