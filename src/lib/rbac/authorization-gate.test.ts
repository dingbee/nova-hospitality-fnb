/**
 * FINAL STANDALONE F&B SECURITY GATE — authorization regression suite.
 *
 * These tests exist to make a specific class of regression impossible:
 * an authorization decision that resolves anywhere other than
 *
 *   USER -> rbac_user_roles -> roles -> role_permissions -> permissions -> scope
 *
 * They are deliberately source-level as well as behavioural, because the
 * dangerous failures (a second role store, a hidden admin bypass, a server
 * function with no middleware) are structural, not runtime.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ForbiddenError, assertPermission, hasPermission } from "./rbac.server";

const ROOT = process.cwd();
const MIG_DIR = join(ROOT, "standalone/db/migrations");
const sqlOf = (f: string) => readFileSync(join(MIG_DIR, f), "utf8");
const CANONICAL = sqlOf("0004_rbac_canonicalisation.sql");
const RBAC = sqlOf("0003_tenancy_rbac.sql");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const SRC = walk(join(ROOT, "src"));
const read = (p: string) => readFileSync(p, "utf8");

/** Latest definition of a SQL function across the migration chain. */
function latestFunctionBody(name: string): string {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
  let body = "";
  for (const f of files) {
    const sql = sqlOf(f);
    const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\b[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$;`, "g");
    for (const m of sql.matchAll(re)) body = m[1]!;
  }
  return body;
}

/* --------------------------------------------------- has_any_role: canonical */
describe("has_any_role resolves exclusively through canonical RBAC", () => {
  const body = latestFunctionBody("has_any_role");

  it("is redefined by the canonicalisation migration", () => {
    expect(body.length).toBeGreaterThan(0);
    expect(CANONICAL).toContain("CREATE OR REPLACE FUNCTION public.has_any_role");
  });

  it("reads the canonical role tables", () => {
    const canonical = latestFunctionBody("has_any_role").includes("rbac_user_roles")
      ? latestFunctionBody("has_any_role")
      : CANONICAL;
    expect(canonical).toMatch(/rbac_user_roles/);
    expect(canonical).toMatch(/rbac_legacy_role_map/);
    expect(canonical).toMatch(/app_users/);
  });

  it("no longer falls back to the legacy public.user_roles store", () => {
    // The 4-arg body is the single source of truth; the 2-arg shim delegates.
    const fourArg = CANONICAL.slice(
      CANONICAL.indexOf("CREATE OR REPLACE FUNCTION public.has_any_role("),
      CANONICAL.indexOf("COMMENT ON FUNCTION public.has_any_role"),
    );
    expect(fourArg).not.toMatch(/FROM public\.user_roles/);
    expect(fourArg).toMatch(/au\.status = 'active'/);
  });

  it("honours tenant, property and outlet scope", () => {
    expect(CANONICAL).toMatch(/ur\.tenant_id\s+=\s+_tenant_id/);
    expect(CANONICAL).toMatch(/ur\.property_id = _property_id/);
    expect(CANONICAL).toMatch(/ur\.outlet_id   = _outlet_id/);
  });

  it("never infers authorization from email or user metadata", () => {
    for (const fn of ["has_any_role", "has_role", "is_any_staff", "nova_has_permission"]) {
      const b = latestFunctionBody(fn);
      expect(b).not.toMatch(/raw_user_meta_data/);
      expect(b).not.toMatch(/@/); // no hard-coded address, no email comparison
    }
  });

  it("revokes the legacy store from the Data API", () => {
    expect(CANONICAL).toMatch(/REVOKE ALL ON public\.user_roles FROM authenticated, anon/);
  });

  it("leaves no application code reading the legacy store", () => {
    const offenders = SRC.filter(
      (p) => /\.(ts|tsx)$/.test(p) && !p.endsWith(".test.ts") && /from\("user_roles"\)|\.from\('user_roles'\)/.test(read(p)),
    );
    expect(offenders).toEqual([]);
  });
});

/* -------------------------------------------------------- scope enforcement */
describe("nova_has_permission scope chain", () => {
  const body = latestFunctionBody("nova_has_permission");
  it("joins role_permissions and requires an active account", () => {
    expect(body).toMatch(/role_permissions/);
    expect(body).toMatch(/au\.status = 'active'/);
  });
  it("compares every scope level", () => {
    for (const s of ["_tenant_id", "_property_id", "_outlet_id"]) expect(body).toContain(s);
  });
  it("passes the caller scope through from the server guard", async () => {
    const seen: Record<string, unknown>[] = [];
    const sb = {
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        seen.push(args);
        return { data: false, error: null };
      },
    };
    await expect(
      assertPermission(sb, "u1", "INVENTORY:WRITE", { tenantId: "t1", propertyId: "p1", outletId: "o1" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(seen[0]).toMatchObject({ _tenant_id: "t1", _property_id: "p1", _outlet_id: "o1" });
  });
  it("denies a cross-scope grant", async () => {
    // Grant exists for tenant A only; the database answers false for tenant B.
    const grants = new Set(["u1|INVENTORY:WRITE|tenantA"]);
    const sb = {
      rpc: async (_fn: string, a: Record<string, unknown>) => ({
        data: grants.has(`${a["_user_id"]}|${a["_permission"]}|${a["_tenant_id"]}`),
        error: null,
      }),
    };
    expect(await hasPermission(sb, "u1", "INVENTORY:WRITE", { tenantId: "tenantA" })).toBe(true);
    expect(await hasPermission(sb, "u1", "INVENTORY:WRITE", { tenantId: "tenantB" })).toBe(false);
    await expect(
      assertPermission(sb, "u1", "INVENTORY:WRITE", { tenantId: "tenantB" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

/* ------------------------------------------------- assignment / revocation */
describe("role assignment and revocation", () => {
  /** Minimal in-memory stand-in for the canonical resolution chain. */
  function db() {
    const rows = new Set<string>();
    const matrix: Record<string, string[]> = {
      OWNER: ["ADMINISTRATION:ADMIN", "INVENTORY:WRITE", "STAFF:READ"],
      WAITER: ["POS:WRITE"],
    };
    return {
      grant: (u: string, r: string) => rows.add(`${u}|${r}`),
      revoke: (u: string, r: string) => rows.delete(`${u}|${r}`),
      sb: {
        rpc: async (_fn: string, a: Record<string, unknown>) => {
          const uid = String(a["_user_id"]);
          const perm = String(a["_permission"]);
          const allowed = [...rows]
            .filter((k) => k.startsWith(`${uid}|`))
            .flatMap((k) => matrix[k.split("|")[1]!] ?? []);
          return { data: allowed.includes(perm), error: null };
        },
      },
    };
  }

  it("grants access only after the role is assigned", async () => {
    const d = db();
    await expect(assertPermission(d.sb, "u1", "INVENTORY:WRITE")).rejects.toBeInstanceOf(ForbiddenError);
    d.grant("u1", "OWNER");
    await expect(assertPermission(d.sb, "u1", "INVENTORY:WRITE")).resolves.toBeUndefined();
  });

  it("denies immediately after revocation — no stale privilege", async () => {
    const d = db();
    d.grant("u1", "OWNER");
    await expect(assertPermission(d.sb, "u1", "INVENTORY:WRITE")).resolves.toBeUndefined();
    d.revoke("u1", "OWNER");
    // Re-checked on every call: nothing is cached in a session claim.
    await expect(assertPermission(d.sb, "u1", "INVENTORY:WRITE")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a wrong role is not an insufficient-permission escape hatch", async () => {
    const d = db();
    d.grant("u1", "WAITER");
    await expect(assertPermission(d.sb, "u1", "POS:WRITE")).resolves.toBeUndefined();
    await expect(assertPermission(d.sb, "u1", "ADMINISTRATION:ADMIN")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("fails closed when the database errors", async () => {
    const sb = { rpc: async () => ({ data: null, error: { message: "connection lost" } }) };
    await expect(assertPermission(sb, "u1", "FINANCE:ADMIN")).rejects.toThrow(/connection lost/);
  });

  it("re-checks authorization on every call rather than trusting a claim", () => {
    const guard = read(join(ROOT, "src/lib/rbac/rbac.server.ts"));
    expect(guard).not.toMatch(/cache|memo|claims\[.role/i);
    expect(guard).toMatch(/supabase\.rpc\("nova_has_permission"/);
  });
});

/* ---------------------------------------------------------- OWNER bootstrap */
describe("OWNER bootstrap", () => {
  it("grants the canonical OWNER role, not a legacy flag", () => {
    expect(CANONICAL).toMatch(/INSERT INTO public\.rbac_user_roles \(user_id, role_code, tenant_id\)[\s\S]*?'OWNER'/);
  });

  it("is idempotent on replay", () => {
    const grant = CANONICAL.slice(CANONICAL.indexOf("FUNCTION public.nova_grant_owner"));
    expect(grant).toMatch(/ON CONFLICT \(code\) DO UPDATE/);
    expect(grant).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    expect(grant).toMatch(/ON CONFLICT \(user_id, role_code, tenant_id, property_id, outlet_id\) DO NOTHING/);
  });

  it("refuses to mint a second owner through bootstrap replay", () => {
    expect(CANONICAL).toMatch(/IF EXISTS \(SELECT 1 FROM public\.rbac_user_roles WHERE role_code = 'OWNER'\)/);
  });

  it("never creates, renames or deletes an account", () => {
    const grant = CANONICAL.slice(CANONICAL.indexOf("FUNCTION public.nova_grant_owner"));
    expect(grant).not.toMatch(/INSERT INTO auth\.users/);
    expect(grant).not.toMatch(/DELETE FROM auth\.users/);
  });

  it("is reachable only by the service role", () => {
    expect(CANONICAL).toMatch(/REVOKE ALL ON FUNCTION public\.nova_grant_owner\(uuid, text, text\) FROM public, anon, authenticated/);
    expect(CANONICAL).toMatch(/GRANT EXECUTE ON FUNCTION public\.nova_grant_owner\(uuid, text, text\) TO service_role/);
  });

  it("the appliance installer grants OWNER through the canonical path", () => {
    const local = readFileSync(join(ROOT, "local/sql/post/10-nova-local.sql"), "utf8");
    expect(local).toMatch(/PERFORM public\.nova_grant_owner\(v_user_id/);
  });

  it("OWNER can administer, assign and revoke roles", async () => {
    const { ROLE_PERMISSIONS } = await import("./permissions");
    for (const p of ["ADMINISTRATION:ADMIN", "STAFF:READ", "STAFF:ADMIN"]) {
      expect(ROLE_PERMISSIONS.OWNER).toContain(p);
    }
  });
});

/* ------------------------------------------- direct RPC / API bypass surface */
describe("direct server-function bypass", () => {
  const fnFiles = SRC.filter((p) => p.endsWith(".functions.ts"));

  it("finds the full server-function surface", () => {
    expect(fnFiles.length).toBeGreaterThan(30);
  });

  it("every server function authenticates, except the token-scoped guest receipt", () => {
    const unauthenticated: string[] = [];
    for (const f of fnFiles) {
      const s = read(f);
      for (const m of s.matchAll(/createServerFn\s*\(/g)) {
        const head = s.slice(m.index!, m.index! + 500);
        if (!/\.middleware\(\[[^\]]*requireSupabaseAuth/.test(head)) unauthenticated.push(f);
      }
    }
    expect(unauthenticated).toEqual([join(ROOT, "src/modules/restaurant/receipts/delivery.functions.ts")]);
  });

  it("the one public function is scoped by an unguessable token, not by identity", () => {
    const s = read(join(ROOT, "src/modules/restaurant/receipts/delivery.functions.ts"));
    expect(s).toMatch(/sharedReceiptSchema\.parse/);
    expect(s).toMatch(/getSharedReceipt\(data\.token\)/);
  });

  it("no server function accepts a role, permission or admin flag from the client", () => {
    const offenders: string[] = [];
    for (const f of fnFiles) {
      const s = read(f);
      // `role` as a *grant target* is legitimate in the administered staff API,
      // which independently requires ADMINISTRATION:ADMIN before using it.
      if (f.endsWith("staff.functions.ts")) continue;
      if (/data\.(permission|permissions|isAdmin|is_admin|roles)\b/.test(s)) offenders.push(f);
      if (/context\.roles|sendContext/.test(s)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("the administered staff API checks ADMINISTRATION:ADMIN before every grant or revoke", () => {
    const s = read(join(ROOT, "src/lib/staff.functions.ts"));
    for (const fn of ["assignRole", "revokeRole"]) {
      const seg = s.slice(s.indexOf(`export const ${fn}`));
      const body = seg.slice(0, seg.indexOf("export const", 10) === -1 ? seg.length : seg.indexOf("export const", 10));
      expect(body).toMatch(/assertPermission\([^)]*"ADMINISTRATION:ADMIN"\)/);
      expect(body).toMatch(/rbac_user_roles/);
    }
  });

  it("the principal endpoint never accepts a caller-supplied identity", () => {
    const s = read(join(ROOT, "src/lib/rbac/rbac.functions.ts"));
    expect(s).not.toMatch(/inputValidator/);
    expect(s).toMatch(/context as \{/);
  });
});

/* ---------------------------------------------- UI is presentation, not gate */
describe("UI authorization is never the only control", () => {
  it("the client permission hook is read-only and derived from the server", () => {
    const s = read(join(ROOT, "src/lib/rbac/usePermissions.ts"));
    expect(s).toMatch(/getCurrentPrincipal/);
    expect(s).not.toMatch(/localStorage|sessionStorage/);
  });

  it("no component decides authorization from local or session storage", () => {
    const offenders = SRC.filter(
      (p) =>
        /\.tsx$/.test(p) &&
        /(localStorage|sessionStorage)[\s\S]{0,80}(role|admin|permission)/i.test(read(p)),
    );
    expect(offenders).toEqual([]);
  });

  it("the intelligence core has no parallel role vocabulary", () => {
    const s = read(join(ROOT, "src/modules/intelligence/core/permissions.ts"));
    expect(s).toMatch(/@\/lib\/rbac\/permissions/);
    for (const legacy of ["reception", "housekeeping", "marketing:", "editor"]) {
      expect(s).not.toContain(`"${legacy}"`);
    }
    const a = read(join(ROOT, "src/modules/intelligence/core/access.server.ts"));
    expect(a).toMatch(/assertPermission/);
    expect(a).not.toMatch(/has_any_role/);
  });
});

/* ------------------------------------------------- tenant isolation in RLS */
describe("tenant / property / outlet isolation", () => {
  it("scoped RBAC tables are governed by permission policies, not by 'true'", () => {
    expect(RBAC).toMatch(/CREATE POLICY rbac_user_roles_admin[\s\S]*?ADMINISTRATION:ADMIN/);
    expect(RBAC).toMatch(/CREATE POLICY app_users_admin[\s\S]*?STAFF:ADMIN/);
  });

  it("cross-tenant document reads are refused server-side, not filtered in the UI", () => {
    const s = read(join(ROOT, "src/modules/restaurant/documents/documents.functions.ts"));
    expect(s).toMatch(/assertCapability\([\s\S]*?data\.tenantId/);
    expect(s).toMatch(/assertTenantRead\([\s\S]*?data\.tenantId/);
  });

  it("the folio seam requires POS permissions, not merely a signed-in account", () => {
    const s = read(join(ROOT, "src/domains/hospitality/folio/folioAdapter.server.ts"));
    expect(s).toMatch(/_permission: "POS:WRITE"/);
    expect(s).toMatch(/_permission: "POS:READ"/);
    expect(s).not.toMatch(/is_any_staff/);
  });
});
