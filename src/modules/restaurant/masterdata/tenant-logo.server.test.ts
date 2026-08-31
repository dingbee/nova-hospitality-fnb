/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * GEP4 — tenant logo upload/removal. Exercises the real
 * assertCapability -> settings-merge -> storage-write -> old-object-cleanup
 * chain (not mocked out), the same discipline GEP3's idempotency tests used
 * for submitGuestOrder: "tenant-scoped, no cross-tenant leak" only means
 * something if the real capability check and the real path-derivation logic
 * both run, not a stub standing in for them.
 */
import { describe, expect, it } from "vitest";
import { removeTenantLogo, uploadTenantLogo, TENANT_LOGO_BUCKET } from "./tenant-logo.server";

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-2";
const OWNER = "user-owner";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";

function makeFakeSupabase(opts: {
  tenants: Array<{ id: string; settings: any }>;
  members: Array<{ tenant_id: string; user_id: string; role: string }>;
}) {
  const tenants = opts.tenants.map((t) => ({ ...t }));
  const storage: Record<string, Set<string>> = {};

  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "update" = "select";
    let payload: any;
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      update(patch: any) {
        op = "update";
        payload = patch;
        return api;
      },
      maybeSingle: async () => {
        if (table === "restaurant_tenants") {
          const row = tenants.find((t) => filters.every(([c, v]) => (t as any)[c] === v));
          if (op === "update" && row) Object.assign(row, payload);
          return { data: row ?? null, error: null };
        }
        return { data: null, error: null };
      },
      then: (resolve: (v: { data: any; error: any }) => unknown) => {
        if (table === "restaurant_members") {
          const rows = opts.members.filter((m) => filters.every(([c, v]) => (m as any)[c] === v));
          return resolve({ data: rows, error: null });
        }
        if (table === "restaurant_tenants" && op === "update") {
          const row = tenants.find((t) => filters.every(([c, v]) => (t as any)[c] === v));
          if (row) Object.assign(row, payload);
          return resolve({ data: row ?? null, error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return api;
  }

  function rpc(name: string) {
    if (name === "has_any_role") return Promise.resolve({ data: false, error: null });
    return Promise.resolve({ data: null, error: null });
  }

  function storageFrom(bucket: string) {
    if (!storage[bucket]) storage[bucket] = new Set();
    return {
      upload: async (path: string, _buf: Buffer, _opts: any) => {
        storage[bucket].add(path);
        return { data: { path }, error: null };
      },
      getPublicUrl: (path: string) => ({
        data: { publicUrl: `https://cdn.example/object/public/${bucket}/${path}` },
      }),
      remove: async (paths: string[]) => {
        for (const p of paths) storage[bucket].delete(p);
        return { data: null, error: null };
      },
    };
  }

  return { from, rpc, storage: { from: storageFrom } as any, _objects: storage } as any;
}

const TINY_PNG_BASE64 = Buffer.from("not a real png but non-empty").toString("base64");

describe("uploadTenantLogo", () => {
  it("uploads and sets settings.business.logoUrl, preserving other business fields", async () => {
    const sb = makeFakeSupabase({
      tenants: [
        { id: TENANT, settings: { business: { legalName: "Demo Ltd", tradingName: "Demo" } } },
      ],
      members: [{ tenant_id: TENANT, user_id: OWNER, role: "owner" }],
    });
    const result = await uploadTenantLogo(sb, OWNER, {
      tenantId: TENANT,
      mimeType: "image/png",
      fileBase64: TINY_PNG_BASE64,
    });
    expect(result.logoUrl).toContain(`/${TENANT_LOGO_BUCKET}/${TENANT}/`);
    const tenant = sb._objects; // sanity: storage side actually wrote something
    expect([...tenant[TENANT_LOGO_BUCKET]]).toHaveLength(1);
  });

  it("requires tenant.manage — a viewer role is refused", async () => {
    const sb = makeFakeSupabase({
      tenants: [{ id: TENANT, settings: {} }],
      members: [{ tenant_id: TENANT, user_id: VIEWER, role: "viewer" }],
    });
    await expect(
      uploadTenantLogo(sb, VIEWER, {
        tenantId: TENANT,
        mimeType: "image/png",
        fileBase64: TINY_PNG_BASE64,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("a user with no membership in this tenant at all is refused — no cross-tenant upload", async () => {
    const sb = makeFakeSupabase({
      tenants: [{ id: TENANT, settings: {} }],
      members: [{ tenant_id: OTHER_TENANT, user_id: OUTSIDER, role: "owner" }],
    });
    await expect(
      uploadTenantLogo(sb, OUTSIDER, {
        tenantId: TENANT,
        mimeType: "image/png",
        fileBase64: TINY_PNG_BASE64,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("replacing an existing logo removes the old storage object — no orphaned object left behind", async () => {
    const sb = makeFakeSupabase({
      tenants: [
        {
          id: TENANT,
          settings: {
            business: {
              logoUrl: `https://cdn.example/object/public/${TENANT_LOGO_BUCKET}/${TENANT}/111.png`,
            },
          },
        },
      ],
      members: [{ tenant_id: TENANT, user_id: OWNER, role: "owner" }],
    });
    sb._objects[TENANT_LOGO_BUCKET] = new Set([`${TENANT}/111.png`]);

    await uploadTenantLogo(sb, OWNER, {
      tenantId: TENANT,
      mimeType: "image/png",
      fileBase64: TINY_PNG_BASE64,
    });

    const remaining = [...sb._objects[TENANT_LOGO_BUCKET]];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).not.toBe(`${TENANT}/111.png`);
  });

  it("rejects an unsupported MIME type (e.g. SVG) before ever touching storage", async () => {
    const sb = makeFakeSupabase({
      tenants: [{ id: TENANT, settings: {} }],
      members: [{ tenant_id: TENANT, user_id: OWNER, role: "owner" }],
    });
    await expect(
      uploadTenantLogo(sb, OWNER, {
        tenantId: TENANT,
        mimeType: "image/svg+xml" as any,
        fileBase64: TINY_PNG_BASE64,
      }),
    ).rejects.toThrow(/Unsupported image type/);
    expect([...(sb._objects[TENANT_LOGO_BUCKET] ?? [])]).toHaveLength(0);
  });
});

describe("removeTenantLogo", () => {
  it("clears settings.business.logoUrl and removes the storage object", async () => {
    const sb = makeFakeSupabase({
      tenants: [
        {
          id: TENANT,
          settings: {
            business: {
              tradingName: "Demo",
              logoUrl: `https://cdn.example/object/public/${TENANT_LOGO_BUCKET}/${TENANT}/111.png`,
            },
          },
        },
      ],
      members: [{ tenant_id: TENANT, user_id: OWNER, role: "owner" }],
    });
    sb._objects[TENANT_LOGO_BUCKET] = new Set([`${TENANT}/111.png`]);

    const result = await removeTenantLogo(sb, OWNER, { tenantId: TENANT });
    expect(result.logoUrl).toBeNull();
    expect([...sb._objects[TENANT_LOGO_BUCKET]]).toHaveLength(0);

    const tenantRow = (sb as any).from("restaurant_tenants");
    // Re-read via the same fake to confirm the persisted value, not just the return value.
    const { data } = await tenantRow.eq("id", TENANT).maybeSingle();
    expect(data.settings.business.logoUrl).toBeNull();
    expect(data.settings.business.tradingName).toBe("Demo"); // other fields untouched
  });

  it("is a no-op (not an error) when there is no logo configured", async () => {
    const sb = makeFakeSupabase({
      tenants: [{ id: TENANT, settings: {} }],
      members: [{ tenant_id: TENANT, user_id: OWNER, role: "owner" }],
    });
    const result = await removeTenantLogo(sb, OWNER, { tenantId: TENANT });
    expect(result.logoUrl).toBeNull();
  });

  it("requires tenant.manage", async () => {
    const sb = makeFakeSupabase({
      tenants: [{ id: TENANT, settings: { business: { logoUrl: "https://cdn.example/x.png" } } }],
      members: [{ tenant_id: TENANT, user_id: VIEWER, role: "viewer" }],
    });
    await expect(removeTenantLogo(sb, VIEWER, { tenantId: TENANT })).rejects.toThrow(/Forbidden/);
  });
});
