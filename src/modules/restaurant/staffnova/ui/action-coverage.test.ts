import { describe, expect, it } from "vitest";
import { NOVA_ACTIONS } from "../../understand/intent.contracts";
import { APPROVAL_CAPABILITY_REGISTRY, WORKFLOW_REGISTRY } from "../../prepare/registry";

describe("Ask LexiBite action coverage", () => {
  it("covers every operational intent with a governed preparation or lifecycle path", () => {
    expect(WORKFLOW_REGISTRY.prepare_purchase_order?.workflow).toBe("purchase_request");
    expect(WORKFLOW_REGISTRY.prepare_stock_movement?.workflow).toBe("stock_transfer");
    expect(WORKFLOW_REGISTRY.prepare_requisition?.workflow).toBe("requisition");
    expect(APPROVAL_CAPABILITY_REGISTRY.approve_purchase_order).toBe("purchasing.approve");
    expect(APPROVAL_CAPABILITY_REGISTRY.submit_purchase_order).toBe("purchasing.manage");
    expect(NOVA_ACTIONS).toEqual(expect.arrayContaining([
      "prepare_purchase_order",
      "prepare_stock_movement",
      "prepare_requisition",
      "approve_purchase_order",
      "submit_purchase_order",
      "receive_purchase_order",
      "execute_stock_movement",
    ]));
  });

  it("keeps stock adjustment out of silent chat execution", () => {
    expect(NOVA_ACTIONS).not.toContain("stock_adjustment");
  });
});
