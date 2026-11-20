import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn(),
  assertEntitled: vi.fn(),
  runRestaurantDecisionPass: vi.fn(),
  executeRestaurantAction: vi.fn(),
  verifyRestaurantAction: vi.fn(),
}));

vi.mock("../core/access.server", () => ({
  assertCapability: (...args: unknown[]) => mocks.assertCapability(...args),
}));

vi.mock("@/modules/commercial/resolver.server", () => ({
  assertEntitled: (...args: unknown[]) => mocks.assertEntitled(...args),
}));

vi.mock("../decisions/decisions.server", () => ({
  runRestaurantDecisionPass: (...args: unknown[]) => mocks.runRestaurantDecisionPass(...args),
}));

vi.mock("../decisions/actions.server", () => ({
  executeRestaurantAction: (...args: unknown[]) => mocks.executeRestaurantAction(...args),
  verifyRestaurantAction: (...args: unknown[]) => mocks.verifyRestaurantAction(...args),
}));

import { executeApprovedInventoryAgentActions, runInventoryAgent } from "./inventory-agent.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SB = {} as Parameters<typeof runInventoryAgent>[0];

describe("Inventory Agent authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertEntitled.mockResolvedValue(undefined);
  });

  it("stops before decision discovery when the commercial entitlement is absent", async () => {
    mocks.assertEntitled.mockRejectedValueOnce(new Error("inventory_agent entitlement required"));

    await expect(runInventoryAgent(SB, USER, { tenantId: TENANT })).rejects.toThrow(
      /inventory_agent entitlement required/i,
    );

    expect(mocks.runRestaurantDecisionPass).not.toHaveBeenCalled();
  });

  it("stops before action discovery when intelligence.read is absent", async () => {
    mocks.assertCapability.mockRejectedValueOnce(new Error("intelligence.read required"));

    await expect(
      executeApprovedInventoryAgentActions(SB, USER, { tenantId: TENANT }),
    ).rejects.toThrow(/intelligence.read required/i);

    expect(mocks.executeRestaurantAction).not.toHaveBeenCalled();
  });
});
