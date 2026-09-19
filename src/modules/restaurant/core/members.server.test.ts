/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * ME-02 security certification — KD-11 regression.
 *
 * upsertMember/removeMember used to call
 * assertCapability(sb, userId, tenantId, "tenant.manage") with no property
 * scope, so a property-scoped owner/general_manager at Property A1 passed
 * exactly the same check as a tenant-wide one and could ask to grant or
 * revoke a role — including at a *different* property, or tenant-wide —
 * anywhere in the tenant. RLS's "members write scoped" policy
 * (0057_p09_membership_scope_enforcement.sql,
 * restaurant_can_manage_membership) already refused that write, but with a
 * raw database error rather than a clean one (the documented KD-11 gap).
 *
 * These tests exercise the real upsertMember/removeMember against a fake
 * Supabase client whose "restaurant_can_manage_membership" RPC reproduces
 * that migration's exact predicate, proving the application layer now
 * fails the same hostile requests *before* any round trip, with a
 * meaningful error message, and still allows every legitimate one.
 */
import { describe, expect, it } from "vitest";
import { removeMember, upsertMember } from "./members.server";

const TENANT_A = "tenant-a";
const PROPERTY_A1 = "property-a1";
const PROPERTY_A2 = "property-a2";

type Grant = { role: "owner" | "general_manager"; propertyId: string | null };

function makeFakeSb(opts: {
  callerGrants: Grant[];
  properties?: { id: string; tenantId: string }[];
  members?: {
    id: string;
    tenant_id: string;
    user_id: string;
    role: string;
    property_id: string | null;
  }[];
}) {
  const properties = opts.properties ?? [
    { id: PROPERTY_A1, tenantId: TENANT_A },
    { id: PROPERTY_A2, tenantId: TENANT_A },
  ];
  const members = [...(opts.members ?? [])];
  const activityLogs: any[] = [];

  function thenable<T>(compute: () => Promise<T>) {
    return { then: (res: any, rej: any) => compute().then(res, rej) };
  }

  return {
    async rpc(fn: string, args: any) {
      if (fn === "restaurant_can_manage_membership") {
        const { _tenant_id, _roles, _target_property_id } = args;
        const allowed = opts.callerGrants.some(
          (g) =>
            _roles.includes(g.role) &&
            (_target_property_id === null
              ? g.propertyId === null
              : g.propertyId === null || g.propertyId === _target_property_id),
        );
        return { data: allowed && _tenant_id === TENANT_A, error: null };
      }
      throw new Error(`Unexpected rpc ${fn}`);
    },
    from(table: string) {
      if (table === "restaurant_properties") {
        return {
          select: () => ({
            eq: (_c1: string, propId: string) => ({
              eq: (_c2: string, tenantId: string) => ({
                maybeSingle: async () => {
                  const found = properties.find((p) => p.id === propId && p.tenantId === tenantId);
                  return { data: found ? { id: found.id } : null, error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "restaurant_members") {
        return {
          select: (_cols: string) => ({
            eq: (_c1: string, memberId: string) => ({
              eq: (_c2: string, tenantId: string) => ({
                maybeSingle: async () => {
                  const found = members.find((m) => m.id === memberId && m.tenant_id === tenantId);
                  return {
                    data: found
                      ? { user_id: found.user_id, role: found.role, property_id: found.property_id }
                      : null,
                    error: null,
                  };
                },
              }),
            }),
          }),
          insert: (row: any) => ({
            select: (_cols: string) => ({
              single: async () => {
                const dup = members.some(
                  (m) =>
                    m.tenant_id === row.tenant_id &&
                    m.user_id === row.user_id &&
                    m.role === row.role &&
                    m.property_id === (row.property_id ?? null),
                );
                if (dup) return { data: null, error: { message: "duplicate key value violates" } };
                const inserted = { id: `m-${members.length + 1}`, ...row };
                members.push(inserted);
                return { data: inserted, error: null };
              },
            }),
          }),
          delete: () => ({
            eq: (_c1: string, memberId: string) => ({
              eq: (_c2: string, tenantId: string) =>
                thenable(async () => {
                  const before = members.length;
                  const kept = members.filter(
                    (m) => !(m.id === memberId && m.tenant_id === tenantId),
                  );
                  members.length = 0;
                  members.push(...kept);
                  return { error: null, removed: before !== members.length };
                }),
            }),
          }),
        };
      }
      if (table === "activity_logs") {
        return {
          insert: (row: any) => {
            activityLogs.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    members,
    activityLogs,
  };
}

describe("upsertMember — property-scoped grant cannot reach another property (KD-11)", () => {
  it("denies a property-A1-scoped owner granting a role at property A2", async () => {
    const sb = makeFakeSb({ callerGrants: [{ role: "owner", propertyId: PROPERTY_A1 }] });
    await expect(
      upsertMember(sb, "caller", {
        tenantId: TENANT_A,
        userId: "target-user",
        role: "bartender",
        propertyId: PROPERTY_A2,
      } as any),
    ).rejects.toThrow(/not have owner\/general manager authority at this property/);
  });

  it("denies a property-scoped owner granting a tenant-wide role", async () => {
    const sb = makeFakeSb({ callerGrants: [{ role: "owner", propertyId: PROPERTY_A1 }] });
    await expect(
      upsertMember(sb, "caller", {
        tenantId: TENANT_A,
        userId: "target-user",
        role: "owner",
        propertyId: null,
      } as any),
    ).rejects.toThrow(/tenant-wide owner\/general manager grant/);
  });

  it("allows a property-A1-scoped owner granting a role at property A1", async () => {
    const sb = makeFakeSb({ callerGrants: [{ role: "owner", propertyId: PROPERTY_A1 }] });
    const result = await upsertMember(sb, "caller", {
      tenantId: TENANT_A,
      userId: "target-user",
      role: "bartender",
      propertyId: PROPERTY_A1,
    } as any);
    expect(result).toMatchObject({
      user_id: "target-user",
      role: "bartender",
      property_id: PROPERTY_A1,
    });
    // ME-11: a role grant is a sensitive governance action — it must leave
    // an audit trail (Phase 8), not just succeed silently.
    expect(sb.activityLogs).toMatchObject([
      {
        tenant_id: TENANT_A,
        actor_id: "caller",
        action: "restaurant.member.granted",
        entity_type: "restaurant_members",
        metadata: { userId: "target-user", role: "bartender", propertyId: PROPERTY_A1 },
      },
    ]);
  });

  it("allows a tenant-wide owner granting a role anywhere in the tenant, including tenant-wide", async () => {
    const sb = makeFakeSb({ callerGrants: [{ role: "owner", propertyId: null }] });
    await expect(
      upsertMember(sb, "caller", {
        tenantId: TENANT_A,
        userId: "target-user-1",
        role: "bartender",
        propertyId: PROPERTY_A2,
      } as any),
    ).resolves.toMatchObject({ property_id: PROPERTY_A2 });
    await expect(
      upsertMember(sb, "caller", {
        tenantId: TENANT_A,
        userId: "target-user-2",
        role: "owner",
        propertyId: null,
      } as any),
    ).resolves.toMatchObject({ property_id: null });
  });
});

describe("removeMember — property-scoped grant cannot revoke another property's membership (KD-11)", () => {
  it("denies a property-A1-scoped owner revoking a membership at property A2", async () => {
    const sb = makeFakeSb({
      callerGrants: [{ role: "owner", propertyId: PROPERTY_A1 }],
      members: [
        {
          id: "m-1",
          tenant_id: TENANT_A,
          user_id: "victim",
          role: "bartender",
          property_id: PROPERTY_A2,
        },
      ],
    });
    await expect(
      removeMember(sb, "caller", { tenantId: TENANT_A, memberId: "m-1" } as any),
    ).rejects.toThrow(/not have owner\/general manager authority at this property/);
    expect(sb.members).toHaveLength(1); // nothing was deleted
  });

  it("allows a tenant-wide owner revoking a property-scoped membership", async () => {
    const sb = makeFakeSb({
      callerGrants: [{ role: "owner", propertyId: null }],
      members: [
        {
          id: "m-1",
          tenant_id: TENANT_A,
          user_id: "victim",
          role: "bartender",
          property_id: PROPERTY_A2,
        },
      ],
    });
    await expect(
      removeMember(sb, "caller", { tenantId: TENANT_A, memberId: "m-1" } as any),
    ).resolves.toEqual({ ok: true });
    expect(sb.members).toHaveLength(0);
    // ME-11: revocation is the same class of sensitive governance action as
    // a grant — it must be audited too.
    expect(sb.activityLogs).toMatchObject([
      {
        tenant_id: TENANT_A,
        actor_id: "caller",
        action: "restaurant.member.revoked",
        entity_type: "restaurant_members",
        entity_id: "m-1",
        metadata: { userId: "victim", role: "bartender", propertyId: PROPERTY_A2 },
      },
    ]);
  });
});
