/**
 * P08 — invariants for the "api_service" machine-only role introduced
 * alongside the external API credential system
 * (standalone/db/migrations/0057_p08_api_service_role.sql,
 * src/modules/api-platform/credentials.server.ts). These pin down the
 * least-privilege promise a write-scoped API credential makes: it can do
 * exactly what a bartender placing/progressing orders can do (sales.manage)
 * and NOTHING else, and it can never be assigned to a human staff member.
 */
import { describe, expect, it } from "vitest";
import { ASSIGNABLE_RESTAURANT_ROLES, RESTAURANT_ROLES, upsertMemberSchema } from "./contracts";
import { RESTAURANT_CAPABILITIES, rolesForCapability } from "./permissions";

describe("api_service role — least privilege invariant", () => {
  it("carries exactly one capability across the entire catalogue: sales.manage", () => {
    const grantedCapabilities = RESTAURANT_CAPABILITIES.filter((cap) =>
      rolesForCapability(cap).includes("api_service"),
    );
    expect(grantedCapabilities).toEqual(["sales.manage"]);
  });

  it("is never granted a capability a human role doesn't already have alongside it (no privilege it invents)", () => {
    const salesManageRoles = rolesForCapability("sales.manage");
    expect(salesManageRoles).toContain("api_service");
    // owner/general_manager/restaurant_manager remain the senior human roles for the same capability.
    expect(salesManageRoles).toEqual(
      expect.arrayContaining(["owner", "general_manager", "restaurant_manager"]),
    );
  });
});

describe("api_service role — never human-assignable", () => {
  it("is present in the full restaurant_role enum (the DB needs it for the service-account row)", () => {
    expect(RESTAURANT_ROLES).toContain("api_service");
  });

  it("is EXCLUDED from ASSIGNABLE_RESTAURANT_ROLES (the staff-role-picker list)", () => {
    expect(ASSIGNABLE_RESTAURANT_ROLES).not.toContain("api_service");
    expect(ASSIGNABLE_RESTAURANT_ROLES.length).toBe(RESTAURANT_ROLES.length - 1);
  });

  it("upsertMemberSchema — the server-side validator behind the staff management server function — REJECTS assigning it to a human, not just the UI", () => {
    const attempt = upsertMemberSchema.safeParse({
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "22222222-2222-2222-2222-222222222222",
      role: "api_service",
    });
    expect(attempt.success).toBe(false);
  });

  it("upsertMemberSchema still accepts every genuine human role", () => {
    for (const role of ASSIGNABLE_RESTAURANT_ROLES) {
      const attempt = upsertMemberSchema.safeParse({
        tenantId: "11111111-1111-1111-1111-111111111111",
        userId: "22222222-2222-2222-2222-222222222222",
        role,
      });
      expect(attempt.success).toBe(true);
    }
  });
});
