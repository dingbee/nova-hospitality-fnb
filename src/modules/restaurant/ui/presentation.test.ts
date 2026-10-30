import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatMoney,
  formatMovementLabel,
  formatQuantity,
  movementQuantityLabel,
} from "./presentation";

describe("restaurant presentation formatters", () => {
  it("formats quantities without exposing unnecessary decimal places", () => {
    expect(formatQuantity(99.52)).toBe("99.52");
    expect(formatQuantity(1000)).toBe("1,000");
    expect(formatQuantity(0.150)).toBe("0.15");
  });

  it("keeps currency explicit and readable", () => {
    expect(formatMoney(15000, "TZS")).toBe("TZS 15,000");
    expect(formatMoney(15.256, "USD")).toBe("USD 15.26");
  });

  it("uses plain-language movement labels", () => {
    expect(formatMovementLabel("consumption")).toBe("Sales consumption");
    expect(formatMovementLabel("transfer_out")).toBe("Stock sent by transfer");
    expect(movementQuantityLabel("wastage", -0.5)).toBe("Quantity wasted");
    expect(movementQuantityLabel("adjustment", -2)).toBe("Quantity deducted");
  });

  it("formats valid dates and safely handles invalid dates", () => {
    expect(formatDateTime("not-a-date")).toBe("Date unavailable");
    expect(formatDateTime("2026-10-12T10:52:00.000Z")).toContain("12 Oct 2026");
  });
});
