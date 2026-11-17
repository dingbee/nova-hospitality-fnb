import { describe, expect, it } from "vitest";
import { classifyOutcome } from "./conflict";

describe("conflict classification", () => {
  it("a clean success (no error) → AUTO_RESOLVE, success=true", () => {
    const result = classifyOutcome("open_order", { result: { id: "order-1" } });
    expect(result.success).toBe(true);
    expect(result.outcome).toBe("AUTO_RESOLVE");
    expect(result.retryable).toBe(false);
  });

  it("an idempotent replay success (server returned idempotent:true) is still success — no duplicate is ever implied by this classifier", () => {
    const result = classifyOutcome("add_item", {
      result: { items: [], order: {}, idempotent: true },
    });
    expect(result.success).toBe(true);
  });

  it("fire_to_kitchen with fired=0 (nothing left to fire — a natural idempotent no-op) is success, not an error", () => {
    const result = classifyOutcome("fire_to_kitchen", { result: { fired: 0, tickets: [] } });
    expect(result.success).toBe(true);
    expect(result.reason).toMatch(/already fired/i);
  });

  it("fire_to_kitchen with fired>0 is success with no reason text", () => {
    const result = classifyOutcome("fire_to_kitchen", { result: { fired: 2, tickets: [1, 2] } });
    expect(result.success).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("'Order not found' → REQUIRES_OPERATOR, not retryable — this is the exact message getOrder/addPosLines/fireOrder throw for a missing order", () => {
    const result = classifyOutcome("add_item", { error: new Error("Order not found.") });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("REQUIRES_OPERATOR");
    expect(result.retryable).toBe(false);
  });

  it("'This bill is closed and can no longer be modified' → SERVER_WINS — the order genuinely moved on, never silently apply the stale mutation", () => {
    const result = classifyOutcome("add_item", {
      error: new Error("This bill is closed and can no longer be modified."),
    });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("SERVER_WINS");
    expect(result.retryable).toBe(false);
  });

  it("'A closed order cannot be fired to the kitchen' → SERVER_WINS", () => {
    const result = classifyOutcome("fire_to_kitchen", {
      error: new Error("A closed order cannot be fired to the kitchen."),
    });
    expect(result.outcome).toBe("SERVER_WINS");
  });

  it("a Forbidden authorization error → REQUIRES_OPERATOR, never auto-retried — this is the authorization-revoked-while-offline boundary", () => {
    const result = classifyOutcome("add_item", {
      error: new Error('Forbidden — "sales.manage" is not granted to you at this property.'),
    });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("REQUIRES_OPERATOR");
    expect(result.retryable).toBe(false);
    expect(result.reason).toMatch(/Forbidden/);
  });

  it("an unrecognized error (network timeout, 500) is treated as transient and retryable, with no forced outcome", () => {
    const result = classifyOutcome("open_order", { error: new Error("fetch failed") });
    expect(result.success).toBe(false);
    expect(result.outcome).toBeNull();
    expect(result.retryable).toBe(true);
  });

  it("never classifies a genuine business-rule conflict as CLIENT_WINS or silently as a success — the conservative-by-construction guarantee", () => {
    const closedOrderResult = classifyOutcome("add_item", {
      error: new Error("This bill is closed and can no longer be modified."),
    });
    const forbiddenResult = classifyOutcome("add_item", {
      error: new Error("Forbidden — nope."),
    });
    for (const r of [closedOrderResult, forbiddenResult]) {
      expect(r.outcome).not.toBe("CLIENT_WINS");
      expect(r.success).toBe(false);
    }
  });

  it("a non-Error thrown value is still classified without throwing (defensive against a raw string/object throw)", () => {
    const result = classifyOutcome("open_order", { error: "raw string failure" });
    expect(result.success).toBe(false);
    expect(result.reason).toBe("raw string failure");
    expect(result.retryable).toBe(true);
  });
});
