/**
 * RBAC enforcement tests.
 *
 * Two things must hold for authorization to mean anything:
 *   1. the matrix in code and the matrix seeded into SQL are the same matrix;
 *   2. the server guard refuses when the database says no — regardless of
 *      what the UI decided to render.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_PERMISSIONS,
  PERMISSION_DOMAINS,
  ROLES,
  ROLE_PERMISSIONS,
  permissionsForRoles,
  rolesHavePermission,
  type Permission,
  type Role,
} from "./permissions";
import { ForbiddenError, assertPermission, hasPermission, listPermissions } from "./rbac.server";

const MIGRATION = join(process.cwd(), "standalone/db/migrations/0003_tenancy_rbac.sql");

function seededMatrix(): Map<string, Set<string>> {
  const sql = readFileSync(MIGRATION, "utf8");
  const out = new Map<string, Set<string>>();
  for (const m of sql.matchAll(/\('([A-Z_]+)',\s*'([A-Z]+:[A-Z]+)'\)/g)) {
    const [, role, perm] = m;
    if (!out.has(role!)) out.set(role!, new Set());
    out.get(role!)!.add(perm!);
  }
  return out;
}

function fakeSupabase(rpc: (fn: string, args: Record<string, unknown>) => unknown) {
  return { rpc: async (fn: string, args: Record<string, unknown>) => ({ data: rpc(fn, args), error: null }) };
}

describe("permission catalogue", () => {
  it("declares every domain × action pair exactly once", () => {
    expect(ALL_PERMISSIONS.length).toBe(PERMISSION_DOMAINS.length * 4);
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it("gives OWNER everything and no one else ADMINISTRATION:ADMIN", () => {
    expect(ROLE_PERMISSIONS.OWNER).toEqual(ALL_PERMISSIONS);
    const others = ROLES.filter((r) => r !== "OWNER");
    for (const r of others) {
      expect(rolesHavePermission([r], "ADMINISTRATION:ADMIN")).toBe(false);
    }
  });

  it("keeps AUDITOR strictly read-only", () => {
    for (const p of ROLE_PERMISSIONS.AUDITOR) expect(p.endsWith(":READ")).toBe(true);
  });

  it("never grants a permission outside the declared catalogue", () => {
    const known = new Set<Permission>(ALL_PERMISSIONS);
    for (const role of ROLES) for (const p of ROLE_PERMISSIONS[role]) expect(known.has(p)).toBe(true);
  });

  it("unions permissions across multiple roles", () => {
    const both = permissionsForRoles(["WAITER", "STOREKEEPER"]);
    expect(both.has("POS:WRITE")).toBe(true);
    expect(both.has("INVENTORY:ADMIN")).toBe(true);
    expect(both.has("FINANCE:WRITE")).toBe(false);
  });

  it("does not let service roles approve their own spend", () => {
    expect(rolesHavePermission(["WAITER"], "PROCUREMENT:APPROVE")).toBe(false);
    expect(rolesHavePermission(["BARTENDER"], "PROCUREMENT:APPROVE")).toBe(false);
    expect(rolesHavePermission(["STOREKEEPER"], "PROCUREMENT:APPROVE")).toBe(false);
    expect(rolesHavePermission(["FINANCE"], "PROCUREMENT:APPROVE")).toBe(true);
  });
});

describe("code ↔ SQL parity", () => {
  const seeded = seededMatrix();

  it("seeds every declared role", () => {
    for (const role of ROLES) expect(seeded.has(role), `${role} missing from migration`).toBe(true);
  });

  it("seeds exactly the declared permissions for each role", () => {
    for (const role of ROLES) {
      const inSql = Array.from(seeded.get(role) ?? []).sort();
      const inCode = [...ROLE_PERMISSIONS[role as Role]].sort();
      expect(inSql, `role ${role} drifted`).toEqual(inCode);
    }
  });
});

describe("server-side guard", () => {
  it("passes the caller, permission and scope to the database", async () => {
    const seen: Record<string, unknown>[] = [];
    const sb = fakeSupabase((fn, args) => {
      expect(fn).toBe("nova_has_permission");
      seen.push(args);
      return true;
    });
    await assertPermission(sb, "user-1", "INVENTORY:WRITE", { tenantId: "t1", outletId: "o1" });
    expect(seen[0]).toEqual({
      _user_id: "user-1",
      _permission: "INVENTORY:WRITE",
      _tenant_id: "t1",
      _property_id: null,
      _outlet_id: "o1",
    });
  });

  it("throws ForbiddenError when the database refuses", async () => {
    const sb = fakeSupabase(() => false);
    await expect(assertPermission(sb, "user-1", "FINANCE:APPROVE")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("treats a non-true answer as a refusal, never as a pass", async () => {
    for (const answer of [null, undefined, 0, "", "true"]) {
      const sb = fakeSupabase(() => answer);
      await expect(hasPermission(sb, "u", "POS:WRITE")).resolves.toBe(false);
    }
  });

  it("surfaces database errors instead of failing open", async () => {
    const sb = { rpc: async () => ({ data: null, error: { message: "connection lost" } }) };
    await expect(hasPermission(sb, "u", "POS:WRITE")).rejects.toThrow("connection lost");
    await expect(assertPermission(sb, "u", "POS:WRITE")).rejects.toThrow("connection lost");
  });

  it("reads the caller's effective permissions from the database, not the client", async () => {
    const sb = fakeSupabase((fn) => {
      expect(fn).toBe("nova_permissions_for");
      return [{ permission: "POS:READ" }, { permission: "POS:WRITE" }];
    });
    await expect(listPermissions(sb, "user-1")).resolves.toEqual(["POS:READ", "POS:WRITE"]);
  });
});
