/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * Ops UAT gap #1 — user/staff provisioning.
 *
 * TeamPanel could only grant a restaurant role to someone already present
 * in the platform-wide staff directory (app_users), and nothing anywhere in
 * this codebase ever created that first account or app_users row — there
 * was no invite/signup path at all. provisionInvitedStaffUser closes that:
 * it's the piece TeamPanel's new "Invite a new person" form calls.
 */
import { describe, expect, it } from "vitest";
import { grantRbacRole, provisionInvitedStaffUser, revokeRbacRole } from "./staff.functions";

function makeFakeAdminClient(opts: { existingEmails?: string[] } = {}) {
  const appUsers: any[] = [];
  let seq = 0;

  return {
    auth: {
      admin: {
        inviteUserByEmail: async (email: string, _options?: any) => {
          if (opts.existingEmails?.includes(email)) {
            return { data: null, error: { message: "User already been registered" } };
          }
          seq += 1;
          return { data: { user: { id: `user-${seq}`, email } }, error: null };
        },
      },
    },
    from: (table: string) => {
      if (table !== "app_users") throw new Error(`Unexpected table ${table}`);
      return {
        insert: (row: any) => {
          appUsers.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    appUsers,
  };
}

describe("provisionInvitedStaffUser", () => {
  it("creates the auth account and mirrors it into app_users as pending", async () => {
    const admin = makeFakeAdminClient();

    const result = await provisionInvitedStaffUser(admin, {
      email: "newchef@example.com",
      fullName: "New Chef",
    });

    expect(result).toEqual({ userId: "user-1", email: "newchef@example.com" });
    expect(admin.appUsers).toEqual([
      {
        user_id: "user-1",
        email: "newchef@example.com",
        full_name: "New Chef",
        status: "pending",
      },
    ]);
  });

  it("works with no name supplied", async () => {
    const admin = makeFakeAdminClient();
    const result = await provisionInvitedStaffUser(admin, { email: "a@b.com" });
    expect(result.email).toBe("a@b.com");
    expect(admin.appUsers[0].full_name).toBeNull();
  });

  it("reports a duplicate invite as an operator-facing error, not a raw auth error", async () => {
    const admin = makeFakeAdminClient({ existingEmails: ["existing@example.com"] });

    await expect(
      provisionInvitedStaffUser(admin, { email: "existing@example.com" }),
    ).rejects.toThrow(/existing@example\.com already has an account/);
    expect(admin.appUsers).toHaveLength(0); // no orphan profile row for a failed invite
  });

  it("never inserts an app_users row when the auth invite itself fails", async () => {
    const admin = {
      auth: {
        admin: {
          inviteUserByEmail: async () => ({ data: null, error: { message: "rate limited" } }),
        },
      },
      from: () => {
        throw new Error("app_users should never be touched after a failed invite");
      },
    };
    await expect(provisionInvitedStaffUser(admin, { email: "x@y.com" })).rejects.toThrow(
      /rate limited/,
    );
  });
});

/**
 * P09 enterprise closure — grantRbacRole/revokeRbacRole (assignRole/
 * revokeRole's core, pulled out for testability the same way
 * provisionInvitedStaffUser is above).
 *
 * Before this change, assignRole/revokeRole called
 * assertPermission(..., "ADMINISTRATION:ADMIN") with no scope — since only
 * OWNER holds that permission and OWNER's own scope may be narrower than
 * TENANT ("Assignment may always be narrower" — permissions.ts), an OWNER
 * scoped to one tenant (or even one property) could grant or revoke ANY
 * role, at ANY tenant/property/outlet, platform-wide, including making
 * themselves OWNER of an unrelated tenant. revokeRole additionally ignored
 * scope entirely when deleting, so revoking one scoped grant could delete
 * every row for that (user, role) regardless of tenant/property/outlet.
 * grantRbacRole/revokeRbacRole close both: authorization now requires the
 * TARGET grant's own scope (including a NULL/broader level, which is a
 * real, wider privilege — never "nothing to check") to be covered by the
 * caller's own held grant.
 */
describe("grantRbacRole / revokeRbacRole — cross-tenant escalation is blocked", () => {
  const TENANT_A = "tenant-a";
  const TENANT_B = "tenant-b";
  const PROPERTY_A1 = "property-a1";
  const CALLER_OWNER_TENANT_A = "owner-tenant-a"; // OWNER, tenant_id: A, unscoped below that
  const CALLER_OWNER_PROPERTY_A1 = "owner-property-a1"; // OWNER, narrowed to tenant A / property A1
  const CALLER_OWNER_PLATFORM = "owner-platform"; // OWNER, tenant_id: null (platform-wide)
  const CALLER_GM_TENANT_A = "gm-tenant-a"; // GENERAL_MANAGER — no ADMINISTRATION:ADMIN at all
  const TARGET_USER = "target-user";

  function makeFakeSupabase(
    seedGrants: Array<{
      user_id: string;
      role_code: string;
      tenant_id: string | null;
      property_id: string | null;
      outlet_id: string | null;
    }>,
  ) {
    const grants = seedGrants.map((g) => ({ ...g }));

    function table(name: string) {
      if (name !== "rbac_user_roles") throw new Error(`Unexpected table ${name}`);
      let op: "select" | "insert" | "delete" = "select";
      let insertRow: any = null;
      const filters: Array<(r: any) => boolean> = [];

      const api: any = {
        select() {
          return api;
        },
        eq(col: string, val: unknown) {
          filters.push((r: any) => r[col] === val);
          return api;
        },
        is(col: string, _val: null) {
          filters.push((r: any) => r[col] === null);
          return api;
        },
        insert(row: any) {
          op = "insert";
          insertRow = row;
          return api;
        },
        delete() {
          op = "delete";
          return api;
        },
        then(resolve: any) {
          if (op === "insert") {
            const dup = grants.some(
              (g) =>
                g.user_id === insertRow.user_id &&
                g.role_code === insertRow.role_code &&
                (g.tenant_id ?? null) === (insertRow.tenant_id ?? null) &&
                (g.property_id ?? null) === (insertRow.property_id ?? null) &&
                (g.outlet_id ?? null) === (insertRow.outlet_id ?? null),
            );
            if (dup) {
              resolve({ error: { message: "duplicate key value violates unique constraint" } });
              return;
            }
            grants.push({ ...insertRow });
            resolve({ error: null });
            return;
          }
          if (op === "delete") {
            for (let i = grants.length - 1; i >= 0; i -= 1) {
              if (filters.every((f) => f(grants[i]))) grants.splice(i, 1);
            }
            resolve({ error: null });
            return;
          }
          resolve({ data: grants.filter((r) => filters.every((f) => f(r))), error: null });
        },
      };
      return api;
    }

    return { from: table, grants } as any;
  }

  function baseFixture() {
    return [
      {
        user_id: CALLER_OWNER_TENANT_A,
        role_code: "OWNER",
        tenant_id: TENANT_A,
        property_id: null,
        outlet_id: null,
      },
      {
        user_id: CALLER_OWNER_PROPERTY_A1,
        role_code: "OWNER",
        tenant_id: TENANT_A,
        property_id: PROPERTY_A1,
        outlet_id: null,
      },
      {
        user_id: CALLER_OWNER_PLATFORM,
        role_code: "OWNER",
        tenant_id: null,
        property_id: null,
        outlet_id: null,
      },
      {
        user_id: CALLER_GM_TENANT_A,
        role_code: "GENERAL_MANAGER",
        tenant_id: TENANT_A,
        property_id: null,
        outlet_id: null,
      },
    ];
  }

  it("a tenant-scoped OWNER CAN grant a role within their own tenant", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const result = await grantRbacRole(sb, CALLER_OWNER_TENANT_A, {
      userId: TARGET_USER,
      role: "WAITER",
      tenantId: TENANT_A,
    });
    expect(result.ok).toBe(true);
    expect(
      sb.grants.some((g: any) => g.user_id === TARGET_USER && g.tenant_id === TENANT_A),
    ).toBe(true);
  });

  it("a tenant-scoped OWNER CANNOT grant a role in a different tenant — the core cross-tenant escalation this closes", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      grantRbacRole(sb, CALLER_OWNER_TENANT_A, {
        userId: TARGET_USER,
        role: "OWNER",
        tenantId: TENANT_B,
      }),
    ).rejects.toThrow(/Forbidden/i);
  });

  it("a tenant-scoped OWNER CANNOT grant a platform-wide (tenant_id: null) role", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      grantRbacRole(sb, CALLER_OWNER_TENANT_A, {
        userId: TARGET_USER,
        role: "OWNER",
        tenantId: null,
      }),
    ).rejects.toThrow(/Forbidden/i);
  });

  it("a property-scoped OWNER CANNOT grant a tenant-wide role within their own tenant", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      grantRbacRole(sb, CALLER_OWNER_PROPERTY_A1, {
        userId: TARGET_USER,
        role: "GENERAL_MANAGER",
        tenantId: TENANT_A,
        propertyId: null,
      }),
    ).rejects.toThrow(/Forbidden/i);
  });

  it("a property-scoped OWNER CAN grant a role scoped to their own property", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const result = await grantRbacRole(sb, CALLER_OWNER_PROPERTY_A1, {
      userId: TARGET_USER,
      role: "WAITER",
      tenantId: TENANT_A,
      propertyId: PROPERTY_A1,
    });
    expect(result.ok).toBe(true);
  });

  it("a platform-wide OWNER CAN grant a role in any tenant, including another OWNER", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const result = await grantRbacRole(sb, CALLER_OWNER_PLATFORM, {
      userId: TARGET_USER,
      role: "OWNER",
      tenantId: TENANT_B,
    });
    expect(result.ok).toBe(true);
  });

  it("a GENERAL_MANAGER (no ADMINISTRATION:ADMIN at all) cannot grant any role", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      grantRbacRole(sb, CALLER_GM_TENANT_A, {
        userId: TARGET_USER,
        role: "WAITER",
        tenantId: TENANT_A,
      }),
    ).rejects.toThrow(/Forbidden/i);
  });

  it("revokeRbacRole deletes exactly the scoped grant, not a sibling-scope grant for the same (user, role)", async () => {
    const sb = makeFakeSupabase([
      ...baseFixture(),
      {
        user_id: TARGET_USER,
        role_code: "WAITER",
        tenant_id: TENANT_A,
        property_id: PROPERTY_A1,
        outlet_id: null,
      },
      {
        user_id: TARGET_USER,
        role_code: "WAITER",
        tenant_id: TENANT_A,
        property_id: "property-a2",
        outlet_id: null,
      },
    ]);
    const result = await revokeRbacRole(sb, CALLER_OWNER_TENANT_A, {
      userId: TARGET_USER,
      role: "WAITER",
      tenantId: TENANT_A,
      propertyId: PROPERTY_A1,
    });
    expect(result.ok).toBe(true);
    const remaining = sb.grants.filter(
      (g: any) => g.user_id === TARGET_USER && g.role_code === "WAITER",
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].property_id).toBe("property-a2");
  });

  it("a tenant-scoped OWNER CANNOT revoke a grant in a different tenant", async () => {
    const sb = makeFakeSupabase([
      ...baseFixture(),
      {
        user_id: TARGET_USER,
        role_code: "OWNER",
        tenant_id: TENANT_B,
        property_id: null,
        outlet_id: null,
      },
    ]);
    await expect(
      revokeRbacRole(sb, CALLER_OWNER_TENANT_A, {
        userId: TARGET_USER,
        role: "OWNER",
        tenantId: TENANT_B,
      }),
    ).rejects.toThrow(/Forbidden/i);
    expect(
      sb.grants.some((g: any) => g.user_id === TARGET_USER && g.tenant_id === TENANT_B),
    ).toBe(true);
  });
});
