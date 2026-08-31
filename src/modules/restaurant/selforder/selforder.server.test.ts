/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it, vi } from "vitest";
import type { GuestLineInput } from "./selforder.contracts";
import type { GuestTableContext } from "./selforder.server";

// GEP1: guestMenu() composes resolveGuestTableContext (tested below) with
// fetchSellableCatalog — the exact same tenant/property/location-scoped,
// published-only, priced catalogue query the POS itself uses, already
// exhaustively tested for tenant isolation and published-only visibility in
// pos.server.test.ts ("fetchSellableCatalog — multiple published menus").
// Mocking it here isolates the one thing guestMenu() actually adds on top —
// hiding items staff marked unavailable or that have no resolvable price —
// without re-deriving fetchSellableCatalog's own multi-table fake harness.
const fetchSellableCatalogMock = vi.fn();
vi.mock("../sales/pos.server", () => ({
  fetchSellableCatalog: (...args: unknown[]) => fetchSellableCatalogMock(...args),
}));

const {
  closeActiveGuestSession,
  guestMenu,
  pickGuestOrderableLines,
  resolveGuestTableContext,
  resolveOrStartGuestSession,
} = await import("./selforder.server");

function line(overrides: Partial<GuestLineInput> = {}): GuestLineInput {
  return {
    menuItemId: "item-1",
    description: "Item",
    quantity: 1,
    unitPrice: 0,
    discount: 0,
    modifiers: [],
    ...overrides,
  };
}

describe("pickGuestOrderableLines", () => {
  it("accepts a line whose menuItemId is in the tenant's sellable set", () => {
    const { valid, rejected } = pickGuestOrderableLines(new Set(["item-1"]), [line()]);
    expect(valid).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("rejects a menuItemId belonging to a different tenant's catalogue", () => {
    // Simulates a client sending a real, existing menu_item_id — just not one
    // that belongs to the tenant resolved from this table.
    const { valid, rejected } = pickGuestOrderableLines(new Set(["item-from-tenant-a"]), [
      line({ menuItemId: "item-from-tenant-b" }),
    ]);
    expect(valid).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it("rejects an open item with no menuItemId — no guest-priced free lines", () => {
    const { valid, rejected } = pickGuestOrderableLines(new Set(["item-1"]), [
      line({ menuItemId: undefined, unitPrice: 999 }),
    ]);
    expect(valid).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it("partitions a mixed batch instead of failing everything on one bad line", () => {
    const { valid, rejected } = pickGuestOrderableLines(new Set(["item-1"]), [
      line({ menuItemId: "item-1" }),
      line({ menuItemId: "unknown-item" }),
    ]);
    expect(valid).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

/** Minimal fake matching only the `.from().select().eq().maybeSingle()` chain resolveGuestTableContext uses. */
function fakeSb(rows: Record<string, any[]>) {
  return {
    from(table: string) {
      let filtered = rows[table] ?? [];
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle: async () => ({ data: filtered[0] ?? null }),
        then: (resolve: (v: { data: any[] }) => unknown) => resolve({ data: filtered }),
      };
      return builder;
    },
  };
}

describe("resolveGuestTableContext", () => {
  const baseRows = {
    restaurant_tables: [
      {
        id: "table-1",
        code: "T1",
        name: "Table 1",
        tenant_id: "tenant-1",
        property_id: "prop-1",
        location_id: "loc-1",
        active: true,
      },
      {
        id: "table-inactive",
        code: "T2",
        name: "Table 2",
        tenant_id: "tenant-1",
        property_id: "prop-1",
        location_id: "loc-1",
        active: false,
      },
    ],
    restaurant_tenants: [{ id: "tenant-1", name: "Demo Tenant", status: "active" }],
    restaurant_currencies: [],
  };

  it("resolves an active table to its tenant/property/location", async () => {
    const ctx = await resolveGuestTableContext(fakeSb(baseRows) as any, "table-1");
    expect(ctx).toMatchObject({
      tableId: "table-1",
      tenantId: "tenant-1",
      propertyId: "prop-1",
      locationId: "loc-1",
    });
  });

  it("refuses an inactive table", async () => {
    await expect(
      resolveGuestTableContext(fakeSb(baseRows) as any, "table-inactive"),
    ).rejects.toThrow(/not available/);
  });

  it("refuses a table id that does not exist — a guess is indistinguishable from an inactive table", async () => {
    await expect(
      resolveGuestTableContext(fakeSb(baseRows) as any, "no-such-table"),
    ).rejects.toThrow(/not available/);
  });

  it("businessName falls back to the tenant's legal name when no trading name is configured (Pre-I10)", async () => {
    const ctx = await resolveGuestTableContext(fakeSb(baseRows) as any, "table-1");
    expect(ctx.businessName).toBe("Demo Tenant");
  });

  it("businessName prefers settings.business.tradingName when the operator has configured one (Pre-I10)", async () => {
    const rows = {
      ...baseRows,
      restaurant_tenants: [
        {
          id: "tenant-1",
          name: "Demo Tenant Holdings Ltd",
          status: "active",
          settings: { business: { tradingName: "Baobab Grove Lodge" } },
        },
      ],
    };
    const ctx = await resolveGuestTableContext(fakeSb(rows) as any, "table-1");
    expect(ctx.businessName).toBe("Baobab Grove Lodge");
    // The legal/registered name is preserved unchanged alongside it — not
    // overwritten by the trading name.
    expect(ctx.tenantName).toBe("Demo Tenant Holdings Ltd");
  });

  it("businessName ignores a blank/whitespace-only trading name and falls back to the tenant name (Pre-I10)", async () => {
    const rows = {
      ...baseRows,
      restaurant_tenants: [
        {
          id: "tenant-1",
          name: "Demo Tenant",
          status: "active",
          settings: { business: { tradingName: "   " } },
        },
      ],
    };
    const ctx = await resolveGuestTableContext(fakeSb(rows) as any, "table-1");
    expect(ctx.businessName).toBe("Demo Tenant");
  });

  it("refuses a table whose tenant is no longer active", async () => {
    const rows = {
      ...baseRows,
      restaurant_tenants: [{ id: "tenant-1", name: "Demo Tenant", status: "suspended" }],
    };
    await expect(resolveGuestTableContext(fakeSb(rows) as any, "table-1")).rejects.toThrow(
      /not available/,
    );
  });
});

/**
 * GEP1 — guestMenu()'s own composition on top of the already-tested
 * resolveGuestTableContext + fetchSellableCatalog: it hides any item staff
 * marked unavailable, and any item with no resolvable price
 * (priceConfigured: false) — never letting a guest tap something the order
 * path would only refuse afterwards. Tenant/published-only scoping is
 * fetchSellableCatalog's own, already-covered contract (pos.server.test.ts);
 * fetchSellableCatalog is mocked here purely to isolate this one filter.
 */
describe("guestMenu", () => {
  const tableRows = {
    restaurant_tables: [
      {
        id: "table-1",
        code: "T1",
        name: "Table 1",
        tenant_id: "tenant-1",
        property_id: "prop-1",
        location_id: "loc-1",
        active: true,
      },
    ],
    restaurant_tenants: [{ id: "tenant-1", name: "Demo Tenant", status: "active" }],
    restaurant_currencies: [],
  };

  it("M: hides an item staff marked unavailable, and one with no resolvable price, while keeping ordinary items", async () => {
    fetchSellableCatalogMock.mockResolvedValueOnce({
      menus: [],
      activeMenuId: null,
      categories: [],
      items: [
        { id: "item-ok", name: "Grilled Fish", available: true, priceConfigured: true },
        {
          id: "item-unavailable",
          name: "Sold Out Special",
          available: false,
          priceConfigured: true,
        },
        { id: "item-unpriced", name: "No Price Set", available: true, priceConfigured: false },
      ],
    });
    const menu = await guestMenu(fakeSb(tableRows) as any, "table-1");
    expect(menu.items.map((i: any) => i.id)).toEqual(["item-ok"]);
  });

  it("passes the resolved tenant/property/location through to fetchSellableCatalog — never trusts a client-supplied value (only tableId is ever accepted)", async () => {
    fetchSellableCatalogMock.mockResolvedValueOnce({
      menus: [],
      activeMenuId: null,
      categories: [],
      items: [],
    });
    await guestMenu(fakeSb(tableRows) as any, "table-1");
    expect(fetchSellableCatalogMock).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      expect.objectContaining({ propertyId: "prop-1", locationId: "loc-1" }),
    );
  });

  it("N: a table that resolves to a different tenant only ever reaches fetchSellableCatalog with that tenant's id — no cross-tenant leak is possible from guestMenu's own composition", async () => {
    const otherTenantRows = {
      ...tableRows,
      restaurant_tables: [{ ...tableRows.restaurant_tables[0], tenant_id: "tenant-2" }],
      restaurant_tenants: [{ id: "tenant-2", name: "Other Tenant", status: "active" }],
    };
    fetchSellableCatalogMock.mockResolvedValueOnce({
      menus: [],
      activeMenuId: null,
      categories: [],
      items: [],
    });
    await guestMenu(fakeSb(otherTenantRows) as any, "table-1");
    expect(fetchSellableCatalogMock).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-2",
      expect.anything(),
    );
  });
});

/**
 * O12 — the guest dining-session gate. A minimal in-memory fake for
 * restaurant_guest_sessions supporting exactly the
 * select/eq/lt/maybeSingle/update/insert shapes resolveOrStartGuestSession
 * and closeActiveGuestSession use, including the partial-unique-index
 * behaviour (`insert` fails if another 'active' row already exists for the
 * same table_id) so the pre-check's refusal path and the DB constraint's
 * backstop are both exercised the same way the real schema enforces it.
 */
function fakeSessionsSb(initialRows: any[] = []) {
  const rows: any[] = initialRows.map((r) => ({ ...r }));
  let seq = rows.length;

  function from(table: string) {
    if (table !== "restaurant_guest_sessions") throw new Error(`unexpected table ${table}`);
    const eqFilters: Array<[string, unknown]> = [];
    const ltFilters: Array<[string, unknown]> = [];
    let op: "select" | "update" | "insert" = "select";
    let payload: any;

    function matches(r: any) {
      return (
        eqFilters.every(([c, v]) => r[c] === v) && ltFilters.every(([c, v]) => r[c] < (v as string))
      );
    }

    async function resolve(single: boolean) {
      if (op === "select") {
        const matched = rows.filter(matches);
        return single ? { data: matched[0] ?? null, error: null } : { data: matched, error: null };
      }
      if (op === "update") {
        for (const r of rows.filter(matches)) Object.assign(r, payload);
        return { data: null, error: null };
      }
      if (op === "insert") {
        if (
          payload.status === "active" &&
          rows.some((r) => r.table_id === payload.table_id && r.status === "active")
        ) {
          return {
            data: null,
            error: { message: "duplicate key value violates unique constraint" },
          };
        }
        seq += 1;
        rows.push({ id: `session-${seq}`, ...payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        eqFilters.push([col, val]);
        return api;
      },
      lt: (col: string, val: unknown) => {
        ltFilters.push([col, val]);
        return api;
      },
      update: (patch: any) => {
        op = "update";
        payload = patch;
        return api;
      },
      insert: (row: any) => {
        op = "insert";
        payload = row;
        return api;
      },
      maybeSingle: () => resolve(true),
      then: (onFulfilled: any, onRejected: any) => resolve(false).then(onFulfilled, onRejected),
    };
    return api;
  }

  return { sb: { from } as any, rows };
}

const TABLE_1: GuestTableContext = {
  tableId: "table-1",
  tableCode: "T1",
  tableName: "Table 1",
  tenantId: "tenant-1",
  tenantName: "Demo Tenant",
  businessName: "Demo Tenant",
  propertyId: "prop-1",
  locationId: "loc-1",
  currency: "USD",
};

const TABLE_2: GuestTableContext = { ...TABLE_1, tableId: "table-2", tableCode: "T2" };

function activeSessionRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  return {
    id: "session-existing",
    tenant_id: "tenant-1",
    table_id: "table-1",
    token: "existing-token",
    status: "active",
    started_at: new Date(now - 60_000).toISOString(),
    last_activity_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 60 * 60_000).toISOString(),
    closed_at: null,
    closed_reason: null,
    ...overrides,
  };
}

describe("resolveOrStartGuestSession", () => {
  it("issues a new session when the table has none active — first legitimate scan", async () => {
    const { sb, rows } = fakeSessionsSb([]);
    const token = await resolveOrStartGuestSession(sb, TABLE_1, undefined);
    expect(token).toEqual(expect.any(String));
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ table_id: "table-1", status: "active" });
  });

  it("reuses and extends a presented token that matches an active, unexpired session on this table", async () => {
    const existing = activeSessionRow();
    const { sb, rows } = fakeSessionsSb([existing]);
    const token = await resolveOrStartGuestSession(sb, TABLE_1, "existing-token");
    expect(token).toBe("existing-token");
    expect(rows).toHaveLength(1); // reused, not duplicated
    expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThan(
      new Date(existing.expires_at).getTime(),
    ); // rolling expiry moved forward
  });

  it("refuses a new order when another session is already active on the table and no valid token is presented — table occupied", async () => {
    const { sb } = fakeSessionsSb([activeSessionRow()]);
    await expect(resolveOrStartGuestSession(sb, TABLE_1, undefined)).rejects.toThrow(
      /already has a dining session/,
    );
  });

  it("treats an expired token as absent — lazily expires the stale row and starts a fresh session (QR reuse: old session != new session)", async () => {
    const stale = activeSessionRow({
      token: "stale-token",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const { sb, rows } = fakeSessionsSb([stale]);
    const token = await resolveOrStartGuestSession(sb, TABLE_1, "stale-token");
    expect(token).not.toBe("stale-token");
    const staleRow = rows.find((r) => r.token === "stale-token");
    expect(staleRow?.status).toBe("expired");
    const newRow = rows.find((r) => r.token === token);
    expect(newRow).toMatchObject({ table_id: "table-1", status: "active" });
  });

  it("treats a closed token as absent — the old dining session cannot authorize a new order (checkout/expiry closure)", async () => {
    const closed = activeSessionRow({
      token: "closed-token",
      status: "closed",
      closed_at: new Date().toISOString(),
    });
    const { sb, rows } = fakeSessionsSb([closed]);
    const token = await resolveOrStartGuestSession(sb, TABLE_1, "closed-token");
    expect(token).not.toBe("closed-token");
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
  });

  it("cross-table isolation: a token valid for table 1 does not authorize table 2, and does not block a fresh session there", async () => {
    const table1Session = activeSessionRow();
    const { sb, rows } = fakeSessionsSb([table1Session]);
    const token = await resolveOrStartGuestSession(sb, TABLE_2, "existing-token");
    expect(token).not.toBe("existing-token");
    const table2Row = rows.find((r) => r.table_id === "table-2");
    expect(table2Row).toMatchObject({ status: "active" });
    // Table 1's session is untouched by a request scoped to table 2.
    expect(rows.find((r) => r.table_id === "table-1")).toMatchObject({
      token: "existing-token",
      status: "active",
    });
  });

  it("replay: a stale/foreign token presented against an already-occupied table is indistinguishable from no token — still refused", async () => {
    const guestBActive = activeSessionRow({ id: "session-b", token: "guest-b-token" });
    const { sb } = fakeSessionsSb([guestBActive]);
    // Guest A replays an old token that matches nothing live on this table.
    await expect(resolveOrStartGuestSession(sb, TABLE_1, "guest-a-old-token")).rejects.toThrow(
      /already has a dining session/,
    );
  });
});

describe("closeActiveGuestSession", () => {
  it("closes the table's active session so a later presentation of its token is treated as absent", async () => {
    const existing = activeSessionRow();
    const { sb, rows } = fakeSessionsSb([existing]);
    await closeActiveGuestSession(sb, "table-1", "table_released");
    expect(rows[0]).toMatchObject({ status: "closed", closed_reason: "table_released" });

    const token = await resolveOrStartGuestSession(sb, TABLE_1, "existing-token");
    expect(token).not.toBe("existing-token"); // a fresh scan now starts a new session
  });

  it("leaves other tables' sessions untouched", async () => {
    const t1 = activeSessionRow();
    const t2 = activeSessionRow({ id: "session-t2", table_id: "table-2", token: "t2-token" });
    const { sb, rows } = fakeSessionsSb([t1, t2]);
    await closeActiveGuestSession(sb, "table-1", "table_released");
    expect(rows.find((r) => r.table_id === "table-2")).toMatchObject({ status: "active" });
  });
});
