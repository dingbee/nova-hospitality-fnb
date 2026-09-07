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

/**
 * P03 §22 — invoice ageing. Purely computed from `dueDate`, exactly the
 * same "computed at read-time, never a stored/scheduled transition"
 * discipline P02 already applies to the `overdue` flag (this codebase has
 * no job scheduler). A null `dueDate` (never issued) or a due date not yet
 * passed is "current" with zero days overdue.
 */
export type AgeingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export function ageingFor(
  dueDate: string | Date | null,
  today: Date = new Date(),
): { bucket: AgeingBucket; daysOverdue: number } {
  if (!dueDate) return { bucket: "current", daysOverdue: 0 };
  const due = typeof dueDate === "string" ? new Date(`${dueDate}T00:00:00Z`) : dueDate;
  const daysOverdue = Math.floor((today.getTime() - due.getTime()) / 86400000);
  if (daysOverdue <= 0) return { bucket: "current", daysOverdue: 0 };
  if (daysOverdue <= 30) return { bucket: "1-30", daysOverdue };
  if (daysOverdue <= 60) return { bucket: "31-60", daysOverdue };
  if (daysOverdue <= 90) return { bucket: "61-90", daysOverdue };
  return { bucket: "90+", daysOverdue };
}
