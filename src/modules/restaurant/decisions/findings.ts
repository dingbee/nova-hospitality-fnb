/**
 * Phase 4 — Finding → Prediction.
 *
 * Pure translation of Phase 3 intelligence output into decision candidates.
 * Every prediction here is a straight-line projection of an observed rate:
 * no model, no AI, fully reproducible from the same inputs.
 */
import { round } from "../intelligence/analysis";
import type {
  InventoryIntelligence,
  KitchenIntelligence,
  MenuIntelligence,
  PurchasingIntelligence,
} from "../intelligence/types";
import type { RestaurantFinding } from "./decision.types";

const MARGIN_DECLINE_PERCENT = 10;
const SHORTAGE_DAYS = 4;
const WASTAGE_SPIKE_PERCENT = 15;
const KITCHEN_OVER_TARGET_PERCENT = 20;
const SPEND_JUMP_PERCENT = 12;

const money = (currency: string, n: number) => `${currency} ${Math.round(n).toLocaleString()}`;

/* ------------------------------ menu ------------------------------ */

export function menuFindings(m: MenuIntelligence): RestaurantFinding[] {
  const out: RestaurantFinding[] = [];

  // Dishes that sell but lose margin, or whose volume is collapsing.
  const candidates = [...m.marginLosers, ...m.declining, ...m.costReview]
    .filter((i, idx, arr) => arr.findIndex((x) => x.menuItemId === i.menuItemId) === idx)
    .filter((i) => i.quantitySold > 0)
    .sort((a, b) => (a.marginPercent ?? 100) - (b.marginPercent ?? 100))
    .slice(0, 5);

  for (const item of candidates) {
    const trend = item.trendPercent;
    const margin = item.marginPercent;
    const dailyGp = m.windowDays > 0 ? item.grossProfit / m.windowDays : 0;
    const projected = round(dailyGp * 30, 2);
    const declining = trend != null && trend <= -MARGIN_DECLINE_PERCENT;

    out.push({
      key: `finding.menu.${item.menuItemId}`,
      kind: "menu_margin",
      severity: margin != null && margin < 50 ? "high" : "medium",
      subject: item.name,
      headline: declining
        ? `${item.name} margin and volume are both under pressure`
        : `${item.name} sells but does not carry its margin`,
      detail: [
        `${item.quantitySold} sold in the last ${m.windowDays} days`,
        margin != null ? `${margin}% gross margin` : "margin unknown",
        item.foodCostPercent != null ? `${item.foodCostPercent}% food cost` : null,
        trend != null ? `volume ${trend > 0 ? "+" : ""}${trend}% vs prior window` : null,
        item.costReviewReason,
      ]
        .filter(Boolean)
        .join(" · "),
      metric: margin != null ? `${margin}% margin` : null,
      evidence: [
        { label: "Revenue", value: money(m.currency, item.revenue) },
        { label: "Actual cost", value: money(m.currency, item.cost) },
        { label: "Gross profit", value: money(m.currency, item.grossProfit) },
        { label: "Classification", value: item.classification },
        ...(item.price != null ? [{ label: "Menu price", value: money(m.currency, item.price) }] : []),
        ...(item.costReviewReason ? [{ label: "Cost review", value: item.costReviewReason }] : []),
      ],
      prediction: {
        key: `prediction.menu.${item.menuItemId}`,
        statement: `At the current rate this dish contributes about ${money(m.currency, projected)} gross profit over the next 30 days${declining ? `, and volume is falling ${Math.abs(trend ?? 0)}% window on window` : ""}.`,
        value: projected,
        unit: ` ${m.currency}`,
        horizonDays: 30,
        confidence: item.quantitySold >= 20 ? 0.7 : 0.5,
        direction: declining ? "down" : margin != null && margin < 55 ? "down" : "flat",
      },
      facts: {
        classification: item.classification,
        marginPercent: margin,
        foodCostPercent: item.foodCostPercent,
        trendPercent: trend,
        quantitySold: item.quantitySold,
        needsCostReview: item.needsCostReview,
        isStar: item.classification === "star",
        isDog: item.classification === "dog",
        highVolume: item.quantitySold >= Math.max(10, m.totals.itemsSold * 0.05),
      },
    });
  }

  return out;
}

/* ---------------------------- inventory ---------------------------- */

export function inventoryFindings(inv: InventoryIntelligence): RestaurantFinding[] {
  const out: RestaurantFinding[] = [];

  for (const row of inv.atRisk.filter((r) => r.daysOfCover != null && r.daysOfCover <= SHORTAGE_DAYS).slice(0, 5)) {
    const days = row.daysOfCover as number;
    out.push({
      key: `finding.inventory.${row.inventoryItemId}`,
      kind: "inventory_shortage",
      severity: days <= 1 ? "critical" : days <= 2 ? "high" : "medium",
      subject: row.name,
      headline: `${row.name} is forecast to run out in ${days} day${days === 1 ? "" : "s"}`,
      detail: `${row.currentQuantity} on hand against ${row.dailyVelocity}/day consumption${row.belowReorder ? ", already below the reorder point" : ""}.`,
      metric: `${days} days of cover`,
      evidence: [
        { label: "On hand", value: String(row.currentQuantity) },
        { label: "Daily consumption", value: `${row.dailyVelocity}/day` },
        ...(row.reorderPoint != null ? [{ label: "Reorder point", value: String(row.reorderPoint) }] : []),
      ],
      prediction: {
        key: `prediction.inventory.${row.inventoryItemId}`,
        statement: `Stock reaches zero in about ${days} day${days === 1 ? "" : "s"} if consumption holds at ${row.dailyVelocity}/day.`,
        value: days,
        unit: " days",
        horizonDays: Math.max(1, Math.ceil(days)),
        confidence: row.dailyVelocity > 0 ? 0.75 : 0.45,
        direction: "down",
      },
      facts: {
        daysOfCover: days,
        belowReorder: row.belowReorder,
        urgent: days <= 2,
        velocity: row.dailyVelocity,
      },
    });
  }

  const wasteChange = inv.wastage.changePercent;
  if (wasteChange != null && wasteChange >= WASTAGE_SPIKE_PERCENT && inv.wastage.currentCost > 0) {
    out.push({
      key: "finding.inventory.wastage",
      kind: "wastage_spike",
      severity: wasteChange >= 40 ? "high" : "medium",
      subject: "Kitchen wastage",
      headline: `Wastage rose ${wasteChange}% against the previous window`,
      detail: `${money(inv.currency, inv.wastage.currentCost)} written off versus ${money(inv.currency, inv.wastage.previousCost)}. Largest contributors: ${inv.wastage.topItems.map((t) => t.name).slice(0, 3).join(", ") || "not attributed"}.`,
      metric: `+${wasteChange}%`,
      evidence: [
        { label: "Wastage this window", value: money(inv.currency, inv.wastage.currentCost) },
        { label: "Previous window", value: money(inv.currency, inv.wastage.previousCost) },
        ...inv.wastage.topItems.slice(0, 3).map((t) => ({
          label: t.name,
          value: `${t.quantity} · ${money(inv.currency, t.cost)}`,
        })),
      ],
      prediction: {
        key: "prediction.inventory.wastage",
        statement: `If the trend holds, wastage costs roughly ${money(inv.currency, (inv.wastage.currentCost / inv.windowDays) * 30)} over the next 30 days.`,
        value: round((inv.wastage.currentCost / Math.max(1, inv.windowDays)) * 30, 2),
        unit: ` ${inv.currency}`,
        horizonDays: 30,
        confidence: 0.6,
        direction: "up",
      },
      facts: { changePercent: wasteChange, cost: inv.wastage.currentCost },
    });
  }

  for (const threat of inv.priceThreats.slice(0, 3)) {
    out.push({
      key: `finding.inventory.price.${threat.supplierName}.${threat.itemName}`.toLowerCase().replace(/\s+/g, "_"),
      kind: "supplier_risk",
      severity: threat.increasePercent >= 25 ? "high" : "medium",
      subject: `${threat.itemName} — ${threat.supplierName}`,
      headline: `${threat.supplierName} is quoting ${threat.increasePercent}% above our average cost for ${threat.itemName}`,
      detail: `Quoted ${money(inv.currency, threat.supplierPrice)} against a weighted average cost of ${money(inv.currency, threat.averageCost)}.`,
      metric: `+${threat.increasePercent}%`,
      evidence: [
        { label: "Supplier price", value: money(inv.currency, threat.supplierPrice) },
        { label: "Average cost", value: money(inv.currency, threat.averageCost) },
      ],
      prediction: {
        key: `prediction.supplier.${threat.itemName}`.toLowerCase().replace(/\s+/g, "_"),
        statement: `Accepting this price lifts the landed cost of ${threat.itemName} by ${threat.increasePercent}% and compresses margin on every dish that uses it.`,
        value: threat.increasePercent,
        unit: "%",
        horizonDays: 30,
        confidence: 0.65,
        direction: "up",
      },
      facts: { increasePercent: threat.increasePercent, hasAlternative: true },
    });
  }

  return out;
}

/* ----------------------------- kitchen ----------------------------- */

export function kitchenFindings(k: KitchenIntelligence): RestaurantFinding[] {
  const out: RestaurantFinding[] = [];

  for (const s of k.stations.filter((x) => x.overTarget || (x.delayedPercent ?? 0) >= 20).slice(0, 3)) {
    const over =
      s.targetMinutes && s.averagePrepMinutes
        ? round(((s.averagePrepMinutes - s.targetMinutes) / s.targetMinutes) * 100, 1)
        : null;
    out.push({
      key: `finding.kitchen.${s.stationId}`,
      kind: "kitchen_capacity",
      severity: (over ?? 0) >= KITCHEN_OVER_TARGET_PERCENT || (s.delayedPercent ?? 0) >= 35 ? "high" : "medium",
      subject: s.name,
      headline:
        s.dinnerPeakMinutes != null && s.averagePrepMinutes != null && s.dinnerPeakMinutes > s.averagePrepMinutes
          ? `${s.name} exceeds acceptable preparation time during dinner peak`
          : `${s.name} is running over its preparation target`,
      detail: [
        `${s.tickets} tickets analysed`,
        s.averagePrepMinutes != null ? `${s.averagePrepMinutes} min average` : null,
        s.targetMinutes != null ? `${s.targetMinutes} min target` : null,
        s.dinnerPeakMinutes != null ? `${s.dinnerPeakMinutes} min at dinner peak` : null,
        s.delayedPercent != null ? `${s.delayedPercent}% delayed` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      metric: over != null ? `${over > 0 ? "+" : ""}${over}% vs target` : `${s.delayedPercent ?? 0}% delayed`,
      evidence: [
        { label: "Tickets", value: String(s.tickets) },
        ...(s.averagePrepMinutes != null ? [{ label: "Average prep", value: `${s.averagePrepMinutes} min` }] : []),
        ...(s.peakPrepMinutes != null ? [{ label: "Peak prep", value: `${s.peakPrepMinutes} min` }] : []),
        ...(s.targetMinutes != null ? [{ label: "Target", value: `${s.targetMinutes} min` }] : []),
        { label: "Delayed tickets", value: `${s.delayedTickets}` },
      ],
      prediction: {
        key: `prediction.kitchen.${s.stationId}`,
        statement: `Without a change, ${s.name} keeps ticket times around ${s.dinnerPeakMinutes ?? s.averagePrepMinutes ?? "—"} minutes at dinner peak, and roughly ${s.delayedPercent ?? 0}% of its tickets stay late.`,
        value: s.dinnerPeakMinutes ?? s.averagePrepMinutes,
        unit: " min",
        horizonDays: 14,
        confidence: s.tickets >= 30 ? 0.7 : 0.5,
        direction: (k.trendPercent ?? 0) > 0 ? "up" : "flat",
      },
      facts: {
        overTargetPercent: over,
        delayedPercent: s.delayedPercent,
        tickets: s.tickets,
        dinnerPeak: s.dinnerPeakMinutes != null,
        lowVolume: s.tickets < 30,
      },
    });
  }

  return out;
}

/* ---------------------------- purchasing ---------------------------- */

export function purchasingFindings(p: PurchasingIntelligence): RestaurantFinding[] {
  const out: RestaurantFinding[] = [];

  const top = p.suggestions.slice(0, 3);
  for (const s of top) {
    const weak = p.suppliers.find((x) => x.supplierId === s.supplierId && x.score < 60);
    out.push({
      key: `finding.purchasing.${s.inventoryItemId}`,
      kind: "purchasing_replenishment",
      severity: weak ? "high" : "medium",
      subject: s.name,
      headline: `${s.name} needs a replenishment order of about ${s.recommendedQuantity}`,
      detail: `${s.dailyVelocity}/day consumption, ${s.leadTimeDays} day lead time plus ${s.coverDays} days cover${s.supplierName ? ` · preferred supplier ${s.supplierName}` : " · no supplier product on file"}${weak ? ` (reliability score ${weak.score}/100)` : ""}.`,
      metric: money(p.currency, s.estimatedCost),
      evidence: [
        { label: "On hand", value: String(s.currentQuantity) },
        { label: "Recommended quantity", value: String(s.recommendedQuantity) },
        { label: "Estimated cost", value: money(p.currency, s.estimatedCost) },
        { label: "Supplier", value: s.supplierName ?? "none on file" },
        ...(weak ? [{ label: "Supplier reliability", value: `${weak.score}/100` }] : []),
      ],
      prediction: {
        key: `prediction.purchasing.${s.inventoryItemId}`,
        statement: `Ordering ${s.recommendedQuantity} covers demand through the ${s.leadTimeDays}-day lead time; skipping it risks a stockout inside ${Math.max(1, Math.round(s.currentQuantity / Math.max(0.01, s.dailyVelocity)))} days.`,
        value: s.estimatedCost,
        unit: ` ${p.currency}`,
        horizonDays: s.leadTimeDays + s.coverDays,
        confidence: s.dailyVelocity > 0 ? 0.7 : 0.45,
        direction: "flat",
      },
      facts: {
        hasSupplier: Boolean(s.supplierId),
        unreliableSupplier: Boolean(weak),
        estimatedCost: s.estimatedCost,
        leadTimeDays: s.leadTimeDays,
      },
    });
  }

  if (p.spendChangePercent != null && p.spendChangePercent >= SPEND_JUMP_PERCENT) {
    out.push({
      key: "finding.purchasing.spend",
      kind: "purchasing_replenishment",
      severity: p.spendChangePercent >= 30 ? "high" : "medium",
      subject: "Monthly purchasing spend",
      headline: `Expected purchasing spend is ${p.spendChangePercent}% above last month`,
      detail: `${money(p.currency, p.expectedMonthlySpend)} projected against ${money(p.currency, p.previousMonthlySpend)} previously.`,
      metric: `+${p.spendChangePercent}%`,
      evidence: [
        { label: "Projected spend", value: money(p.currency, p.expectedMonthlySpend) },
        { label: "Previous month", value: money(p.currency, p.previousMonthlySpend) },
      ],
      prediction: {
        key: "prediction.purchasing.spend",
        statement: `Purchasing spend lands near ${money(p.currency, p.expectedMonthlySpend)} next month at current consumption and prices.`,
        value: p.expectedMonthlySpend,
        unit: ` ${p.currency}`,
        horizonDays: 30,
        confidence: 0.6,
        direction: "up",
      },
      facts: { spendChangePercent: p.spendChangePercent, hasSupplier: true },
    });
  }

  return out;
}

export function gatherFindings(input: {
  menu: MenuIntelligence;
  inventory: InventoryIntelligence;
  kitchen: KitchenIntelligence;
  purchasing: PurchasingIntelligence;
}): RestaurantFinding[] {
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
  return [
    ...inventoryFindings(input.inventory),
    ...menuFindings(input.menu),
    ...kitchenFindings(input.kitchen),
    ...purchasingFindings(input.purchasing),
  ].sort((a, b) =>
    severityRank[a.severity] !== severityRank[b.severity]
      ? severityRank[a.severity] - severityRank[b.severity]
      : a.key.localeCompare(b.key),
  );
}