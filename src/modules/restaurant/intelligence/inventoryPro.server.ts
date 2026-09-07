/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P05 §6 — Inventory Intelligence (Pro).
 *
 * Extends, never duplicates, the existing free `getInventoryIntelligence`
 * (stock runway, wastage trend, supplier price threats — Sprint 3.2,
 * unchanged and still used ungated by the Decisions engine and the
 * existing Insights page). This file adds the genuinely new, Pro-gated
 * layer the master prompt asks for on top of it:
 *
 *  - Abnormal-consumption anomaly detection: an item whose consumption
 *    velocity this window deviates sharply from the window before it.
 *  - Reorder-requirement explainability: for each at-risk item, the actual
 *    recommended purchase quantity — read verbatim from
 *    purchasing.server.ts's own forecast, never recomputed here.
 *  - Data-sufficiency banding for the runway numbers as a whole.
 *
 * Gated on "inventory_intelligence" — Core keeps the free baseline
 * (getInventoryIntelligence) exactly as it ships today; only this
 * additive Pro layer is entitlement-checked.
 */
import { assertTenantRead } from "../core/access.server";
import { getInventoryIntelligence } from "./inventory.server";
import { getPurchasingIntelligence } from "./purchasing.server";
import { percentChange, round } from "./analysis";
import { assessDataSufficiency, type DataSufficiency } from "./sufficiency";
import type { RestaurantInsight } from "./types";
import type { P05WindowInput } from "./p05.types";

type Sb = any;
const DAY = 864e5;
const ANOMALY_THRESHOLD_PERCENT = 60;

export interface ConsumptionAnomaly {
  inventoryItemId: string;
  name: string;
  currentVelocity: number;
  previousVelocity: number;
  changePercent: number | null;
  direction: "spike" | "drop";
}

export interface ReorderRequirement {
  inventoryItemId: string;
  name: string;
  daysOfCover: number | null;
  recommendedQuantity: number | null;
  estimatedCost: number | null;
  supplierName: string | null;
  leadTimeDays: number | null;
}

export interface InventoryIntelligencePro {
  generatedAt: string;
  windowDays: number;
  currency: string;
  sufficiency: DataSufficiency;
  sufficiencyReasons: string[];
  anomalies: ConsumptionAnomaly[];
  reorderRequirements: ReorderRequirement[];
  insights: RestaurantInsight[];
}

export async function getInventoryIntelligencePro(
  sb: Sb,
  userId: string,
  input: P05WindowInput,
): Promise<InventoryIntelligencePro> {
  const { tenantId, windowDays } = input;
  await assertTenantRead(sb, userId, tenantId, {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });
  const { assertEntitled } = await import("@/modules/commercial/resolver.server");
  await assertEntitled(sb, tenantId, "inventory_intelligence", {
    propertyId: input.propertyId ?? null,
  });

  const scoped = {
    tenantId,
    windowDays,
    propertyId: input.propertyId ?? undefined,
    locationId: input.locationId ?? undefined,
  };
  const [base, purchasing] = await Promise.all([
    getInventoryIntelligence(sb, userId, scoped),
    getPurchasingIntelligence(sb, userId, scoped),
  ]);

  const now = Date.now();
  const prevStart = new Date(now - windowDays * 2 * DAY).toISOString();
  const windowBoundary = new Date(now - windowDays * DAY).toISOString();

  let movesQuery = sb
    .from("restaurant_stock_movements")
    .select("inventory_item_id, movement_type, quantity, occurred_at")
    .eq("tenant_id", tenantId)
    .gte("occurred_at", prevStart)
    .lt("occurred_at", windowBoundary);
  if (input.propertyId) movesQuery = movesQuery.eq("property_id", input.propertyId);
  if (input.locationId) movesQuery = movesQuery.eq("location_id", input.locationId);
  const { data: prevMoves } = await movesQuery;

  const prevConsumption = new Map<string, number>();
  for (const m of (prevMoves ?? []) as any[]) {
    if (m.movement_type !== "consumption" && m.movement_type !== "wastage") continue;
    prevConsumption.set(
      m.inventory_item_id,
      (prevConsumption.get(m.inventory_item_id) ?? 0) + Math.abs(Number(m.quantity ?? 0)),
    );
  }

  const nameById = new Map(base.runway.map((r) => [r.inventoryItemId, r.name]));
  const anomalies: ConsumptionAnomaly[] = [];
  for (const row of base.runway) {
    const previousVelocity = round((prevConsumption.get(row.inventoryItemId) ?? 0) / windowDays, 3);
    if (row.dailyVelocity === 0 && previousVelocity === 0) continue;
    const changePercent = percentChange(row.dailyVelocity, previousVelocity);
    if (changePercent == null || Math.abs(changePercent) < ANOMALY_THRESHOLD_PERCENT) continue;
    anomalies.push({
      inventoryItemId: row.inventoryItemId,
      name: row.name,
      currentVelocity: row.dailyVelocity,
      previousVelocity,
      changePercent,
      direction: changePercent > 0 ? "spike" : "drop",
    });
  }
  anomalies.sort((a, b) => Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0));

  const suggestionByName = new Map(purchasing.suggestions.map((s) => [s.name, s]));
  const reorderRequirements: ReorderRequirement[] = base.atRisk.map((r) => {
    const suggestion = suggestionByName.get(r.name);
    return {
      inventoryItemId: r.inventoryItemId,
      name: r.name,
      daysOfCover: r.daysOfCover,
      recommendedQuantity: suggestion?.recommendedQuantity ?? null,
      estimatedCost: suggestion?.estimatedCost ?? null,
      supplierName: suggestion?.supplierName ?? null,
      leadTimeDays: suggestion?.leadTimeDays ?? null,
    };
  });

  const totalConsumptionSamples = base.runway.filter((r) => r.dailyVelocity > 0).length;
  const sufficiency = assessDataSufficiency(totalConsumptionSamples, Math.min(windowDays, 30));

  const insights: RestaurantInsight[] = [];
  for (const a of anomalies.slice(0, 4)) {
    insights.push({
      key: `inventory_pro.anomaly.${a.inventoryItemId}`,
      severity: Math.abs(a.changePercent ?? 0) >= 100 ? "high" : "medium",
      title: `${a.name}'s consumption ${a.direction === "spike" ? "spiked" : "dropped"} ${Math.abs(a.changePercent ?? 0)}%`,
      detail: `${a.currentVelocity}/day this window versus ${a.previousVelocity}/day the window before.`,
      metric: `${a.changePercent != null && a.changePercent > 0 ? "+" : ""}${a.changePercent}%`,
      recommendation:
        a.direction === "spike"
          ? "Confirm this reflects real demand and not waste, theft, or a recipe change before reordering at the new rate."
          : "Confirm this reflects reduced demand and not a stockout or a menu change before cutting orders.",
    });
  }
  for (const req of reorderRequirements.slice(0, 3)) {
    if (req.recommendedQuantity == null) continue;
    insights.push({
      key: `inventory_pro.reorder.${req.inventoryItemId}`,
      severity: "medium",
      title: `${req.name} needs ${req.recommendedQuantity} unit(s) to stay covered`,
      detail: `Forecast-driven requirement covering lead time plus a safety window${req.supplierName ? ` from ${req.supplierName}` : ""}.`,
      metric:
        req.estimatedCost != null
          ? `${base.currency} ${round(req.estimatedCost).toLocaleString()}`
          : undefined,
      recommendation: "Raise the purchase request from Purchasing Intelligence to act on this.",
    });
  }
  if (sufficiency.state === "NO_DATA" || sufficiency.state === "INSUFFICIENT_DATA") {
    insights.unshift({
      key: "inventory_pro.insufficient_data",
      severity: "info",
      title: "Not enough consumption history for reliable anomaly detection",
      detail: sufficiency.reasons.join(" "),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    currency: base.currency,
    sufficiency: sufficiency.state,
    sufficiencyReasons: sufficiency.reasons,
    anomalies,
    reorderRequirements,
    insights,
  };
}
