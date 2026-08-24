import { describe, expect, it } from "vitest";
import { addPosLinesSchema, posLineSchema } from "./pos.contracts";
import { addOrderItemsSchema } from "../core/contracts";

/**
 * Regression coverage for GitHub issue #3: a live UAT screenshot showed
 * `addPosLinesFn` rejecting a Bar POS line with
 * `{"code":"unrecognized_keys","keys":["discount"],"path":["lines",0]}`.
 *
 * Root cause investigation (this same issue) found that `discount` has been
 * declared in both `posLineSchema` (this file) and `orderLineSchema`
 * (core/contracts.ts) since the single commit that created this repository,
 * and neither schema is `.strict()` — zod's default `z.object()` mode
 * silently strips unrecognized keys rather than erroring, so the checked-in
 * validator cannot produce that error for any payload shape. These tests
 * pin that behavior so a future change cannot silently reintroduce a
 * discount-rejecting boundary. If the live/preview environment still
 * reproduces the screenshot's error after this passes, the mismatch is a
 * deployment/build-freshness issue outside this source tree, not a schema
 * defect — see the issue thread for that finding.
 */
describe("addPosLinesSchema — the exact validator addPosLinesFn parses with", () => {
  const basePayload = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    orderId: "22222222-2222-2222-2222-222222222222",
    lines: [
      {
        menuItemId: "33333333-3333-3333-3333-333333333333",
        description: "UAT bar POS drink",
        quantity: 1,
        unitPrice: 8000,
        discount: 0,
        modifiers: [],
      },
    ],
  };

  it("SCREENSHOT REPRODUCTION: accepts the exact Bar POS payload (discount: 0) that the live UAT screenshot showed rejected", () => {
    const result = addPosLinesSchema.safeParse(basePayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lines[0]?.discount).toBe(0);
    }
  });

  it("a line with no discount field at all still defaults to 0, never rejected", () => {
    const { discount: _discount, ...lineWithoutDiscount } = basePayload.lines[0];
    const result = addPosLinesSchema.safeParse({ ...basePayload, lines: [lineWithoutDiscount] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lines[0]?.discount).toBe(0);
  });

  it("a genuine, meaningful discount is still accepted — this fix does not remove discount functionality", () => {
    const result = addPosLinesSchema.safeParse({
      ...basePayload,
      lines: [{ ...basePayload.lines[0], discount: 1500 }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lines[0]?.discount).toBe(1500);
  });

  it("a negative discount is still rejected — validation was not weakened to hide the bug", () => {
    const result = addPosLinesSchema.safeParse({
      ...basePayload,
      lines: [{ ...basePayload.lines[0], discount: -5 }],
    });
    expect(result.success).toBe(false);
  });

  it("a genuinely unknown key on a line is silently stripped, not rejected (confirms non-strict z.object() mode)", () => {
    const result = addPosLinesSchema.safeParse({
      ...basePayload,
      lines: [{ ...basePayload.lines[0], someFieldThatDoesNotExist: 123 }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("someFieldThatDoesNotExist" in result.data.lines[0]).toBe(false);
    }
  });

  it("posLineSchema itself (the per-line schema) accepts discount: 0 in isolation", () => {
    expect(posLineSchema.safeParse(basePayload.lines[0]).success).toBe(true);
  });
});

describe("addOrderItemsSchema — the admin order pad / room charge entry point into insertLines", () => {
  it("also accepts discount: 0, matching the POS path so both entry points agree", () => {
    const result = addOrderItemsSchema.safeParse({
      tenantId: "11111111-1111-1111-1111-111111111111",
      orderId: "22222222-2222-2222-2222-222222222222",
      lines: [
        {
          menuItemId: "33333333-3333-3333-3333-333333333333",
          description: "UAT grill food",
          quantity: 1,
          unitPrice: 15000,
          discount: 0,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
