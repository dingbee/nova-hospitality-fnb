/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P09 enterprise closure — restaurant_members mutation surface
 * (listMembers/upsertMember/removeMember/updateMemberRole).
 *
 * Before this change, `upsertMember`/`removeMember` called
 * `assertCapability(..., "tenant.manage")` with no property scope at all —
 * any owner/general_manager grant anywhere in the tenant, including one
 * scoped to a single property, passed the same check as a tenant-wide one.
 * A property-scoped general_manager could therefore grant or revoke ANY
 * role — including "owner", tenant-wide — at any property in the tenant, or
 * tenant-wide, which is exactly the delegated-administration escalation
 * this suite proves is now blocked. These tests exercise the real
 * `members.server.ts` functions against a fake Supabase client that mirrors
 * the actual restaurant_members/restaurant_properties tables (including
 * unique-constraint duplicate errors and real insert/update/delete
 * semantics), not a stub that merely records calls.
 */
import { describe, expect, it } from "vitest";
import { listMembers, removeMember, updateMemberRole, upsertMember } from "./members.server";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const PROPERTY_A1 = "property-a1";
const PROPERTY_A2 = "property-a2";

const USER_GM_A1 = "user-gm-a1"; // general_manager scoped to Property A1 only
const USER_OWNER_TENANT_WIDE = "user-owner-tenant-wide"; // owner, tenant-wide in Tenant A
const USER_VIEWER_A1 = "user-viewer-a1"; // viewer scoped to A1 — no tenant.manage capability
const USER_OWNER_TENANT_B = "user-owner-tenant-b"; // owner, tenant-wide, but only in Tenant B
const TARGET_STAFF_USER = "target-staff-user"; // the person being granted/changed/removed

function makeFakeSupabase(
  seedMembers: Array<{
    id: string;
    tenant_id: string;
    user_id: string;
    role: string;
    property_id: string | null;
  }>,
) {
  const members = seedMembers.map((m) => ({ ...m }));
  const properties = [
    { id: PROPERTY_A1, tenant_id: TENANT_A },
    { id: PROPERTY_A2, tenant_id: TENANT_A },
  ];
  let seq = members.length;

  function table(name: string) {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    const filters: Array<(r: any) => boolean> = [];

    function rows(): any[] {
      if (name === "restaurant_members") return members;
      if (name === "restaurant_properties") return properties;
      return [];
    }
    function matching() {
      return rows().filter((r) => filters.every((f) => f(r)));
    }

    const api: any = {
      select() {
        return api;
      },
      order() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((r: any) => r[col] === val);
        return api;
      },
      insert(row: any) {
        op = "insert";
        payload = row;
        return api;
      },
      update(patch: any) {
        op = "update";
        payload = patch;
        return api;
      },
      delete() {
        op = "delete";
        return api;
      },
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      single: async () => {
        if (op === "insert") {
          const row = payload;
          const dup = members.some(
            (m) =>
              m.tenant_id === row.tenant_id &&
              m.user_id === row.user_id &&
              m.role === row.role &&
              (m.property_id ?? null) === (row.property_id ?? null),
          );
          if (dup) {
            return {
              data: null,
              error: { message: "duplicate key value violates unique constraint" },
            };
          }
          seq += 1;
          const stored = {
            id: `member-${seq}`,
            tenant_id: row.tenant_id,
            user_id: row.user_id,
            role: row.role,
            property_id: row.property_id ?? null,
          };
          members.push(stored);
          return { data: stored, error: null };
        }
        if (op === "update") {
          const target = matching()[0];
          if (!target) return { data: null, error: { message: "no matching row" } };
          const newRole = "role" in payload ? payload.role : target.role;
          const newPropertyId = "property_id" in payload ? payload.property_id : target.property_id;
          const dup = members.some(
            (m) =>
              m.id !== target.id &&
              m.tenant_id === target.tenant_id &&
              m.user_id === target.user_id &&
              m.role === newRole &&
              (m.property_id ?? null) === (newPropertyId ?? null),
          );
          if (dup) {
            return {
              data: null,
              error: { message: "duplicate key value violates unique constraint" },
            };
          }
          Object.assign(target, { role: newRole, property_id: newPropertyId ?? null });
          return { data: target, error: null };
        }
        return { data: matching()[0] ?? null, error: null };
      },
      then(resolve: any) {
        if (op === "delete") {
          const idx = rows().findIndex((r) => filters.every((f) => f(r)));
          if (idx >= 0) rows().splice(idx, 1);
          resolve({ error: null });
          return;
        }
        resolve({ data: matching(), error: null });
      },
    };
    return api;
  }

  return {
    rpc: async () => ({ data: false, error: null }), // never a platform admin in these fixtures
    from: table,
  } as any;
}

function baseFixture() {
  return [
    { id: "m-gm-a1", tenant_id: TENANT_A, user_id: USER_GM_A1, role: "general_manager", property_id: PROPERTY_A1 },
    {
      id: "m-owner-tw",
      tenant_id: TENANT_A,
      user_id: USER_OWNER_TENANT_WIDE,
      role: "owner",
      property_id: null,
    },
    { id: "m-viewer-a1", tenant_id: TENANT_A, user_id: USER_VIEWER_A1, role: "viewer", property_id: PROPERTY_A1 },
    { id: "m-owner-b", tenant_id: TENANT_B, user_id: USER_OWNER_TENANT_B, role: "owner", property_id: null },
  ];
}

describe("upsertMember — property-scope escalation is blocked", () => {
  it("a property-scoped general_manager CAN grant a role at their own property", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const created = await upsertMember(sb, USER_GM_A1, {
      tenantId: TENANT_A,
      userId: TARGET_STAFF_USER,
      role: "chef",
      propertyId: PROPERTY_A1,
    });
    expect(created.property_id).toBe(PROPERTY_A1);
  });

  it("a property-scoped general_manager CANNOT grant a role at a sibling property", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      upsertMember(sb, USER_GM_A1, {
        tenantId: TENANT_A,
        userId: TARGET_STAFF_USER,
        role: "chef",
        propertyId: PROPERTY_A2,
      }),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a property-scoped general_manager CANNOT grant a tenant-wide role — the core P09 escalation this closes", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      upsertMember(sb, USER_GM_A1, {
        tenantId: TENANT_A,
        userId: TARGET_STAFF_USER,
        role: "owner",
        propertyId: null,
      }),
    ).rejects.toThrow(/tenant-wide/i);
  });

  it("a property-scoped general_manager CANNOT grant themselves a broader role by omitting propertyId", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      upsertMember(sb, USER_GM_A1, {
        tenantId: TENANT_A,
        userId: USER_GM_A1,
        role: "owner",
      }),
    ).rejects.toThrow(/tenant-wide/i);
  });

  it("a tenant-wide owner CAN grant a tenant-wide role", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const created = await upsertMember(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      userId: TARGET_STAFF_USER,
      role: "general_manager",
      propertyId: null,
    });
    expect(created.property_id).toBeNull();
  });

  it("a tenant-wide owner CAN grant a role at any property in their tenant", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const created = await upsertMember(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      userId: TARGET_STAFF_USER,
      role: "bartender",
      propertyId: PROPERTY_A2,
    });
    expect(created.property_id).toBe(PROPERTY_A2);
  });

  it("a viewer (no tenant.manage capability) cannot grant any role, even at their own property", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      upsertMember(sb, USER_VIEWER_A1, {
        tenantId: TENANT_A,
        userId: TARGET_STAFF_USER,
        role: "viewer",
        propertyId: PROPERTY_A1,
      }),
    ).rejects.toThrow(/Forbidden/i);
  });

  it("an owner scoped only to Tenant B cannot grant membership in Tenant A", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      upsertMember(sb, USER_OWNER_TENANT_B, {
        tenantId: TENANT_A,
        userId: TARGET_STAFF_USER,
        role: "viewer",
        propertyId: PROPERTY_A1,
      }),
    ).rejects.toThrow(/Forbidden/i);
  });
});

describe("removeMember — property-scope escalation is blocked", () => {
  it("a property-scoped general_manager CAN remove a member at their own property", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const result = await removeMember(sb, USER_GM_A1, { tenantId: TENANT_A, memberId: "m-viewer-a1" });
    expect(result.ok).toBe(true);
    const remaining = await listMembers(sb, USER_GM_A1, { tenantId: TENANT_A });
    expect(remaining.find((m: any) => m.id === "m-viewer-a1")).toBeUndefined();
  });

  it("a property-scoped general_manager CANNOT remove the tenant-wide owner's membership", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      removeMember(sb, USER_GM_A1, { tenantId: TENANT_A, memberId: "m-owner-tw" }),
    ).rejects.toThrow(/tenant-wide/i);
  });

  it("a property-scoped general_manager CANNOT remove a member at a sibling property", async () => {
    const sb = makeFakeSupabase([
      ...baseFixture(),
      { id: "m-a2-member", tenant_id: TENANT_A, user_id: TARGET_STAFF_USER, role: "chef", property_id: PROPERTY_A2 },
    ]);
    await expect(
      removeMember(sb, USER_GM_A1, { tenantId: TENANT_A, memberId: "m-a2-member" }),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a tenant-wide owner CAN remove a tenant-wide grant", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const result = await removeMember(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      memberId: "m-owner-tw",
    });
    expect(result.ok).toBe(true);
  });

  it("removing an already-gone member is idempotent, not an error", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const result = await removeMember(sb, USER_GM_A1, { tenantId: TENANT_A, memberId: "no-such-id" });
    expect(result.ok).toBe(true);
  });
});

describe("updateMemberRole — in-place role change replaces the grant instead of adding a second one", () => {
  it("a property-scoped general_manager CAN change a role within their own property, and the row is replaced in place", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const updated = await updateMemberRole(sb, USER_GM_A1, {
      tenantId: TENANT_A,
      memberId: "m-viewer-a1",
      role: "chef",
      propertyId: PROPERTY_A1,
    });
    expect(updated.role).toBe("chef");
    const remaining = await listMembers(sb, USER_GM_A1, { tenantId: TENANT_A });
    // Exactly one row for this member — not the original "viewer" row PLUS a
    // new "chef" row. This is the "safe revocation" bug: changing a role via
    // the Staff panel must not leave the old, broader role silently active.
    expect(remaining.filter((m: any) => m.id === "m-viewer-a1")).toHaveLength(1);
    expect(remaining.find((m: any) => m.id === "m-viewer-a1")?.role).toBe("chef");
  });

  it("a property-scoped general_manager CANNOT widen a membership to tenant-wide via an update", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      updateMemberRole(sb, USER_GM_A1, {
        tenantId: TENANT_A,
        memberId: "m-viewer-a1",
        role: "owner",
        propertyId: null,
      }),
    ).rejects.toThrow(/tenant-wide/i);
  });

  it("a property-scoped general_manager CANNOT move a member FROM a sibling property they don't control, even TO their own", async () => {
    const sb = makeFakeSupabase([
      ...baseFixture(),
      { id: "m-a2-member", tenant_id: TENANT_A, user_id: TARGET_STAFF_USER, role: "chef", property_id: PROPERTY_A2 },
    ]);
    await expect(
      updateMemberRole(sb, USER_GM_A1, {
        tenantId: TENANT_A,
        memberId: "m-a2-member",
        role: "chef",
        propertyId: PROPERTY_A1,
      }),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a property-scoped general_manager CANNOT downgrade the tenant-wide owner's grant (escalation-by-edit of someone else's scope)", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      updateMemberRole(sb, USER_GM_A1, {
        tenantId: TENANT_A,
        memberId: "m-owner-tw",
        role: "viewer",
        propertyId: PROPERTY_A1,
      }),
    ).rejects.toThrow(/tenant-wide/i);
  });

  it("a tenant-wide owner CAN change any member's role or scope, including narrowing a tenant-wide grant to one property", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const updated = await updateMemberRole(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      memberId: "m-owner-tw",
      role: "general_manager",
      propertyId: PROPERTY_A1,
    });
    expect(updated.role).toBe("general_manager");
    expect(updated.property_id).toBe(PROPERTY_A1);
  });
});

describe("listMembers — tenant read boundary (regression)", () => {
  it("a member of Tenant A never sees Tenant B's roster", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const rows = await listMembers(sb, USER_GM_A1, { tenantId: TENANT_A });
    expect(rows.every((m: any) => m.tenant_id === TENANT_A)).toBe(true);
    expect(rows.find((m: any) => m.user_id === USER_OWNER_TENANT_B)).toBeUndefined();
  });
});
