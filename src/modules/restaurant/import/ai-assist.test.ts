import { beforeEach, describe, expect, it, vi } from "vitest";

const callAiGateway = vi.fn();
vi.mock("@/lib/ai-gateway.server", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/ai-gateway.server")>("@/lib/ai-gateway.server");
  return { ...actual, callAiGateway: (...args: unknown[]) => callAiGateway(...args) };
});

import { suggestDomainViaAi, suggestFieldViaAi } from "./ai-assist";

beforeEach(() => {
  callAiGateway.mockReset();
});

describe("suggestDomainViaAi — never surfaces anything outside the real domain list", () => {
  it("accepts a well-formed suggestion naming a real domain", async () => {
    callAiGateway.mockResolvedValue({
      content: JSON.stringify({ domain: "recipe_component", confidence: 0.8, reason: "test" }),
      latencyMs: 1,
      model: "test",
    });
    const r = await suggestDomainViaAi(["Dish", "Ingredient", "Qty"], [{ Dish: "Pasta" }]);
    expect(r).toEqual({ domain: "recipe_component", confidence: 0.8, reason: "test" });
  });

  it("rejects a domain name the AI invented that is not in IMPORT_DOMAINS", async () => {
    callAiGateway.mockResolvedValue({
      content: JSON.stringify({ domain: "ingredient_master", confidence: 0.9 }),
      latencyMs: 1,
      model: "test",
    });
    const r = await suggestDomainViaAi(["A"], []);
    expect(r).toBeNull();
  });

  it("rejects an out-of-range confidence", async () => {
    callAiGateway.mockResolvedValue({
      content: JSON.stringify({ domain: "supplier", confidence: 1.5 }),
      latencyMs: 1,
      model: "test",
    });
    expect(await suggestDomainViaAi(["A"], [])).toBeNull();
  });

  it("returns null rather than throwing when the gateway is not configured", async () => {
    callAiGateway.mockRejectedValue(
      new Error("AI advisory is not configured for this deployment."),
    );
    expect(await suggestDomainViaAi(["A"], [])).toBeNull();
  });

  it("returns null on an unparseable reply instead of guessing", async () => {
    callAiGateway.mockResolvedValue({ content: "not json at all", latencyMs: 1, model: "test" });
    expect(await suggestDomainViaAi(["A"], [])).toBeNull();
  });

  it("returns null when the AI itself says it is unsure", async () => {
    callAiGateway.mockResolvedValue({
      content: JSON.stringify({ domain: null, confidence: 0, reason: "unsure" }),
      latencyMs: 1,
      model: "test",
    });
    expect(await suggestDomainViaAi(["A"], [])).toBeNull();
  });
});

describe("suggestFieldViaAi — never surfaces a field outside the domain's own canonical list", () => {
  it("accepts a well-formed suggestion naming a real field for the domain", async () => {
    callAiGateway.mockResolvedValue({
      content: JSON.stringify({ field: "reorderPoint", confidence: 0.7 }),
      latencyMs: 1,
      model: "test",
    });
    const r = await suggestFieldViaAi("Min Stock Trigger", "inventory_item", ["8", "12"]);
    expect(r).toEqual({ canonicalField: "reorderPoint", confidence: 0.7 });
  });

  it("rejects a field name that does not exist on this domain", async () => {
    callAiGateway.mockResolvedValue({
      content: JSON.stringify({ field: "supplierSku", confidence: 0.9 }),
      latencyMs: 1,
      model: "test",
    });
    // supplierSku belongs to supplier_product, not inventory_item
    const r = await suggestFieldViaAi("Vendor Code", "inventory_item", []);
    expect(r).toBeNull();
  });

  it("returns null when the gateway throws", async () => {
    callAiGateway.mockRejectedValue(new Error("boom"));
    expect(await suggestFieldViaAi("X", "inventory_item", [])).toBeNull();
  });
});
