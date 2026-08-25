/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * Exercises the REAL assertCapability -> restaurant_members path (not a
 * stub of the check itself) against a fake Supabase client, the same
 * philosophy used throughout this codebase for authorization-relevant
 * tests: prove the actual query chain rejects/accepts correctly.
 */
import { describe, expect, it } from "vitest";
import { removeMenuItemImage, uploadMenuItemImage } from "./menu-image.server";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ITEM_ID = "44444444-4444-4444-4444-444444444444";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function makeFakeSupabase(opts: {
  members: Array<{ tenant_id: string; user_id: string; role: string }>;
  menuItem: { id: string; image_url: string | null } | null;
  uploadShouldFail?: boolean;
  updateShouldFail?: boolean;
}) {
  const storageCalls: Array<{
    op: "upload" | "remove" | "getPublicUrl";
    path?: string;
    paths?: string[];
  }> = [];
  const dbUpdates: Array<Record<string, unknown>> = [];
  let currentItem = opts.menuItem;

  function tableBuilder(table: string) {
    const filters: Record<string, unknown> = {};
    let op: "select" | "update" = "select";
    let patch: any;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      update: (p: any) => {
        op = "update";
        patch = p;
        return api;
      },
      maybeSingle: () => resolve(),
      then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
    };

    async function resolve() {
      if (op === "select") {
        if (table === "restaurant_members") {
          const rows = opts.members.filter(
            (m) => m.tenant_id === filters.tenant_id && m.user_id === filters.user_id,
          );
          return { data: rows, error: null };
        }
        if (table === "restaurant_menu_items") {
          const match =
            currentItem && currentItem.id === filters.id && filters.tenant_id === TENANT_A
              ? currentItem
              : null;
          return { data: match, error: null };
        }
        return { data: null, error: null };
      }
      // update
      if (table === "restaurant_menu_items") {
        if (opts.updateShouldFail) return { data: null, error: { message: "db write failed" } };
        dbUpdates.push(patch);
        if (currentItem) currentItem = { ...currentItem, ...patch, id: currentItem.id };
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }

    return api;
  }

  const storage = {
    from: (_bucket: string) => ({
      upload: async (path: string, _buf: Buffer, _opts: unknown) => {
        storageCalls.push({ op: "upload", path });
        if (opts.uploadShouldFail) return { error: { message: "storage upload failed" } };
        return { error: null };
      },
      getPublicUrl: (path: string) => {
        storageCalls.push({ op: "getPublicUrl", path });
        return {
          data: {
            publicUrl: `https://cdn.example.test/storage/v1/object/public/restaurant-menu-images/${path}`,
          },
        };
      },
      remove: async (paths: string[]) => {
        storageCalls.push({ op: "remove", paths });
        return { error: null };
      },
    }),
  };

  return {
    supabase: {
      from: (table: string) => tableBuilder(table),
      storage,
      rpc: async () => ({ data: false, error: null }), // never a platform admin
    },
    storageCalls,
    dbUpdates,
    getCurrentItem: () => currentItem,
  };
}

describe("uploadMenuItemImage", () => {
  it("uploads, updates image_url, and removes the previous object", async () => {
    const { supabase, storageCalls, dbUpdates } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "chef" }],
      menuItem: {
        id: ITEM_ID,
        image_url:
          "https://cdn.example.test/storage/v1/object/public/restaurant-menu-images/old/path.jpg",
      },
    });

    const result = await uploadMenuItemImage(supabase, USER, {
      tenantId: TENANT_A,
      menuItemId: ITEM_ID,
      mimeType: "image/png",
      fileBase64: TINY_PNG_BASE64,
    });

    expect(result.imageUrl).toContain("restaurant-menu-images");
    expect(dbUpdates).toHaveLength(1);
    expect(dbUpdates[0]!.image_url).toBe(result.imageUrl);
    expect(storageCalls.filter((c) => c.op === "upload")).toHaveLength(1);
    expect(storageCalls.some((c) => c.op === "remove" && c.paths?.[0] === "old/path.jpg")).toBe(
      true,
    );
  });

  it("rejects a caller who is not a restaurant_members of the tenant", async () => {
    const { supabase, storageCalls, dbUpdates } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_B, user_id: USER, role: "chef" }], // wrong tenant
      menuItem: { id: ITEM_ID, image_url: null },
    });

    await expect(
      uploadMenuItemImage(supabase, USER, {
        tenantId: TENANT_A,
        menuItemId: ITEM_ID,
        mimeType: "image/png",
        fileBase64: TINY_PNG_BASE64,
      }),
    ).rejects.toThrow(/Forbidden/i);

    expect(storageCalls).toHaveLength(0);
    expect(dbUpdates).toHaveLength(0);
  });

  it("rejects a caller with tenant membership but the wrong role for menu.manage", async () => {
    const { supabase, storageCalls } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "cashier" }], // right tenant, no menu.manage
      menuItem: { id: ITEM_ID, image_url: null },
    });

    await expect(
      uploadMenuItemImage(supabase, USER, {
        tenantId: TENANT_A,
        menuItemId: ITEM_ID,
        mimeType: "image/png",
        fileBase64: TINY_PNG_BASE64,
      }),
    ).rejects.toThrow(/Forbidden/i);

    expect(storageCalls).toHaveLength(0);
  });

  it("rejects a menu item that does not belong to the caller's tenant", async () => {
    const { supabase, storageCalls } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "owner" }],
      menuItem: null, // no row matches tenant_id = TENANT_A for this item
    });

    await expect(
      uploadMenuItemImage(supabase, USER, {
        tenantId: TENANT_A,
        menuItemId: ITEM_ID,
        mimeType: "image/png",
        fileBase64: TINY_PNG_BASE64,
      }),
    ).rejects.toThrow(/not found/i);

    expect(storageCalls).toHaveLength(0);
  });

  it("does not touch image_url when the storage upload itself fails", async () => {
    const original =
      "https://cdn.example.test/storage/v1/object/public/restaurant-menu-images/old/path.jpg";
    const { supabase, dbUpdates, getCurrentItem } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "owner" }],
      menuItem: { id: ITEM_ID, image_url: original },
      uploadShouldFail: true,
    });

    await expect(
      uploadMenuItemImage(supabase, USER, {
        tenantId: TENANT_A,
        menuItemId: ITEM_ID,
        mimeType: "image/png",
        fileBase64: TINY_PNG_BASE64,
      }),
    ).rejects.toThrow(/storage upload failed/i);

    expect(dbUpdates).toHaveLength(0);
    expect(getCurrentItem()?.image_url).toBe(original);
  });

  it("removes the orphaned object when the DB write fails after a successful upload", async () => {
    const original =
      "https://cdn.example.test/storage/v1/object/public/restaurant-menu-images/old/path.jpg";
    const { supabase, storageCalls, getCurrentItem } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "owner" }],
      menuItem: { id: ITEM_ID, image_url: original },
      updateShouldFail: true,
    });

    await expect(
      uploadMenuItemImage(supabase, USER, {
        tenantId: TENANT_A,
        menuItemId: ITEM_ID,
        mimeType: "image/png",
        fileBase64: TINY_PNG_BASE64,
      }),
    ).rejects.toThrow(/db write failed/i);

    // The existing reference must be untouched, and the just-uploaded
    // object must be cleaned up rather than left orphaned.
    expect(getCurrentItem()?.image_url).toBe(original);
    const uploaded = storageCalls.find((c) => c.op === "upload")!;
    expect(storageCalls.some((c) => c.op === "remove" && c.paths?.[0] === uploaded.path)).toBe(
      true,
    );
  });

  it("rejects a file over the size limit before ever touching storage", async () => {
    const { supabase, storageCalls } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "owner" }],
      menuItem: { id: ITEM_ID, image_url: null },
    });

    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64");

    await expect(
      uploadMenuItemImage(supabase, USER, {
        tenantId: TENANT_A,
        menuItemId: ITEM_ID,
        mimeType: "image/png",
        fileBase64: oversized,
      }),
    ).rejects.toThrow(/too large/i);

    expect(storageCalls).toHaveLength(0);
  });
});

describe("removeMenuItemImage", () => {
  it("clears image_url and removes the storage object", async () => {
    const original =
      "https://cdn.example.test/storage/v1/object/public/restaurant-menu-images/old/path.jpg";
    const { supabase, storageCalls, getCurrentItem } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "owner" }],
      menuItem: { id: ITEM_ID, image_url: original },
    });

    const result = await removeMenuItemImage(supabase, USER, {
      tenantId: TENANT_A,
      menuItemId: ITEM_ID,
    });

    expect(result.imageUrl).toBeNull();
    expect(getCurrentItem()?.image_url).toBeNull();
    expect(storageCalls.some((c) => c.op === "remove" && c.paths?.[0] === "old/path.jpg")).toBe(
      true,
    );
  });

  it("rejects a caller who is not a member of the tenant", async () => {
    const { supabase, storageCalls } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_B, user_id: USER, role: "owner" }],
      menuItem: { id: ITEM_ID, image_url: "https://x/y" },
    });

    await expect(
      removeMenuItemImage(supabase, USER, { tenantId: TENANT_A, menuItemId: ITEM_ID }),
    ).rejects.toThrow(/Forbidden/i);

    expect(storageCalls).toHaveLength(0);
  });

  it("is a no-op when the item already has no image", async () => {
    const { supabase, storageCalls } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "owner" }],
      menuItem: { id: ITEM_ID, image_url: null },
    });

    const result = await removeMenuItemImage(supabase, USER, {
      tenantId: TENANT_A,
      menuItemId: ITEM_ID,
    });
    expect(result.imageUrl).toBeNull();
    expect(storageCalls).toHaveLength(0);
  });
});
