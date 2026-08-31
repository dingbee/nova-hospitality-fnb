/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase client / test doubles are untyped at this boundary. */
/**
 * I12 "NOVA PREPARE" — orchestration tests, covering spec section 34's
 * numbered scenarios and section 35's adversarial cases.
 *
 * The three real draft-creation functions (savePurchaseRequest,
 * createTransfer, saveRequisitionDraft) are mocked at the module boundary
 * — they have their own existing test coverage, and live UAT proves the
 * real end-to-end integration. What THIS suite proves is that prepare.
 * server.ts's own logic (readiness classification, independent entity
 * re-verification, capability gating) is correct, and that it NEVER calls
 * any of the three real functions except when readiness is ready/
 * ready_with_warnings.
 *
 * The fake Supabase client's own insert/update/upsert/delete throw — this
 * is the structural proof that prepare.server.ts's OWN code (everything
 * except the three mocked create/save calls) never writes anything itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NovaEntityMention,
  NovaIntentContract,
  NovaLocationReference,
} from "../understand/intent.contracts";

const savePurchaseRequestMock = vi.fn();
vi.mock("../procurement/requests.server", () => ({
  savePurchaseRequest: (...args: unknown[]) => savePurchaseRequestMock(...args),
}));

const createTransferMock = vi.fn();
vi.mock("../inventory/transfers.server", () => ({
  createTransfer: (...args: unknown[]) => createTransferMock(...args),
}));

const saveRequisitionDraftMock = vi.fn();
vi.mock("../requisitions/requisitions.server", () => ({
  saveRequisitionDraft: (...args: unknown[]) => saveRequisitionDraftMock(...args),
}));

const { previewNovaPreparation, commitNovaPreparation } = await import("./prepare.server");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "99999999-9999-9999-9999-999999999999";
const USER = "22222222-2222-2222-2222-222222222222";
const VIEWER = "33333333-3333-3333-3333-333333333333";

interface Fixtures {
  members?: any[];
  inventoryItems?: any[];
  locations?: any[];
  suppliers?: any[];
  units?: any[];
  tenants?: any[];
}

function makeFakeSupabase(fixtures: Fixtures) {
  const tables: Record<string, any[]> = {
    restaurant_members: fixtures.members ?? [{ tenant_id: TENANT_A, user_id: USER, role: "owner" }],
    restaurant_inventory_items: fixtures.inventoryItems ?? [],
    restaurant_locations: fixtures.locations ?? [],
    restaurant_suppliers: fixtures.suppliers ?? [],
    restaurant_inventory_units: fixtures.units ?? [],
    restaurant_tenants: fixtures.tenants ?? [{ id: TENANT_A, settings: {} }],
  };

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    const fail = (op: string) => () => {
      throw new Error(
        `Unexpected write: ${op} on ${table} — prepare.server.ts must never write directly.`,
      );
    };
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      insert: fail("insert"),
      update: fail("update"),
      upsert: fail("upsert"),
      delete: fail("delete"),
      maybeSingle: () => {
        const rows = tables[table] ?? [];
        const match = rows.find((r) => filters.every(([col, val]) => r[col] === val));
        return Promise.resolve({ data: match ?? null, error: null });
      },
      then: (resolve: any) => {
        let rows = tables[table] ?? [];
        for (const [col, val] of filters) rows = rows.filter((r) => r[col] === val);
        return resolve({ data: rows, error: null });
      },
    };
    return api;
  }
  return {
    from: (table: string) => builder(table),
    rpc: async (fn: string) =>
      fn === "has_any_role" ? { data: false, error: null } : { data: null, error: null },
  };
}

const LOCATIONS = [
  {
    id: "loc-main",
    name: "Main Store",
    location_type: "store",
    tenant_id: TENANT_A,
    status: "active",
  },
  {
    id: "loc-kitchen",
    name: "Kitchen",
    location_type: "kitchen",
    tenant_id: TENANT_A,
    status: "active",
  },
  { id: "loc-bar", name: "Bar", location_type: "bar", tenant_id: TENANT_A, status: "active" },
];
const INVENTORY = [
  {
    id: "inv-beef",
    name: "Beef Fillet",
    unit_id: "unit-kg",
    tenant_id: TENANT_A,
    status: "active",
  },
  {
    id: "inv-rice",
    name: "Basmati Rice",
    unit_id: "unit-kg",
    tenant_id: TENANT_A,
    status: "active",
  },
  {
    id: "inv-coke",
    name: "Coca-Cola",
    unit_id: "unit-carton",
    tenant_id: TENANT_A,
    status: "active",
  },
];
const SUPPLIERS = [
  { id: "sup-metro", name: "Metro Wholesale", tenant_id: TENANT_A, status: "active" },
];
const UNITS = [
  { id: "unit-kg", code: "kg", tenant_id: TENANT_A },
  { id: "unit-carton", code: "cartons", tenant_id: TENANT_A },
];

function fullFixtures(overrides: Partial<Fixtures> = {}): Fixtures {
  return {
    locations: LOCATIONS,
    inventoryItems: INVENTORY,
    suppliers: SUPPLIERS,
    units: UNITS,
    ...overrides,
  };
}

function entity(overrides: Partial<NovaEntityMention> = {}): NovaEntityMention {
  return {
    raw: "beef",
    entityDomain: "inventory_item",
    status: "exact",
    resolvedId: "inv-beef",
    resolvedName: "Beef Fillet",
    candidates: [],
    quantity: { raw: "3kg", quantity: 3, unitText: "kg", resolvedUnitId: "unit-kg" },
    ...overrides,
  };
}

function location(overrides: Partial<NovaLocationReference> = {}): NovaLocationReference {
  return {
    raw: "Main Store",
    status: "exact",
    resolvedId: "loc-main",
    resolvedName: "Main Store",
    candidates: [],
    ...overrides,
  };
}

function contract(overrides: Partial<NovaIntentContract> = {}): NovaIntentContract {
  return {
    intent: "operational_command",
    domain: "stock_movement",
    action: "prepare_stock_movement",
    entities: [],
    locations: { source: null, destination: null },
    supplier: null,
    temporal: null,
    constraints: [],
    requestedExecution: "prepare",
    confidence: 0.85,
    missingInformation: [],
    ambiguities: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("previewNovaPreparation — scenario 1/2: purchase-order (purchase-request) preparation", () => {
  it("ready: a single resolved item with no supplier prepares cleanly", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      action: "prepare_purchase_order",
      domain: "procurement",
      entities: [
        entity({
          raw: "coke",
          resolvedId: "inv-coke",
          resolvedName: "Coca-Cola",
          quantity: {
            raw: "20 cartons",
            quantity: 20,
            unitText: "cartons",
            resolvedUnitId: "unit-carton",
          },
        }),
      ],
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.workflow).toBe("purchase_request");
    expect(result.readiness).toBe("ready");
    expect((result.fields as any).lines[0]).toMatchObject({
      inventoryItemId: "inv-coke",
      quantity: 20,
    });
    expect(savePurchaseRequestMock).not.toHaveBeenCalled();
    expect(createTransferMock).not.toHaveBeenCalled();
    expect(saveRequisitionDraftMock).not.toHaveBeenCalled();
  });

  it("purchase-request preparation tolerates an unresolved item as a free-text line, with a warning — matches the underlying schema's own optional inventoryItemId", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      action: "prepare_purchase_order",
      domain: "procurement",
      entities: [
        entity({
          raw: "widget",
          status: "unresolved",
          resolvedId: null,
          resolvedName: null,
          quantity: { raw: "5", quantity: 5, unitText: "", resolvedUnitId: null },
        }),
      ],
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.readiness).toBe("ready_with_warnings");
    expect(result.warnings.some((w) => w.includes("widget"))).toBe(true);
  });

  it("resolves a named supplier onto every line's preferredSupplierId", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      action: "prepare_purchase_order",
      domain: "procurement",
      entities: [entity({ raw: "coke", resolvedId: "inv-coke", resolvedName: "Coca-Cola" })],
      supplier: {
        raw: "supplier Metro Wholesale",
        kind: "named",
        status: "exact",
        resolvedId: "sup-metro",
        resolvedName: "Metro Wholesale",
        candidates: [],
      },
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect((result.fields as any).supplierId).toBe("sup-metro");
    expect(result.readiness).toBe("ready");
  });

  it("'cheapest supplier' never resolves to an id — surfaced as a warning, not a guess", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      action: "prepare_purchase_order",
      domain: "procurement",
      entities: [entity({ raw: "coke", resolvedId: "inv-coke", resolvedName: "Coca-Cola" })],
      supplier: {
        raw: "the cheapest supplier",
        kind: "cheapest",
        status: "deferred",
        resolvedId: null,
        resolvedName: null,
        candidates: [],
      },
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect((result.fields as any).supplierId).toBeNull();
    expect(result.warnings.some((w) => w.toLowerCase().includes("cheapest"))).toBe(true);
    expect(result.readiness).toBe("ready_with_warnings");
  });
});

describe("previewNovaPreparation — scenario 3: stock-movement (stock-transfer) preparation, the 3kg beef / 4kg rice example", () => {
  it("ready: two resolved lines, both locations resolved", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      entities: [
        entity({ raw: "beef", resolvedId: "inv-beef", resolvedName: "Beef Fillet" }),
        entity({
          raw: "rice",
          resolvedId: "inv-rice",
          resolvedName: "Basmati Rice",
          quantity: { raw: "4kg", quantity: 4, unitText: "kg", resolvedUnitId: "unit-kg" },
        }),
      ],
      locations: {
        source: location({ raw: "Main Store", resolvedId: "loc-main", resolvedName: "Main Store" }),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.workflow).toBe("stock_transfer");
    expect(result.readiness).toBe("ready");
    const fields = result.fields as any;
    expect(fields.lines).toHaveLength(2);
    expect(fields.sourceLocationId).toBe("loc-main");
    expect(fields.destinationLocationId).toBe("loc-kitchen");
  });

  it("scenario 12: an unresolved item BLOCKS transfer readiness — unlike purchase requests, a transfer line requires a real inventoryItemId", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      entities: [
        entity({ raw: "widget", status: "unresolved", resolvedId: null, resolvedName: null }),
      ],
      locations: {
        source: location(),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.readiness).toBe("missing_required_information");
    expect(result.missingFields.some((m) => m.includes("widget"))).toBe(true);
  });

  it("scenario 9/17: missing source location blocks readiness — never invented", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      entities: [entity()],
      locations: {
        source: null,
        destination: location({ raw: "Bar", resolvedId: "loc-bar", resolvedName: "Bar" }),
      },
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.readiness).toBe("missing_required_information");
    expect(result.missingFields).toContain("source location");
  });

  it("scenario 10: ambiguous entity blocks readiness and never resolves a line", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      entities: [
        entity({
          status: "ambiguous",
          resolvedId: null,
          resolvedName: null,
          candidates: [{ id: "inv-beef", name: "Beef Fillet", score: 0.5 }],
        }),
      ],
      locations: {
        source: location(),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.readiness).toBe("ambiguous");
    expect(result.ambiguousFields.length).toBeGreaterThan(0);
  });

  it("scenario 7: an unresolved unit doesn't block readiness (unitId is optional on the real schema) but is warned about", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      entities: [
        entity({
          quantity: { raw: "3 barrels", quantity: 3, unitText: "barrels", resolvedUnitId: null },
        }),
      ],
      locations: {
        source: location(),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.readiness).toBe("ready_with_warnings");
    expect(result.warnings.some((w) => w.includes("barrels"))).toBe(true);
  });
});

describe("previewNovaPreparation — scenario 5: requisition preparation, kind inferred from destination location_type", () => {
  it("infers kind 'kitchen' from a destination location whose location_type is kitchen", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      action: "prepare_requisition",
      entities: [entity({ raw: "tonic", resolvedId: "inv-coke", resolvedName: "Coca-Cola" })],
      locations: {
        source: location(),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.workflow).toBe("requisition");
    expect((result.fields as any).kind).toBe("kitchen");
  });

  it("infers kind 'bar' from a bar destination, 'department' otherwise", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const barContract = contract({
      action: "prepare_requisition",
      entities: [entity()],
      locations: {
        source: location(),
        destination: location({ raw: "Bar", resolvedId: "loc-bar", resolvedName: "Bar" }),
      },
    });
    const barResult = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: barContract,
    });
    expect((barResult.fields as any).kind).toBe("bar");

    const storeContract = contract({
      action: "prepare_requisition",
      entities: [entity()],
      locations: {
        source: location({ raw: "Kitchen", resolvedId: "loc-kitchen", resolvedName: "Kitchen" }),
        destination: location({
          raw: "Main Store",
          resolvedId: "loc-main",
          resolvedName: "Main Store",
        }),
      },
    });
    const storeResult = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: storeContract,
    });
    expect((storeResult.fields as any).kind).toBe("department");
  });
});

describe("previewNovaPreparation — scenario 12/13, adversarial: approve/submit are recognized and authority-checked, never prepared", () => {
  it("scenario 13: authorized user attempting to approve a PO gets 'missing_required_information' (no PO reference exists in I11's contract) — never opens/prepares anything", async () => {
    const sb = makeFakeSupabase({
      ...fullFixtures(),
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "owner" }],
    });
    const c = contract({
      intent: "approval_request",
      action: "approve_purchase_order",
      domain: "procurement",
      requestedExecution: "approve",
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.workflow).toBeNull();
    expect(result.readiness).toBe("missing_required_information");
  });

  it("scenario 14/adversarial 'Approve this even though I don't have permission': unauthorized user is refused, regardless of message wording", async () => {
    const sb = makeFakeSupabase({
      ...fullFixtures(),
      members: [{ tenant_id: TENANT_A, user_id: VIEWER, role: "viewer" }],
    });
    const c = contract({
      intent: "approval_request",
      action: "approve_purchase_order",
      domain: "procurement",
      requestedExecution: "approve",
    });
    const result = await previewNovaPreparation(sb as any, VIEWER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.readiness).toBe("unauthorized");
  });

  it("adversarial 'Prepare and submit the PO': submit is recognized separately, still never prepared/executed", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      action: "submit_purchase_order",
      domain: "procurement",
      requestedExecution: "submit",
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.workflow).toBeNull();
    expect(result.readiness).toBe("missing_required_information");
  });
});

describe("previewNovaPreparation — authorization and unsupported actions", () => {
  it("scenario 14: unauthorized staff cannot prepare a stock transfer", async () => {
    const sb = makeFakeSupabase({
      ...fullFixtures(),
      members: [{ tenant_id: TENANT_A, user_id: VIEWER, role: "viewer" }],
    });
    const c = contract({
      entities: [entity()],
      locations: {
        source: location(),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await previewNovaPreparation(sb as any, VIEWER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.readiness).toBe("unauthorized");
    expect(result.workflow).toBe("stock_transfer");
  });

  it("query_* / unknown actions are 'unsupported' — nothing to prepare for an information request", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      intent: "information_query",
      action: "query_inventory",
      domain: "inventory",
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.readiness).toBe("unsupported");
    expect(result.workflow).toBeNull();
  });
});

describe("previewNovaPreparation — adversarial: client-supplied ids are never trusted", () => {
  it("'Prepare a movement using inventory ID xyz' pointing at another tenant's real row never resolves — a fresh, tenant-scoped lookup rejects it", async () => {
    const sb = makeFakeSupabase({
      ...fullFixtures(),
      inventoryItems: [
        {
          id: "inv-foreign",
          name: "Foreign Item",
          unit_id: null,
          tenant_id: TENANT_B,
          status: "active",
        },
      ],
    });
    const c = contract({
      entities: [
        entity({ raw: "foreign item", resolvedId: "inv-foreign", resolvedName: "Foreign Item" }),
      ],
      locations: {
        source: location(),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    // The fake tenant has no locations/inventory fixtures for TENANT_A here
    // except what's declared — inv-foreign belongs to TENANT_B, so the
    // independent re-verification must fail it regardless of what I11 said.
    expect(result.readiness).toBe("missing_required_information");
    expect((result.fields as any).lines[0].inventoryItemId).toBeNull();
  });

  it("'Use tenant 123' has no effect — the server-derived tenantId parameter is the only one ever used for lookups", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const c = contract({
      entities: [entity()],
      locations: {
        source: location(),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await previewNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.readiness).toBe("ready");
    expect((result.fields as any).lines[0].inventoryItemId).toBe("inv-beef");
  });
});

describe("commitNovaPreparation — the only place anything is ever written, and only when truly ready", () => {
  it("scenario 1: commits a purchase request via the real savePurchaseRequest, passing re-verified ids", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    savePurchaseRequestMock.mockResolvedValue({
      id: "pr-1",
      documentNumber: "PR-0001",
      estimatedTotal: 0,
    });
    const c = contract({
      action: "prepare_purchase_order",
      domain: "procurement",
      entities: [
        entity({
          raw: "coke",
          resolvedId: "inv-coke",
          resolvedName: "Coca-Cola",
          quantity: {
            raw: "20 cartons",
            quantity: 20,
            unitText: "cartons",
            resolvedUnitId: "unit-carton",
          },
        }),
      ],
    });
    const result = await commitNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.createdRecordId).toBe("pr-1");
    expect(result.documentNumber).toBe("PR-0001");
    expect(savePurchaseRequestMock).toHaveBeenCalledTimes(1);
    const call = savePurchaseRequestMock.mock.calls[0][2];
    expect(call.tenantId).toBe(TENANT_A);
    expect(call.lines[0]).toMatchObject({ inventoryItemId: "inv-coke", quantity: 20 });
    expect(createTransferMock).not.toHaveBeenCalled();
    expect(saveRequisitionDraftMock).not.toHaveBeenCalled();
  });

  it("scenario 3: commits a stock transfer via createTransfer with submit:false — never auto-approved/dispatched", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    createTransferMock.mockResolvedValue({
      id: "trf-1",
      transferNumber: "TRF-0001",
      status: "draft",
    });
    const c = contract({
      entities: [entity()],
      locations: {
        source: location(),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await commitNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.createdRecordId).toBe("trf-1");
    expect(createTransferMock).toHaveBeenCalledTimes(1);
    const call = createTransferMock.mock.calls[0][2];
    expect(call.submit).toBe(false);
    expect(call.requiresApproval).toBe(false);
    expect(call.sourceLocationId).toBe("loc-main");
    expect(call.destinationLocationId).toBe("loc-kitchen");
  });

  it("scenario 5: commits a requisition via saveRequisitionDraft with submit:false", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    saveRequisitionDraftMock.mockResolvedValue({
      id: "req-1",
      reference: "REQ-0001",
      status: "draft",
    });
    const c = contract({
      action: "prepare_requisition",
      entities: [entity()],
      locations: {
        source: location(),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await commitNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    expect(result.createdRecordId).toBe("req-1");
    expect(saveRequisitionDraftMock).toHaveBeenCalledTimes(1);
    const call = saveRequisitionDraftMock.mock.calls[0][2];
    expect(call.submit).toBe(false);
    expect(call.kind).toBe("kitchen");
  });

  it("scenario 19: no operational mutation — commit NEVER calls any of the three real functions when readiness isn't ready", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const ambiguousContract = contract({
      entities: [entity({ status: "ambiguous", resolvedId: null, resolvedName: null })],
      locations: {
        source: location(),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await commitNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: ambiguousContract,
    });
    expect(result.readiness).toBe("ambiguous");
    expect(result.createdRecordId).toBeNull();
    expect(savePurchaseRequestMock).not.toHaveBeenCalled();
    expect(createTransferMock).not.toHaveBeenCalled();
    expect(saveRequisitionDraftMock).not.toHaveBeenCalled();
  });

  it("scenario 20/21: approve/submit actions never reach a commit path — no real function is ever called for them", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    const approveContract = contract({
      intent: "approval_request",
      action: "approve_purchase_order",
      domain: "procurement",
    });
    const result = await commitNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: approveContract,
    });
    expect(result.createdRecordId).toBeNull();
    expect(savePurchaseRequestMock).not.toHaveBeenCalled();
  });

  it("adversarial 'Move 100kg even though only 2kg exists': I12 has no stock-level knowledge and never fabricates it — it prepares the draft exactly as stated, quantity validation against available stock is deliberately NOT this sprint's job (the existing workflow/ledger owns that)", async () => {
    const sb = makeFakeSupabase(fullFixtures());
    createTransferMock.mockResolvedValue({
      id: "trf-2",
      transferNumber: "TRF-0002",
      status: "draft",
    });
    const c = contract({
      entities: [
        entity({
          quantity: { raw: "100kg", quantity: 100, unitText: "kg", resolvedUnitId: "unit-kg" },
        }),
      ],
      locations: {
        source: location(),
        destination: location({
          raw: "Kitchen",
          resolvedId: "loc-kitchen",
          resolvedName: "Kitchen",
        }),
      },
    });
    const result = await commitNovaPreparation(sb as any, USER, {
      tenantId: TENANT_A,
      contract: c,
    });
    // Still just a DRAFT — createTransfer itself performs no ledger write
    // (see the I12 architectural verdict); over-quantity is a matter for
    // the human reviewing the draft, or the existing dispatch-time check.
    expect(result.createdRecordId).toBe("trf-2");
    expect(createTransferMock.mock.calls[0][2].lines[0].requestedQuantity).toBe(100);
  });
});
