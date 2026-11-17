/**
 * P02.2 — demo registration.
 *
 * SQL-level guarantees (grant function hardcoding, RLS, tenant isolation)
 * are proven live against a real Postgres instance by
 * local/scripts/verify-demo-access.sql (see the Nolmark integration doc's
 * "live validation" section) — this suite covers the TS-layer logic that
 * fake can exercise cheaply: normalization, dedup, rate limiting, and the
 * response-state contract.
 */
import { describe, expect, it } from "vitest";
import { createDemoFakeSupabase, type FakeTables } from "./test-helpers/fakeSupabase";
import {
  registerDemoProspect,
  resendDemoVerification,
  normalizeEmail,
  hashIp,
} from "./registration.server";
import { DEMO_RATE_LIMITS } from "./constants";

const validInput = {
  firstName: "Ada",
  lastName: "Lovelace",
  workEmail: "Ada.Lovelace@Example.COM",
  company: "Analytical Engines Ltd",
  role: "Operations Lead",
  country: "TZ",
  source: "LEXIBITE_DEMO" as const,
};

function fake(tables: FakeTables = {}) {
  return createDemoFakeSupabase(tables);
}

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Ada.Lovelace@Example.COM  ")).toBe("ada.lovelace@example.com");
  });
});

describe("hashIp", () => {
  it("is deterministic and never returns the raw IP", async () => {
    const h1 = await hashIp("203.0.113.7");
    const h2 = await hashIp("203.0.113.7");
    expect(h1).toBe(h2);
    expect(h1).not.toContain("203.0.113.7");
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("registerDemoProspect", () => {
  it("registers a new prospect and normalizes the lookup email", async () => {
    const admin = fake();
    const result = await registerDemoProspect(admin, validInput, {
      ip: "203.0.113.7",
      origin: "https://demo.lexibite.test",
    });
    expect(result.status).toBe("verification_required");
    expect(result.registrationId).toBeTruthy();
  });

  it("attaches an auth_user_id and pending_verification status to the created row", async () => {
    const tables: FakeTables = { lexibite_demo_registrations: [] };
    const admin = fake(tables);
    await registerDemoProspect(admin, validInput, {
      ip: null,
      origin: "https://demo.lexibite.test",
    });
    expect(tables.lexibite_demo_registrations).toHaveLength(1);
    const row = tables.lexibite_demo_registrations![0];
    expect(row.work_email_normalized).toBe("ada.lovelace@example.com");
    expect(row.auth_user_id).toBeTruthy();
    expect(row.status).toBe("pending_verification");
  });

  it("returns already_registered for a duplicate normalized email, never a second row", async () => {
    const tables: FakeTables = { lexibite_demo_registrations: [] };
    const admin = fake(tables);
    await registerDemoProspect(admin, validInput, {
      ip: null,
      origin: "https://demo.lexibite.test",
    });
    const second = await registerDemoProspect(
      admin,
      { ...validInput, workEmail: "ada.lovelace@example.com" },
      { ip: null, origin: "https://demo.lexibite.test" },
    );
    expect(second.status).toBe("already_registered");
    expect(tables.lexibite_demo_registrations).toHaveLength(1);
  });

  it("ignores authorization-irrelevant forged fields (tenantId/grantedRole) — there is no such field on the contract, and the insert only ever reads validated fields by name", async () => {
    const tables: FakeTables = { lexibite_demo_registrations: [] };
    const admin = fake(tables);
    const forged = {
      ...validInput,
      tenantId: "attacker-tenant",
      grantedRole: "owner",
    } as typeof validInput & {
      tenantId: string;
      grantedRole: string;
    };
    await registerDemoProspect(admin, forged, { ip: null, origin: "https://demo.lexibite.test" });
    const row = tables.lexibite_demo_registrations![0];
    expect(row.tenant_id).toBeUndefined();
    expect(row.granted_role).toBeUndefined();
    expect(row.job_role).toBe("Operations Lead");
  });

  it("blocks registration once the per-IP hourly limit is reached", async () => {
    const ipHash = await hashIp("203.0.113.9");
    const tables: FakeTables = {
      lexibite_demo_registrations: Array.from(
        { length: DEMO_RATE_LIMITS.MAX_REGISTRATIONS_PER_IP_PER_HOUR },
        (_, i) => ({
          id: `existing-${i}`,
          ip_hash: ipHash,
          created_at: new Date().toISOString(),
          work_email_normalized: `existing-${i}@example.com`,
        }),
      ),
    };
    const admin = fake(tables);
    const result = await registerDemoProspect(admin, validInput, {
      ip: "203.0.113.9",
      origin: "https://demo.lexibite.test",
    });
    expect(result.status).toBe("error");
    expect(tables.lexibite_demo_registrations).toHaveLength(
      DEMO_RATE_LIMITS.MAX_REGISTRATIONS_PER_IP_PER_HOUR,
    );
  });
});

describe("resendDemoVerification", () => {
  it("does not reveal whether an email is registered", async () => {
    const admin = fake({ lexibite_demo_registrations: [] });
    const result = await resendDemoVerification(admin, "nobody@example.com", {
      origin: "https://demo.lexibite.test",
    });
    expect(result.status).toBe("verification_required");
    expect(result.registrationId).toBeNull();
  });

  it("refuses once the resend cap is hit", async () => {
    const tables: FakeTables = {
      lexibite_demo_registrations: [
        {
          id: "reg-1",
          work_email_normalized: "ada.lovelace@example.com",
          first_name: "Ada",
          status: "pending_verification",
          verification_resend_count: DEMO_RATE_LIMITS.MAX_RESENDS,
          verification_sent_at: null,
          auth_user_id: "user-1",
        },
      ],
    };
    const admin = fake(tables);
    const result = await resendDemoVerification(admin, "ada.lovelace@example.com", {
      origin: "https://demo.lexibite.test",
    });
    expect(result.status).toBe("error");
  });

  it("refuses a resend inside the minimum interval", async () => {
    const tables: FakeTables = {
      lexibite_demo_registrations: [
        {
          id: "reg-1",
          work_email_normalized: "ada.lovelace@example.com",
          first_name: "Ada",
          status: "pending_verification",
          verification_resend_count: 0,
          verification_sent_at: new Date().toISOString(),
          auth_user_id: "user-1",
        },
      ],
    };
    const admin = fake(tables);
    const result = await resendDemoVerification(admin, "ada.lovelace@example.com", {
      origin: "https://demo.lexibite.test",
    });
    expect(result.status).toBe("error");
  });
});
