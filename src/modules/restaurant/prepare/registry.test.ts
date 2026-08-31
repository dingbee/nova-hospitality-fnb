import { describe, expect, it } from "vitest";
import { APPROVAL_CAPABILITY_REGISTRY, WORKFLOW_REGISTRY } from "./registry";

describe("WORKFLOW_REGISTRY", () => {
  it("maps prepare_purchase_order to the purchase_request workflow with the request (not order) capability", () => {
    expect(WORKFLOW_REGISTRY.prepare_purchase_order).toEqual({
      workflow: "purchase_request",
      prepareCapability: "purchase.request",
    });
  });

  it("maps both prepare_stock_movement and execute_stock_movement to the same stock_transfer workflow — I12 always only prepares, regardless of requestedExecution", () => {
    expect(WORKFLOW_REGISTRY.prepare_stock_movement).toEqual({
      workflow: "stock_transfer",
      prepareCapability: "transfer.manage",
    });
    expect(WORKFLOW_REGISTRY.execute_stock_movement).toEqual({
      workflow: "stock_transfer",
      prepareCapability: "transfer.manage",
    });
  });

  it("maps prepare_requisition to the requisition workflow", () => {
    expect(WORKFLOW_REGISTRY.prepare_requisition).toEqual({
      workflow: "requisition",
      prepareCapability: "requisition.create",
    });
  });

  it("has no entry for query_* or unknown actions — nothing to prepare for an information request", () => {
    expect(WORKFLOW_REGISTRY.query_inventory).toBeUndefined();
    expect(WORKFLOW_REGISTRY.query_sales).toBeUndefined();
    expect(WORKFLOW_REGISTRY.query_menu).toBeUndefined();
    expect(WORKFLOW_REGISTRY.query_kitchen).toBeUndefined();
    expect(WORKFLOW_REGISTRY.unknown).toBeUndefined();
  });

  it("has no entry for approve/submit — those are handled by the separate approval-capability registry, never a draft workflow", () => {
    expect(WORKFLOW_REGISTRY.approve_purchase_order).toBeUndefined();
    expect(WORKFLOW_REGISTRY.submit_purchase_order).toBeUndefined();
  });
});

describe("APPROVAL_CAPABILITY_REGISTRY", () => {
  it("gates approve_purchase_order on the real approval capability, not the request capability", () => {
    expect(APPROVAL_CAPABILITY_REGISTRY.approve_purchase_order).toBe("purchasing.approve");
  });

  it("gates submit_purchase_order on purchasing.manage", () => {
    expect(APPROVAL_CAPABILITY_REGISTRY.submit_purchase_order).toBe("purchasing.manage");
  });
});
