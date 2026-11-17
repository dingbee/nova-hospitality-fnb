import { describe, expect, it } from "vitest";
import { parseGuestCount, parseItemQuantities, resolveUnitId } from "./quantity";

describe("parseItemQuantities", () => {
  it("parses 'Nkg' with no space", () => {
    const matches = parseItemQuantities("Prepare me a purchase order for 50kg rice");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ quantity: 50, unitText: "kg" });
  });

  it("parses 'N bottles' with a space", () => {
    const matches = parseItemQuantities("Pull 5 bottles of tonic to the bar");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ quantity: 5, unitText: "bottles" });
  });

  it("parses multiple quantities in one message, preserving order", () => {
    const matches = parseItemQuantities("3kg beef and 4kg rice");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ quantity: 3, unitText: "kg" });
    expect(matches[1]).toMatchObject({ quantity: 4, unitText: "kg" });
  });

  it("parses mixed units in one message", () => {
    const matches = parseItemQuantities("20 cartons of Coca-Cola and 3kg beef");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ quantity: 20, unitText: "cartons" });
    expect(matches[1]).toMatchObject({ quantity: 3, unitText: "kg" });
  });

  it("does not treat a number followed by a non-unit word as a quantity", () => {
    const matches = parseItemQuantities(
      "How much chicken will we need for 40 lunch guests tomorrow?",
    );
    expect(matches).toHaveLength(0);
  });

  it("returns nothing for text with no numbers", () => {
    expect(parseItemQuantities("Approve the purchase order")).toHaveLength(0);
  });
});

describe("parseGuestCount", () => {
  it("recognizes a guest count with an intervening descriptor word", () => {
    const result = parseGuestCount("How much chicken will we need for 40 lunch guests tomorrow?");
    expect(result).toEqual({ raw: "40 lunch guests", count: 40 });
  });

  it("recognizes a bare guest count", () => {
    expect(parseGuestCount("we have 25 guests tonight")).toMatchObject({ count: 25 });
  });

  it("recognizes 'covers' and 'pax'", () => {
    expect(parseGuestCount("expecting 60 covers")).toMatchObject({ count: 60 });
    expect(parseGuestCount("30 pax booked")).toMatchObject({ count: 30 });
  });

  it("returns null when there is no guest-count phrase", () => {
    expect(parseGuestCount("3kg beef and 4kg rice")).toBeNull();
  });

  it("never confuses an item quantity with a guest count", () => {
    expect(parseGuestCount("Pull 5 bottles of tonic to the bar")).toBeNull();
  });
});

describe("resolveUnitId", () => {
  const units = [
    { id: "u1", code: "kg", name: "Kilogram" },
    { id: "u2", code: "btl", name: "Bottle" },
  ];

  it("resolves by exact code, case-insensitively", () => {
    expect(resolveUnitId("KG", units)).toBe("u1");
  });

  it("resolves by exact name, case-insensitively", () => {
    expect(resolveUnitId("bottle", units)).toBe("u2");
  });

  it("never guesses a fuzzy match — returns null for an unrecognized unit word", () => {
    expect(resolveUnitId("cartons", units)).toBeNull();
  });

  it("returns null for empty unit text", () => {
    expect(resolveUnitId("", units)).toBeNull();
  });
});
