import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runRestaurantDecisionPass: vi.fn(),
  executeRestaurantAction: vi.fn(),
  verifyRestaurantAction: vi.fn(),
  assertCapability: vi.fn(),
}));

vi.mock("../core/access.server", () => ({
  assertCapability: (...args: unknown[]) => mocks.assertCapability(...args),
}));

vi.mock("../decisions/decisions.server", () => ({
  runRestaurantDecisionPass: (...args: unknown[]) => mocks.runRestaurantDecisionPass(...args),
}));

vi.mock("../decisions/actions.server", () => ({
  executeRestaurantAction: (...args: unknown[]) => mocks.executeRestaurantAction(...args),
  verifyRestaurantAction: (...args: unknown[]) => mocks.verifyRestaurantAction(...args),
}));

import {
  executeApprovedInventoryAgentActions,
  runInventoryAgent,
  verifyExecutedInventoryAgentActions,
} from "./inventory-agent.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const DECISION = "33333333-3333-4333-8333-333333333333";
const ACTION = "44444444-4444-4444-8444-444444444444";

function query(result: unknown) {
  const q: any = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) q[method] = vi.fn(() => q);
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result));
  return q;
}

function sbFor(tableResults: Record<string, unknown>) {
  return {
    from: vi.fn((table: string) => query(tableResults[table] ?? { data: [], error: null })),
  } as any;
}

describe("LexiBite Inventory Agent V1", () => {
  it("runs the canonical decision pass and returns only inventory replenishment findings", async () => {
    mocks.runRestaurantDecisionPass.mockResolvedValueOnce({
      findings: 2,
      decisionsEvaluated: 2,
      decisionsRecorded: 1,
      decisionsUpdated: 0,
      decisionsExpired: 0,
      plansCreated: 1,
      headline: "Inventory action required",
    });

    const sb = sbFor({
      intelligence_decisions: {
        data: [
          {
            id: DECISION,
            decision_key: "restaurant.tenant.finding.inventory.beef",
            status: "proposed",
            confidence: 0.82,
            recommended_option_key: "reorder_now",
            options: [
              { option: { key: "reorder_now", actionType: "restaurant.inventory.replenish_review" } },
            ],
            context: {
              finding: {
                kind: "inventory_shortage",
                subject: "Beef",
                severity: "high",
                headline: "Beef runs out in 2 days",
                facts: { inventoryItemId: "item-1", recommendedQuantity: 20, supplierId: "supplier-1" },
              },
            },
            action_id: ACTION,
          },
          {
            id: "other-decision",
            decision_key: "restaurant.tenant.finding.menu.x",
            status: "proposed",
            confidence: 0.8,
            recommended_option_key: "reprice",
            options: [{ option: { key: "reprice", actionType: "restaurant.menu.reprice_review" } }],
            context: { finding: { kind: "menu_margin", subject: "Burger" } },
            action_id: null,
          },
        ],
        error: null,
      },
      intelligence_actions: {
        data: [{ id: ACTION, status: "approved", verification_result: null }],
        error: null,
      },
    });

    const result = await runInventoryAgent(sb, USER, { tenantId: TENANT });

    expect(mocks.runRestaurantDecisionPass).toHaveBeenCalledWith(
      sb,
      USER,
      expect.objectContaining({ tenantId: TENANT, windowDays: 30, persist: true }),
    );
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      decisionId: DECISION,
      findingKind: "inventory_shortage",
      subject: "Beef",
      actionId: ACTION,
      actionStatus: "approved",
    });
  });

  it("uses a fresh decision pass and never fabricates a replenishment quantity or supplier", async () => {
    mocks.runRestaurantDecisionPass.mockResolvedValueOnce({
      findings: 1,
      decisionsEvaluated: 1,
      decisionsRecorded: 1,
      decisionsUpdated: 0,
      decisionsExpired: 0,
      plansCreated: 1,
      headline: "Review inventory",
    });

    const sb = sbFor({
      intelligence_decisions: {
        data: [{
          id: DECISION,
          decision_key: "restaurant.tenant.finding.inventory.x",
          status: "proposed",
          confidence: 0.45,
          recommended_option_key: "reorder_now",
          options: [{ option: { key: "reorder_now", actionType: "restaurant.inventory.replenish_review" } }],
          context: {
            finding: {
              kind: "inventory_shortage",
              subject: "Unknown item",
              severity: "medium",
              headline: "Below reorder point",
              facts: { inventoryItemId: "item-1", recommendedQuantity: null, supplierId: null },
            },
          },
          action_id: null,
        }],
        error: null,
      },
      intelligence_actions: { data: [], error: null },
    });

    const result = await runInventoryAgent(sb, USER, { tenantId: TENANT });
    expect(result.recommendations[0].facts).toMatchObject({
      inventoryItemId: "item-1",
      recommendedQuantity: null,
      supplierId: null,
    });
  });

  it("executes only approved/failed inventory-replenishment actions, never other restaurant actions", async () => {
    mocks.assertCapability.mockResolvedValue(undefined);
    mocks.executeRestaurantAction.mockResolvedValue({
      actionId: ACTION,
      status: "executed",
      executionResult: "procurement_request_created",
      procurementRequestId: "request-1",
      procurementRequestStatus: "draft",
    });

    const sb = sbFor({
      intelligence_decisions: {
        data: [
          { id: DECISION, decision_key: "restaurant.tenant.inventory.x", property_id: null, location_id: null },
        ],
        error: null,
      },
      intelligence_actions: {
        data: [
          { id: ACTION, decision_id: DECISION, action_type: "restaurant.inventory.replenish_review", status: "approved" },
          { id: "ignored", decision_id: DECISION, action_type: "restaurant.menu.reprice_review", status: "approved" },
          { id: "ignored-failed", decision_id: DECISION, action_type: "restaurant.inventory.replenish_review", status: "executed" },
        ],
        error: null,
      },
    });

    const result = await executeApprovedInventoryAgentActions(sb, USER, { tenantId: TENANT });

    expect(mocks.assertCapability).toHaveBeenCalledWith(sb, USER, TENANT, "intelligence.read");
    expect(mocks.executeRestaurantAction).toHaveBeenCalledTimes(1);
    expect(mocks.executeRestaurantAction).toHaveBeenCalledWith(sb, USER, { actionId: ACTION });
    expect(result.discovered).toBe(1);
    expect(result.outcomes[0]).toMatchObject({
      actionId: ACTION,
      decisionKey: "restaurant.tenant.inventory.x",
      actionType: "restaurant.inventory.replenish_review",
      status: "executed",
    });
  });

  it("does not approve actions or create a PO itself", async () => {
    mocks.assertCapability.mockResolvedValue(undefined);
    mocks.executeRestaurantAction.mockResolvedValue({
      actionId: ACTION,
      status: "executed",
      executionResult: "procurement_request_created",
      procurementRequestId: "request-1",
      procurementRequestStatus: "draft",
    });

    const sb = sbFor({
      intelligence_decisions: {
        data: [{ id: DECISION, decision_key: "inventory", property_id: null, location_id: null }],
        error: null,
      },
      intelligence_actions: {
        data: [{ id: ACTION, decision_id: DECISION, action_type: "restaurant.inventory.replenish_review", status: "approved" }],
        error: null,
      },
      restaurant_purchase_orders: {
        data: [{ id: "must-not-be-read" }],
        error: null,
      },
    });

    await executeApprovedInventoryAgentActions(sb, USER, { tenantId: TENANT });

    expect(mocks.executeRestaurantAction).toHaveBeenCalledTimes(1);
    expect((sb.from as any).mock.calls.map((call: any[]) => call[0])).not.toContain("restaurant_purchase_orders");
  });

  it("verifies only executed inventory-replenishment actions through the canonical verifier", async () => {
    mocks.assertCapability.mockResolvedValue(undefined);
    mocks.verifyRestaurantAction.mockResolvedValue({
      verified: true,
      outcome: "purchase_request_created",
      entityType: "purchase_request",
      entityId: "request-1",
      expectedQuantity: 20,
      actualQuantity: 20,
      status: "draft",
    });

    const sb = sbFor({
      intelligence_decisions: {
        data: [{ id: DECISION, decision_key: "restaurant.tenant.inventory.x", property_id: null, location_id: null }],
        error: null,
      },
      intelligence_actions: {
        data: [{ id: ACTION, decision_id: DECISION, action_type: "restaurant.inventory.replenish_review", status: "executed" }],
        error: null,
      },
    });

    const result = await verifyExecutedInventoryAgentActions(sb, USER, { tenantId: TENANT });

    expect(mocks.verifyRestaurantAction).toHaveBeenCalledWith(sb, USER, { actionId: ACTION });
    expect(result.outcomes[0].verification).toMatchObject({
      verified: true,
      entityType: "purchase_request",
    });
  });

  it("keeps execution and verification separate", async () => {
    mocks.assertCapability.mockResolvedValue(undefined);
    mocks.executeRestaurantAction.mockResolvedValue({
      actionId: ACTION,
      status: "executed",
      executionResult: "procurement_request_created",
    });

    const sb = sbFor({
      intelligence_decisions: {
        data: [{ id: DECISION, decision_key: "inventory", property_id: null, location_id: null }],
        error: null,
      },
      intelligence_actions: {
        data: [{ id: ACTION, decision_id: DECISION, action_type: "restaurant.inventory.replenish_review", status: "approved" }],
        error: null,
      },
    });

    await executeApprovedInventoryAgentActions(sb, USER, { tenantId: TENANT });

    expect(mocks.verifyRestaurantAction).not.toHaveBeenCalled();
  });
});
