/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * I15 "NOVA MEMORY & OPERATING AGENT" — memory.server.ts.
 *
 * Exercises the REAL remember/recall/forget/correct/rememberVerifiedOutcome
 * against a fake Supabase client that models intelligence_memory as a
 * plain in-memory table (select/eq/is/ilike/order/limit/insert/update),
 * following this codebase's own "thenable query builder" fake pattern
 * (see kitchen.server.test.ts). restaurant_members backs rolesInTenant,
 * exactly as the real RBAC guards read it.
 */
import { describe, expect, it } from "vitest";
import {
  correctRestaurantMemory,
  findRecentVerifiedOutcomes,
  forgetRestaurantMemory,
  recallRestaurantMemory,
  rememberRestaurantMemory,
  rememberVerifiedOutcome,
  submitRestaurantMemoryFeedback,
} from "./memory.server";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "99999999-9999-9999-9999-999999999999";
const OWNER = "owner-1";
const MANAGER = "manager-1";
const WAITER = "waiter-1"; // no managerial capability
const OTHER_STAFF = "staff-2";

interface Member {
  tenant_id: string;
  user_id: string;
  role: string;
}

function escapeForRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeFakeSupabase(opts: { members?: Member[]; memories?: any[]; feedback?: any[] }) {
  const members: Member[] = opts.members ?? [
    { tenant_id: TENANT_A, user_id: OWNER, role: "owner" },
  ];
  const memories: any[] = opts.memories ?? [];
  const feedback: any[] = opts.feedback ?? [];
  let seq = 0;

  function table(store: any[], name: string) {
    const filters: Array<(r: any) => boolean> = [];
    let orderSpec: { col: string; ascending: boolean } | null = null;
    let limitN: number | null = null;
    let op: "select" | "insert" | "update" = "select";
    let payload: any = null;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return api;
      },
      is: (col: string) => {
        filters.push((r) => r[col] == null);
        return api;
      },
      ilike: (col: string, pattern: string) => {
        const re = new RegExp(`^${pattern.split("%").map(escapeForRegex).join(".*")}$`, "i");
        filters.push((r) => re.test(r[col] ?? ""));
        return api;
      },
      order: (col: string, o?: { ascending?: boolean }) => {
        orderSpec = { col, ascending: o?.ascending ?? true };
        return api;
      },
      limit: (n: number) => {
        limitN = n;
        return api;
      },
      insert: (row: any) => {
        op = "insert";
        payload = row;
        return api;
      },
      update: (patch: any) => {
        op = "update";
        payload = patch;
        return api;
      },
      single: () => resolve(true),
      maybeSingle: () => resolve(true),
      then: (onFulfilled: any, onRejected: any) => resolve(false).then(onFulfilled, onRejected),
    };

    function matchRows() {
      return store.filter((r) => filters.every((f) => f(r)));
    }

    async function resolve(singleMode: boolean) {
      if (op === "insert") {
        seq += 1;
        const now = new Date().toISOString();
        const row = { id: `${name}-${seq}`, created_at: now, updated_at: now, ...payload };
        store.push(row);
        return { data: singleMode ? row : [row], error: null };
      }
      if (op === "update") {
        const rows = matchRows();
        const now = new Date().toISOString();
        rows.forEach((r) => Object.assign(r, payload, { updated_at: now }));
        return { data: singleMode ? (rows[0] ?? null) : rows, error: null };
      }
      let rows = matchRows();
      if (orderSpec) {
        const { col, ascending } = orderSpec;
        rows = [...rows].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return ascending ? cmp : -cmp;
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      if (singleMode) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    return api;
  }

  return {
    from: (name: string) => {
      if (name === "restaurant_members") return table(members, name);
      if (name === "intelligence_memory") return table(memories, name);
      if (name === "intelligence_feedback") return table(feedback, name);
      throw new Error(`Unexpected table in fake: ${name}`);
    },
    rpc: async () => ({ data: false, error: null }),
  };
}

describe("rememberRestaurantMemory — personal (scope: user)", () => {
  it("any tenant member can store their own explicit preference, accepted immediately", async () => {
    const sb = makeFakeSupabase({});
    const result = await rememberRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      scope: "user",
      memoryType: "preference",
      memoryKey: "receipt_format",
      memoryValue: "Prefers itemized receipts",
      source: "user_stated",
    });
    expect(result.updated).toBe(false);
    const recalled = await recallRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      limit: 10,
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0].status).toBe("accepted");
  });

  it("reinforces an existing personal memory in place rather than duplicating it", async () => {
    const sb = makeFakeSupabase({});
    const first = await rememberRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      scope: "user",
      memoryType: "preference",
      memoryKey: "receipt_format",
      memoryValue: "Prefers itemized receipts",
      source: "user_stated",
    });
    const second = await rememberRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      scope: "user",
      memoryType: "preference",
      memoryKey: "receipt_format",
      memoryValue: "Prefers summarized receipts",
      source: "user_stated",
    });
    expect(second.id).toBe(first.id);
    expect(second.updated).toBe(true);

    const recalled = await recallRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      scope: "user",
      limit: 10,
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0].memoryValue).toBe("Prefers summarized receipts");
    expect(recalled[0].confidence).toBe(1);
    expect(recalled[0].memoryTier).toBe("strategic");
  });

  it("clamps an inferred memory's confidence below 1 and tiers it 'learned', never 'strategic'", async () => {
    const sb = makeFakeSupabase({});
    await rememberRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      scope: "user",
      memoryType: "operational_note",
      memoryKey: "pattern_x",
      memoryValue: "Tends to order more beef on weekends",
      source: "inferred",
      confidence: 1,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const recalled = await recallRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      limit: 10,
    });
    expect(recalled[0].confidence).toBeLessThan(1);
    expect(recalled[0].memoryTier).toBe("learned");
  });
});

describe("rememberRestaurantMemory — tenant scope authority", () => {
  it("a managerial role can write tenant-level memory", async () => {
    const sb = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: MANAGER, role: "restaurant_manager" }],
    });
    const result = await rememberRestaurantMemory(sb as any, MANAGER, {
      tenantId: TENANT_A,
      scope: "tenant",
      memoryType: "operational_note",
      memoryKey: "friday_staffing",
      memoryValue: "Fridays run tight on floor staff",
      source: "user_stated",
    });
    expect(result.id).toBeTruthy();
  });

  it("a non-managerial staff member cannot write tenant-level memory", async () => {
    const sb = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: WAITER, role: "viewer" }],
    });
    await expect(
      rememberRestaurantMemory(sb as any, WAITER, {
        tenantId: TENANT_A,
        scope: "tenant",
        memoryType: "operational_note",
        memoryKey: "friday_staffing",
        memoryValue: "Fridays run tight on floor staff",
        source: "user_stated",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("recallRestaurantMemory — tenant and personal isolation", () => {
  it("never returns another tenant's memory (tenant isolation)", async () => {
    const sb = makeFakeSupabase({
      members: [
        { tenant_id: TENANT_A, user_id: OWNER, role: "owner" },
        { tenant_id: TENANT_B, user_id: OWNER, role: "owner" },
      ],
    });
    await rememberRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      scope: "tenant",
      memoryType: "operational_note",
      memoryKey: "note_a",
      memoryValue: "Tenant A specific note",
      source: "user_stated",
    });
    const recalledForB = await recallRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_B,
      limit: 10,
    });
    expect(recalledForB).toHaveLength(0);
  });

  it("never returns another staff member's personal memory, even within the same tenant", async () => {
    const sb = makeFakeSupabase({
      members: [
        { tenant_id: TENANT_A, user_id: OWNER, role: "owner" },
        { tenant_id: TENANT_A, user_id: OTHER_STAFF, role: "chef" },
      ],
    });
    await rememberRestaurantMemory(sb as any, OTHER_STAFF, {
      tenantId: TENANT_A,
      scope: "user",
      memoryType: "preference",
      memoryKey: "personal_pref",
      memoryValue: "Other staff member's private preference",
      source: "user_stated",
    });
    const recalledByOwner = await recallRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      scope: "user",
      limit: 10,
    });
    expect(recalledByOwner).toHaveLength(0);
  });

  it("returns tenant-shared memory to any member, alongside the caller's own personal memory", async () => {
    const sb = makeFakeSupabase({
      members: [
        { tenant_id: TENANT_A, user_id: OWNER, role: "owner" },
        { tenant_id: TENANT_A, user_id: OTHER_STAFF, role: "chef" },
      ],
    });
    await rememberRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      scope: "tenant",
      memoryType: "operational_note",
      memoryKey: "shared_note",
      memoryValue: "Shared restaurant note",
      source: "user_stated",
    });
    await rememberRestaurantMemory(sb as any, OTHER_STAFF, {
      tenantId: TENANT_A,
      scope: "user",
      memoryType: "preference",
      memoryKey: "chef_pref",
      memoryValue: "Chef's own preference",
      source: "user_stated",
    });
    const recalledByChef = await recallRestaurantMemory(sb as any, OTHER_STAFF, {
      tenantId: TENANT_A,
      limit: 10,
    });
    const values = recalledByChef.map((m) => m.memoryValue);
    expect(values).toContain("Shared restaurant note");
    expect(values).toContain("Chef's own preference");
    expect(values).toHaveLength(2);
  });
});

describe("forgetRestaurantMemory / correctRestaurantMemory", () => {
  it("lets a staff member forget their own personal memory (status -> dismissed, never hard-deleted)", async () => {
    const sb = makeFakeSupabase({});
    const { id } = await rememberRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      scope: "user",
      memoryType: "preference",
      memoryKey: "pref_x",
      memoryValue: "Some preference",
      source: "user_stated",
    });
    await forgetRestaurantMemory(sb as any, OWNER, { tenantId: TENANT_A, memoryId: id });
    // No longer recalled (status moved off "accepted")...
    const recalled = await recallRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      limit: 10,
    });
    expect(recalled).toHaveLength(0);
    // ...but still present in the underlying store, as "dismissed" — never hard-deleted.
    const raw = await (sb as any)
      .from("intelligence_memory")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    expect(raw.data.status).toBe("dismissed");
  });

  it("forbids forgetting another staff member's personal memory", async () => {
    const sb = makeFakeSupabase({
      members: [
        { tenant_id: TENANT_A, user_id: OWNER, role: "owner" },
        { tenant_id: TENANT_A, user_id: OTHER_STAFF, role: "chef" },
      ],
    });
    const { id } = await rememberRestaurantMemory(sb as any, OTHER_STAFF, {
      tenantId: TENANT_A,
      scope: "user",
      memoryType: "preference",
      memoryKey: "pref_x",
      memoryValue: "Chef's preference",
      source: "user_stated",
    });
    await expect(
      forgetRestaurantMemory(sb as any, OWNER, { tenantId: TENANT_A, memoryId: id }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("requires managerial authority to forget tenant-level memory", async () => {
    const sb = makeFakeSupabase({
      members: [
        { tenant_id: TENANT_A, user_id: MANAGER, role: "restaurant_manager" },
        { tenant_id: TENANT_A, user_id: WAITER, role: "viewer" },
      ],
    });
    const { id } = await rememberRestaurantMemory(sb as any, MANAGER, {
      tenantId: TENANT_A,
      scope: "tenant",
      memoryType: "operational_note",
      memoryKey: "note",
      memoryValue: "Shared note",
      source: "user_stated",
    });
    await expect(
      forgetRestaurantMemory(sb as any, WAITER, { tenantId: TENANT_A, memoryId: id }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("correction updates the existing row's value in place — never a second, contradicting row", async () => {
    const sb = makeFakeSupabase({});
    const { id } = await rememberRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      scope: "user",
      memoryType: "preference",
      memoryKey: "pref_x",
      memoryValue: "Original value",
      source: "user_stated",
    });
    await correctRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      memoryId: id,
      memoryValue: "Corrected value",
    });
    const recalled = await recallRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      limit: 10,
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0].memoryValue).toBe("Corrected value");
  });
});

describe("rememberVerifiedOutcome / findRecentVerifiedOutcomes — I13 integration", () => {
  it("writes a tenant-wide, pre-accepted verified-outcome memory, reinforcing in place on repeat", async () => {
    const sb = makeFakeSupabase({});
    const first = await rememberVerifiedOutcome(sb as any, TENANT_A, {
      memoryKey: "stock_transfer:tr-1",
      memoryValue: "Stock movement TR-001 executed and independently verified (status: completed).",
    });
    expect(first.updated).toBe(false);

    const second = await rememberVerifiedOutcome(sb as any, TENANT_A, {
      memoryKey: "stock_transfer:tr-1",
      memoryValue: "Stock movement TR-001 executed and independently verified (status: received).",
    });
    expect(second.id).toBe(first.id);
    expect(second.updated).toBe(true);

    const recalled = await recallRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      limit: 10,
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0].memoryType).toBe("verified_outcome");
    expect(recalled[0].confidence).toBe(1);
  });

  it("findRecentVerifiedOutcomes retrieves only verified_outcome rows matching the key prefix, most recent first", async () => {
    const sb = makeFakeSupabase({});
    await rememberVerifiedOutcome(sb as any, TENANT_A, {
      memoryKey: "stock_transfer:tr-1",
      memoryValue: "Movement TR-001 executed and verified.",
    });
    await rememberVerifiedOutcome(sb as any, TENANT_A, {
      memoryKey: "stock_transfer:tr-2",
      memoryValue: "Movement TR-002 executed and verified.",
    });
    await rememberRestaurantMemory(sb as any, OWNER, {
      tenantId: TENANT_A,
      scope: "tenant",
      memoryType: "operational_note",
      memoryKey: "unrelated_note",
      memoryValue: "Not a stock transfer outcome",
      source: "user_stated",
    });

    const found = await findRecentVerifiedOutcomes(sb as any, OWNER, TENANT_A, "stock_transfer:");
    expect(found).toHaveLength(2);
    expect(found.every((m) => m.memoryType === "verified_outcome")).toBe(true);
  });

  it("never leaks a verified outcome from a different tenant", async () => {
    const sb = makeFakeSupabase({
      members: [
        { tenant_id: TENANT_A, user_id: OWNER, role: "owner" },
        { tenant_id: TENANT_B, user_id: OWNER, role: "owner" },
      ],
    });
    await rememberVerifiedOutcome(sb as any, TENANT_A, {
      memoryKey: "stock_transfer:tr-1",
      memoryValue: "Movement TR-001 executed and verified.",
    });
    const found = await findRecentVerifiedOutcomes(sb as any, OWNER, TENANT_B, "stock_transfer:");
    expect(found).toHaveLength(0);
  });
});

describe("submitRestaurantMemoryFeedback", () => {
  it("any tenant member can leave feedback scoped to their own tenant", async () => {
    const sb = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: WAITER, role: "viewer" }],
    });
    const result = await submitRestaurantMemoryFeedback(sb as any, WAITER, {
      tenantId: TENANT_A,
      subjectType: "recommendation",
      subjectId: "11111111-2222-3333-4444-555555555555",
      useful: true,
    });
    expect(result.id).toBeTruthy();
  });
});
