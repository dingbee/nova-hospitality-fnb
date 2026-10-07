import { describe, expect, it } from "vitest";
import {
  defaultGuestPaymentTimingForOperatingMode,
  isSettledPaymentState,
  resolveGuestPaymentTiming,
} from "./payment-timing";

describe("guest payment timing policy", () => {
  it("maps quick/counter service to pay-first and table/bar service to pay-after-service", () => {
    expect(defaultGuestPaymentTimingForOperatingMode("quick_service")).toBe("pay_first");
    expect(defaultGuestPaymentTimingForOperatingMode("counter_service")).toBe("pay_first");
    expect(defaultGuestPaymentTimingForOperatingMode("table_service")).toBe("pay_after_service");
    expect(defaultGuestPaymentTimingForOperatingMode("bar_service")).toBe("pay_after_service");
  });

  it("honors an explicit tenant override", () => {
    expect(
      resolveGuestPaymentTiming({
        onboarding: { operatingMode: "table_service" },
        payment: { guestTiming: "pay_first" },
      }),
    ).toBe("pay_first");
    expect(
      resolveGuestPaymentTiming({
        onboarding: { operatingMode: "quick_service" },
        payment: { guestTiming: "pay_after_service" },
      }),
    ).toBe("pay_after_service");
  });

  it("falls back to operating model for automatic/invalid configuration", () => {
    expect(
      resolveGuestPaymentTiming({
        onboarding: { operatingMode: "quick_service" },
        payment: { guestTiming: "auto" },
      }),
    ).toBe("pay_first");
    expect(
      resolveGuestPaymentTiming({
        onboarding: { operatingMode: "table_service" },
        payment: { guestTiming: "invalid" },
      }),
    ).toBe("pay_after_service");
  });

  it("recognizes only settled payment states as paid-for-production", () => {
    expect(isSettledPaymentState("paid")).toBe(true);
    expect(isSettledPaymentState("comped")).toBe(true);
    expect(isSettledPaymentState("room_charged")).toBe(true);
    expect(isSettledPaymentState("partially_paid")).toBe(false);
    expect(isSettledPaymentState("unpaid")).toBe(false);
  });
});
