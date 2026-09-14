/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P09 enterprise closure — Import Studio workspace-management authorization.
 *
 * Every workspace-orchestration function in import.server.ts
 * (createImportWorkspace, uploadImportSource, parseImportSource,
 * confirmImportMapping, decideStagedRecord, bulkDecideStagedRecords,
 * commitImportWorkspace) called `assertCapability(sb, userId, tenantId,
 * "import.manage")` with NO property scope, despite
 * restaurant_import_workspaces having a real property_id/location_id the
 * caller controls — the same escalation class already fixed for
 * restaurant_members (0057/0058) and configuration governance (0061/0062).
 * A property-scoped restaurant_manager/GM/owner could drive an entire
 * import workspace — upload a source, parse it, confirm a mapping, approve
 * staged rows, commit — against a SIBLING property's workspace, using only
 * their own property's grant. Fix: resolve the workspace's own scope (or,
 * for source/staged-record-keyed calls, the workspace reached via the
 * source/record's own workspace_id) before checking capability.
 *
 * Unlike import.server.test.ts, this file does NOT mock
 * "../core/access.server" — the real assertCapability/property-scope logic
 * must actually run for these tests to mean anything. It also never
 * exercises commitImportWorkspace's approved-record commit loop (every
 * workspace here has zero approved staged records), so the real
 * suppliers/inventory/menu/products/costing service modules never need to
 * be mocked — the authorization boundary this file tests is reached before
 * any of them would be called.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));

import {
  bulkDecideStagedRecords,
  commitImportWorkspace,
  confirmImportMapping,
  createImportWorkspace,
  decideStagedRecord,
  parseImportSource,
  uploadImportSource,
} from "./import.server";

const TENANT_A = "tenant-a";
const PROPERTY_A1 = "property-a1";
const PROPERTY_A2 = "property-a2";

const USER_RM_A1 = "rm-a1"; // restaurant_manager scoped to Property A1 only
const USER_OWNER_TENANT_WIDE = "owner-tenant-wide"; // owner, tenant-wide

type Row = Record<string, any>;

function makeFakeSupabase() {
  const db: Record<string, Row[]> = {
    restaurant_members: [
      {
        tenant_id: TENANT_A,
        user_id: USER_RM_A1,
        role: "restaurant_manager",
        property_id: PROPERTY_A1,
      },
      {
        tenant_id: TENANT_A,
        user_id: USER_OWNER_TENANT_WIDE,
        role: "owner",
        property_id: null,
      },
    ],
    restaurant_import_workspaces: [
      {
        id: "ws-a1",
        tenant_id: TENANT_A,
        property_id: PROPERTY_A1,
        location_id: null,
        workspace_number: "IMP-A1",
        status: "open",
      },
      {
        id: "ws-a2",
        tenant_id: TENANT_A,
        property_id: PROPERTY_A2,
        location_id: null,
        workspace_number: "IMP-A2",
        status: "open",
      },
    ],
    restaurant_import_sources: [
      {
        id: "src-a1",
        tenant_id: TENANT_A,
        workspace_id: "ws-a1",
        kind: "csv",
        status: "uploaded",
        raw_text: "Name\nWidget\n",
        storage_path: null,
      },
      {
        id: "src-a2",
        tenant_id: TENANT_A,
        workspace_id: "ws-a2",
        kind: "csv",
        status: "uploaded",
        raw_text: "Name\nWidget\n",
        storage_path: null,
      },
    ],
    restaurant_import_field_mappings: [],
    restaurant_import_staged_records: [
      {
        id: "rec-a1",
        tenant_id: TENANT_A,
        workspace_id: "ws-a1",
        source_id: "src-a1",
        domain: "inventory_item",
        decision: "pending",
        committed_at: null,
        mapped_data: {},
        matched_entity_table: null,
      },
      {
        id: "rec-a2",
        tenant_id: TENANT_A,
        workspace_id: "ws-a2",
        source_id: "src-a2",
        domain: "inventory_item",
        decision: "pending",
        committed_at: null,
        mapped_data: {},
        matched_entity_table: null,
      },
    ],
    restaurant_properties: [],
    restaurant_inventory_units: [],
  };
  let seq = 0;

  function matchesOrClause(row: Row, clause: string): boolean {
    return clause.split(",").some((part) => {
      const [col, op, val] = part.split(".");
      if (op === "is" && val === "null") return row[col!] === null || row[col!] === undefined;
      if (op === "eq") return String(row[col!]) === val;
      return false;
    });
  }

  function builder(table: string) {
    db[table] = db[table] ?? [];
    const rows = () => db[table]!;
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" | "upsert" = "select";
    let payload: any = null;
    let onConflict: string | undefined;

    const api: any = {
      select: () => api,
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return api;
      },
      or(clause: string) {
        filters.push((r) => matchesOrClause(r, clause));
        return api;
      },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return api;
      },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      order: () => api,
      limit: () => api,
      insert(p: any) {
        mode = "insert";
        payload = p;
        return api;
      },
      update(p: any) {
        mode = "update";
        payload = p;
        return api;
      },
      upsert(p: any, opts?: { onConflict?: string }) {
        mode = "upsert";
        payload = p;
        onConflict = opts?.onConflict;
        return api;
      },
      async maybeSingle() {
        const r = await run();
        return { data: (r.data as any[])[0] ?? null, error: r.error };
      },
      async single() {
        const r = await run();
        const d = (r.data as any[])[0];
        return d ? { data: d, error: null } : { data: null, error: { message: `${table}: not found` } };
      },
      then(resolve: any, reject: any) {
        return run().then(resolve, reject);
      },
    };

    async function run() {
      if (mode === "select") {
        return { data: rows().filter((r) => filters.every((f) => f(r))), error: null };
      }
      if (mode === "insert") {
        const items = Array.isArray(payload) ? payload : [payload];
        const created = items.map((p) => ({ id: p.id ?? `${table}-new-${++seq}`, ...p }));
        db[table]!.push(...created);
        return { data: created, error: null };
      }
      if (mode === "update") {
        const matched = rows().filter((r) => filters.every((f) => f(r)));
        matched.forEach((r) => Object.assign(r, payload));
        return { data: matched, error: null };
      }
      const keys = (onConflict ?? "id").split(",");
      const existing = rows().find((r) => keys.every((k) => r[k] === payload[k]));
      if (existing) Object.assign(existing, payload);
      else db[table]!.push({ id: payload.id ?? `${table}-new-${++seq}`, ...payload });
      return { data: [existing ?? payload], error: null };
    }

    return api;
  }

  return {
    from: (t: string) => builder(t),
    rpc: async (fn: string) => {
      if (fn === "restaurant_next_document_number") return { data: `IMP-${++seq}`, error: null };
      if (fn === "has_any_role") return { data: false, error: null };
      return { data: null, error: null };
    },
  } as any;
}

describe("createImportWorkspace — property-scope escalation is blocked", () => {
  it("a restaurant_manager scoped to Property A1 CAN create a workspace at their own property", async () => {
    const sb = makeFakeSupabase();
    const ws = await createImportWorkspace(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A1,
      name: "New workspace",
    } as any);
    expect(ws).toBeTruthy();
  });

  it("a restaurant_manager scoped to Property A1 CANNOT create a workspace at sibling Property A2", async () => {
    const sb = makeFakeSupabase();
    await expect(
      createImportWorkspace(sb, USER_RM_A1, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        name: "Sibling workspace",
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a tenant-wide owner CAN create a workspace at any property", async () => {
    const sb = makeFakeSupabase();
    const ws = await createImportWorkspace(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A2,
      name: "Owner workspace",
    } as any);
    expect(ws).toBeTruthy();
  });
});

describe("uploadImportSource — scope is inherited from the workspace", () => {
  it("a restaurant_manager scoped to Property A1 CAN upload a source to ws-a1 (their own property)", async () => {
    const sb = makeFakeSupabase();
    const source = await uploadImportSource(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      workspaceId: "ws-a1",
      kind: "csv",
      text: "Name\nWidget\n",
    } as any);
    expect(source).toBeTruthy();
  });

  it("a restaurant_manager scoped to Property A1 CANNOT upload a source to ws-a2 (sibling property) — the core escalation this closes", async () => {
    const sb = makeFakeSupabase();
    await expect(
      uploadImportSource(sb, USER_RM_A1, {
        tenantId: TENANT_A,
        workspaceId: "ws-a2",
        kind: "csv",
        text: "Name\nWidget\n",
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a tenant-wide owner CAN upload a source to any property's workspace", async () => {
    const sb = makeFakeSupabase();
    const source = await uploadImportSource(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      workspaceId: "ws-a2",
      kind: "csv",
      text: "Name\nWidget\n",
    } as any);
    expect(source).toBeTruthy();
  });
});

describe("parseImportSource — scope is inherited via the source's own workspace_id", () => {
  it("a restaurant_manager scoped to Property A1 CANNOT parse a source under ws-a2 (sibling property)", async () => {
    const sb = makeFakeSupabase();
    await expect(
      parseImportSource(sb, USER_RM_A1, { tenantId: TENANT_A, sourceId: "src-a2" }),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a restaurant_manager scoped to Property A1 CAN parse a source under ws-a1 (their own property)", async () => {
    const sb = makeFakeSupabase();
    const result = await parseImportSource(sb, USER_RM_A1, { tenantId: TENANT_A, sourceId: "src-a1" });
    expect(result.source).toBeTruthy();
  });
});

describe("confirmImportMapping — scope is inherited via the source's own workspace_id", () => {
  it("a restaurant_manager scoped to Property A1 CANNOT confirm a mapping for a source under ws-a2 (sibling property)", async () => {
    const sb = makeFakeSupabase();
    await expect(
      confirmImportMapping(sb, USER_RM_A1, {
        tenantId: TENANT_A,
        sourceId: "src-a2",
        sheetName: "Sheet1",
        domain: "inventory_item",
        mapping: [{ sourceColumn: "Name", canonicalField: "name", confidence: 1, auto: true }],
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a restaurant_manager scoped to Property A1 CAN confirm a mapping for a source under ws-a1 (their own property)", async () => {
    const sb = makeFakeSupabase();
    const result = await confirmImportMapping(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      sourceId: "src-a1",
      sheetName: "Sheet1",
      domain: "inventory_item",
      mapping: [{ sourceColumn: "Name", canonicalField: "name", confidence: 1, auto: true }],
    } as any);
    expect(result.total).toBe(1);
  });
});

describe("decideStagedRecord — scope is inherited via the staged record's own workspace_id", () => {
  it("a restaurant_manager scoped to Property A1 CANNOT decide a staged record under ws-a2 (sibling property)", async () => {
    const sb = makeFakeSupabase();
    await expect(
      decideStagedRecord(sb, USER_RM_A1, {
        tenantId: TENANT_A,
        recordId: "rec-a2",
        decision: "approved",
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a restaurant_manager scoped to Property A1 CAN decide a staged record under ws-a1 (their own property)", async () => {
    const sb = makeFakeSupabase();
    const result = await decideStagedRecord(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      recordId: "rec-a1",
      decision: "approved",
    } as any);
    expect(result.decision).toBe("approved");
  });
});

describe("bulkDecideStagedRecords — scope is inherited from the workspace", () => {
  it("a restaurant_manager scoped to Property A1 CANNOT bulk-decide staged records for ws-a2 (sibling property)", async () => {
    const sb = makeFakeSupabase();
    await expect(
      bulkDecideStagedRecords(sb, USER_RM_A1, {
        tenantId: TENANT_A,
        workspaceId: "ws-a2",
        decision: "approved",
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a restaurant_manager scoped to Property A1 CAN bulk-decide staged records for ws-a1 (their own property)", async () => {
    const sb = makeFakeSupabase();
    const result = await bulkDecideStagedRecords(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      workspaceId: "ws-a1",
      decision: "approved",
    } as any);
    expect(result.updated).toBe(1);
  });
});

describe("commitImportWorkspace — scope is checked before any commit work begins", () => {
  it("a restaurant_manager scoped to Property A1 CANNOT commit ws-a2 (sibling property)", async () => {
    const sb = makeFakeSupabase();
    await expect(
      commitImportWorkspace(sb, USER_RM_A1, { tenantId: TENANT_A, workspaceId: "ws-a2" } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
    // Denied before any mutation — the workspace's status was never flipped
    // to "committing" (the very first write commitImportWorkspace performs
    // once authorization passes).
    const { data: ws } = await sb
      .from("restaurant_import_workspaces")
      .select("status")
      .eq("id", "ws-a2")
      .maybeSingle();
    expect(ws.status).toBe("open");
  });

  it("a restaurant_manager scoped to Property A1 CAN commit ws-a1 (their own property)", async () => {
    const sb = makeFakeSupabase();
    const result = await commitImportWorkspace(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      workspaceId: "ws-a1",
    } as any);
    expect(result.failed).toBe(0);
  });

  it("a tenant-wide owner CAN commit any property's workspace", async () => {
    const sb = makeFakeSupabase();
    const result = await commitImportWorkspace(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      workspaceId: "ws-a2",
    } as any);
    expect(result.failed).toBe(0);
  });
});
