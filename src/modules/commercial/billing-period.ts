/**
 * P02 — pure billing-period / proration math. Browser-safe, no I/O, so it
 * can be unit tested directly against date boundaries (leap years, month-end
 * overflow, annual periods) without a database.
 *
 * `restaurant_subscriptions` does not track a running "current period
 * start" column — only `current_period_end` exists, and it is not written
 * to by anything yet. Rather than add a second period-tracking column,
 * the current billing period is computed analytically from the agreement's
 * `effective_from` anchor: the Nth monthly/annual interval since that
 * anchor that contains `now`. This is deterministic and reproducible from
 * data that already exists, and is exactly the "computed, not fabricated"
 * discipline used elsewhere in this codebase's commercial engine.
 */

export interface BillingPeriod {
  start: Date;
  end: Date;
}

function addInterval(d: Date, interval: "monthly" | "annual" | "custom", n: number): Date {
  const r = new Date(d.getTime());
  if (interval === "annual") r.setUTCFullYear(r.getUTCFullYear() + n);
  else r.setUTCMonth(r.getUTCMonth() + n);
  return r;
}

/**
 * The billing period (half-open [start, end)) containing `now`, anchored at
 * `effectiveFrom`. `custom` intervals fall back to monthly framing — there
 * is no configured cadence to derive a period from otherwise.
 */
export function currentBillingPeriod(
  effectiveFrom: Date,
  billingInterval: "monthly" | "annual" | "custom",
  now: Date = new Date(),
): BillingPeriod {
  const cadence = billingInterval === "annual" ? "annual" : "monthly";
  if (now.getTime() <= effectiveFrom.getTime()) {
    return { start: effectiveFrom, end: addInterval(effectiveFrom, cadence, 1) };
  }
  // Binary-search-free linear walk is fine here: periods are months/years,
  // so even a multi-decade-old agreement is at most a few hundred steps.
  let start = effectiveFrom;
  let end = addInterval(effectiveFrom, cadence, 1);
  let guard = 0;
  while (end.getTime() <= now.getTime() && guard < 2400) {
    start = end;
    end = addInterval(start, cadence, 1);
    guard++;
  }
  return { start, end };
}

/**
 * Fraction of `amount` attributable to the remainder of the period
 * [chargeDate, periodEnd) out of the full [periodStart, periodEnd) span,
 * rounded to 2dp. A charge dated on or after periodEnd, or on/before
 * periodStart, returns the full amount (nothing to prorate).
 */
export function prorateForRemainderOfPeriod(
  amount: number,
  period: BillingPeriod,
  chargeDate: Date,
): number {
  const totalMs = period.end.getTime() - period.start.getTime();
  if (totalMs <= 0) return amount;
  const remainingMs = period.end.getTime() - chargeDate.getTime();
  if (remainingMs >= totalMs) return Math.round(amount * 100) / 100;
  if (remainingMs <= 0) return 0;
  const fraction = remainingMs / totalMs;
  return Math.round(amount * fraction * 100) / 100;
}
