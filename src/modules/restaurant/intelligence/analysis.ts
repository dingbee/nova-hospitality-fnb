/**
 * Pure, inspectable maths for Restaurant Intelligence. No I/O, no AI.
 * Every number shown in the UI can be traced back to one of these helpers.
 */
import type { MenuClass } from "./types";

export const round = (n: number, dp = 2): number => Number(n.toFixed(dp));

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? 100 : null;
  return round(((current - previous) / previous) * 100, 1);
}

/** Menu-engineering quadrant: popularity (volume) × profitability (margin). */
export function classifyMenuItem(
  quantity: number,
  marginPercent: number | null,
  medianQuantity: number,
  medianMargin: number,
): MenuClass {
  if (quantity <= 0) return "unsold";
  const popular = quantity >= medianQuantity;
  const profitable = (marginPercent ?? 0) >= medianMargin;
  if (popular && profitable) return "star";
  if (popular && !profitable) return "plough_horse";
  if (!popular && profitable) return "puzzle";
  return "dog";
}

/** Days of stock remaining at the observed consumption velocity. */
export function daysOfCover(quantity: number, dailyVelocity: number): number | null {
  if (dailyVelocity <= 0) return null;
  return round(quantity / dailyVelocity, 1);
}

/**
 * Purchase quantity that covers lead time plus a safety window, minus what is
 * already on hand. Rounded up so orders are placed in whole units.
 */
export function recommendedPurchaseQuantity(
  currentQuantity: number,
  dailyVelocity: number,
  leadTimeDays: number,
  coverDays: number,
): number {
  const need = dailyVelocity * (leadTimeDays + coverDays) - currentQuantity;
  return need <= 0 ? 0 : Math.ceil(need);
}

/** 0..100 blend of delivery punctuality and lead-time accuracy. */
export function reliabilityScore(
  onTimePercent: number | null,
  averageLeadTimeDays: number | null,
  declaredLeadTimeDays: number | null,
): number {
  const punctuality = onTimePercent ?? 50;
  if (averageLeadTimeDays == null || declaredLeadTimeDays == null || declaredLeadTimeDays <= 0) {
    return round(punctuality, 0);
  }
  const drift = Math.abs(averageLeadTimeDays - declaredLeadTimeDays) / declaredLeadTimeDays;
  const accuracy = Math.max(0, 100 - drift * 100);
  return round(punctuality * 0.7 + accuracy * 0.3, 0);
}