/**
 * ME-02 security certification — KD-11 regression (RBAC-tier half).
 *
 * assignRole/revokeRole used to call
 * assertPermission(supabase, userId, "ADMINISTRATION:ADMIN") with no scope,
 * which resolves through nova_has_permission(_user_id, _permission, NULL,
 * NULL, NULL) — and nova_has_permission treats an omitted tenant/property/
 * outlet argument as "don't check this level" for the *caller's own* grant,
 * not "the target must be unscoped". A caller holding ADMINISTRATION:ADMIN
 * in exactly one tenant therefore passed the same check as a platform-wide
 * grant, and could ask to write a role grant for an unrelated tenant.
 * RLS's rbac_user_roles_admin_scoped policy (0059_p09_tenancy_write_isolation.sql,
 * nova_can_manage_scoped) already refuses that write, but with a raw
 * database error instead of a clean one — the documented KD-11 gap.
 *
 * assertCanManageRbacRole closes it by checking the *target* grant's own
 * scope through nova_can_manage_scoped, which never treats a NULL target
 * level as unrestricted — it requires the caller's own grant to also be
 * NULL at that level. These tests reproduce that exact predicate against a
 * fake nova_can_manage_scoped RPC and prove the guard matches it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCanManageRbacRole, ForbiddenError, requirePermission } from "./rbac.server";

type Grant = { tenantId: string | null; propertyId: string | null; outletId: string | null };

/** Reproduces nova_can_manage_scoped's own NULL-matches-NULL-only semantics. */
function makeFakeSb(callerGrants: Grant[]) {
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== "nova_can_manage_scoped") throw new Error(`Unexpected rpc ${fn}`);
      const t = args["_tenant_id"] as string | null;
      const p = args["_property_id"] as string | null;
      const o = args["_outlet_id"] as string | null;
      const allowed = callerGrants.some(
        (g) =>
          (t === null ? g.tenantId === null : g.tenantId === null || g.tenantId === t) &&
          (p === null ? g.propertyId === null : g.propertyId === null || g.propertyId === p) &&
          (o === null ? g.outletId === null : g.outletId === null || g.outletId === o),
      );
      return { data: allowed, error: null };
    },
  };
}

describe("assertCanManageRbacRole", () => {
  it("denies a tenant-A-scoped admin from writing a role grant in tenant B", async () => {
    const sb = makeFakeSb([{ tenantId: "tenant-a", propertyId: null, outletId: null }]);
    await expect(
      assertCanManageRbacRole(sb, { tenantId: "tenant-b", propertyId: null, outletId: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("denies a tenant-scoped admin from writing a platform-wide (tenant-null) role grant", async () => {
    const sb = makeFakeSb([{ tenantId: "tenant-a", propertyId: null, outletId: null }]);
    await expect(
      assertCanManageRbacRole(sb, { tenantId: null, propertyId: null, outletId: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allows a tenant-scoped admin to write within their own tenant", async () => {
    const sb = makeFakeSb([{ tenantId: "tenant-a", propertyId: null, outletId: null }]);
    await expect(
      assertCanManageRbacRole(sb, { tenantId: "tenant-a", propertyId: "prop-1", outletId: null }),
    ).resolves.toBeUndefined();
  });

  it("allows a platform-wide admin to write any tenant/property/outlet", async () => {
    const sb = makeFakeSb([{ tenantId: null, propertyId: null, outletId: null }]);
    await expect(
      assertCanManageRbacRole(sb, {
        tenantId: "tenant-b",
        propertyId: "prop-9",
        outletId: "outlet-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("denies a property-scoped admin from writing a grant at a different property", async () => {
    const sb = makeFakeSb([{ tenantId: "tenant-a", propertyId: "prop-1", outletId: null }]);
    await expect(
      assertCanManageRbacRole(sb, { tenantId: "tenant-a", propertyId: "prop-2", outletId: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      assertCanManageRbacRole(sb, { tenantId: "tenant-a", propertyId: "prop-1", outletId: null }),
    ).resolves.toBeUndefined();
  });
});

/**
 * ME-16 remediation (ME16-05) — requirePermission's server middleware
 * previously let a permission denial pass through with zero server-side
 * trace. These reproduce a denial and an allow directly against
 * `.options.server`, same pattern used for the other middleware factories
 * in this repo's ME-16 tests (auth-middleware.test.ts,
 * server-fn-correlation.test.ts).
 */
describe("requirePermission denial logging", () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeSbWithPermission(allowed: boolean) {
    return {
      async rpc() {
        return { data: allowed, error: null };
      },
    };
  }

  it("logs a forbidden denial (permission, userId, requestId) and rethrows ForbiddenError", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const middleware = requirePermission("INVENTORY:WRITE" as never);
    const next = vi.fn();

    await expect(
      middleware.options.server!({
        next,
        context: {
          supabase: fakeSbWithPermission(false),
          userId: "user-42",
          requestId: "req-rbac-1",
        },
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(next).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = warnSpy.mock.calls[0]!;
    expect(tag).toBe("[rbac]");
    const parsed = JSON.parse(payload as string);
    expect(parsed).toMatchObject({
      requestId: "req-rbac-1",
      reason: "forbidden",
      permission: "INVENTORY:WRITE",
      userId: "user-42",
    });
  });

  it("logs nothing and calls next() when the permission is granted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const middleware = requirePermission("INVENTORY:WRITE" as never);
    const next = vi.fn(async (opts) => ({ context: opts.context }));

    await middleware.options.server!({
      next,
      context: { supabase: fakeSbWithPermission(true), userId: "user-42", requestId: "req-rbac-2" },
    } as never);

    expect(next).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
