/**
 * Guest payment timing policy.
 *
 * This is deliberately a small, pure policy layer. The existing tenant
 * operating model remains the default authority; an explicit payment
 * preference can override it without creating a second service model.
 *
 * - table_service / bar_service -> pay after service
 * - counter_service / quick_service -> pay first
 * - explicit settings.payment.guestTiming -> operator override
 */

export const GUEST_PAYMENT_TIMINGS = ["pay_first", "pay_after_service"] as const;
export type GuestPaymentTiming = (typeof GUEST_PAYMENT_TIMINGS)[number];

export const GUEST_PAYMENT_TIMING_SETTINGS = ["auto", ...GUEST_PAYMENT_TIMINGS] as const;
export type GuestPaymentTimingSetting = (typeof GUEST_PAYMENT_TIMING_SETTINGS)[number];

const QUICK_SERVICE_MODES = new Set(["counter_service", "quick_service"]);

export function defaultGuestPaymentTimingForOperatingMode(
  operatingMode: unknown,
): GuestPaymentTiming {
  return QUICK_SERVICE_MODES.has(String(operatingMode ?? "")) ? "pay_first" : "pay_after_service";
}

export function resolveGuestPaymentTiming(settings: unknown): GuestPaymentTiming {
  const root = (settings ?? {}) as {
    payment?: { guestTiming?: unknown };
    onboarding?: { operatingMode?: unknown };
  };
  const configured = root.payment?.guestTiming;
  if (configured === "pay_first" || configured === "pay_after_service") {
    return configured;
  }
  return defaultGuestPaymentTimingForOperatingMode(root.onboarding?.operatingMode);
}

export function isSettledPaymentState(paymentState: unknown): boolean {
  return ["paid", "comped", "room_charged"].includes(String(paymentState ?? ""));
}
