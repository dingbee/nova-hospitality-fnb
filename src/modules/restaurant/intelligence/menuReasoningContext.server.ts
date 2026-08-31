/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * INT-01 — Menu Intelligence context builder.
 *
 * Every number here comes from getMenuIntelligence() (menu.server.ts,
 * Sprint 3.1), unmodified — this file recomputes nothing. It only
 * selects, bounds, and normalizes that output into the shape a reasoning
 * provider reads, with a stable factId per fact so a model's cited
 * supportingFactIds can be checked against what was actually supplied
 * (see menuReasoning.server.ts). Deterministic given the same DB state and
 * inputs: same tenant, same windowDays, same generatedAt bucket -> same
 * context, every time — no randomness, no model call inside this file.
 */
import { createHash } from "node:crypto";
import { assertCapability } from "../core/access.server";
import type { MenuIntelligence, MenuItemIntelligence } from "./types";

type Sb = any;

/** How many individual menu-item facts are handed to the model at most — keeps the prompt small and cheap regardless of how large the tenant's menu is. */
const MAX_MENU_FACTS = 16;

export interface MenuIntelligenceFact {
  factId: string;
  menuItemId: string;
  name: string;
  price: number | null;
  quantitySold: number;
  revenue: number;
  cost: number;
  grossProfit: number;
  marginPercent: number | null;
  foodCostPercent: number | null;
  /** % change in units sold vs the immediately preceding window of equal length. */
  trendPercent: number | null;
  classification: MenuItemIntelligence["classification"];
  needsCostReview: boolean;
  costReviewReason: string | null;
  recommendedPrice: number | null;
  /** Which curated list(s) getMenuIntelligence already placed this item in — the deterministic reason it was selected for this context, not an AI judgment. */
  reasons: Array<"top_seller" | "profit_driver" | "margin_loser" | "declining" | "cost_review">;
}

export interface MenuIntelligenceContext {
  restaurant: { tenantId: string; businessName: string; currency: string };
  period: { windowDays: number; generatedAt: string };
  totals: { factId: string; revenue: number; cost: number; grossProfit: number; itemsSold: number };
  menu: MenuIntelligenceFact[];
  /** True when the tenant has no sales at all in the window — the reasoning prompt is instructed to say evidence is insufficient rather than reason over an empty menu. */
  hasData: boolean;
}

function businessNameOf(tenant: { name?: string; settings?: any } | null): string {
  const trading = (tenant?.settings?.business?.tradingName ?? "").trim();
  return trading || tenant?.name || "This restaurant";
}

/**
 * Deterministically selects and bounds which menu items are worth showing
 * the model: getMenuIntelligence already ranks profitDrivers/marginLosers/
 * declining/costReview by real business criteria (gross profit, margin,
 * trend, staleness) — this only additionally ranks by quantitySold (for
 * "what's selling") and merges the curated lists, deduping by item and
 * capping the total. No new business logic, no new sort criteria beyond
 * "top N by an already-computed field."
 */
function selectMenuFacts(mi: MenuIntelligence): MenuIntelligenceFact[] {
  const byId = new Map<string, MenuIntelligenceFact>();
  const upsert = (item: MenuItemIntelligence, reason: MenuIntelligenceFact["reasons"][number]) => {
    const existing = byId.get(item.menuItemId);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return;
    }
    byId.set(item.menuItemId, {
      factId: `menu-item:${item.menuItemId}`,
      menuItemId: item.menuItemId,
      name: item.name,
      price: item.price,
      quantitySold: item.quantitySold,
      revenue: item.revenue,
      cost: item.cost,
      grossProfit: item.grossProfit,
      marginPercent: item.marginPercent,
      foodCostPercent: item.foodCostPercent,
      trendPercent: item.trendPercent,
      classification: item.classification,
      needsCostReview: item.needsCostReview,
      costReviewReason: item.costReviewReason,
      recommendedPrice: item.recommendedPrice,
      reasons: [reason],
    });
  };

  const topSellers = [...mi.items].sort((a, b) => b.quantitySold - a.quantitySold).slice(0, 8);
  for (const i of topSellers) upsert(i, "top_seller");
  for (const i of mi.profitDrivers) upsert(i, "profit_driver");
  for (const i of mi.marginLosers) upsert(i, "margin_loser");
  for (const i of mi.declining) upsert(i, "declining");
  for (const i of mi.costReview) upsert(i, "cost_review");

  return [...byId.values()].slice(0, MAX_MENU_FACTS);
}

export async function buildMenuIntelligenceContext(
  sb: Sb,
  userId: string,
  input: { tenantId: string; windowDays: number },
): Promise<MenuIntelligenceContext> {
  // intelligence.read, not the looser assertTenantRead getMenuIntelligence
  // itself uses — this is the AI-reasoning entry point, held to the same
  // capability Staff Ask NOVA already requires for AI-grounded answers.
  await assertCapability(sb, userId, input.tenantId, "intelligence.read");

  const [{ data: tenant }, menuIntelligenceMod] = await Promise.all([
    sb
      .from("restaurant_tenants")
      .select("id, name, settings")
      .eq("id", input.tenantId)
      .maybeSingle(),
    import("./menu.server"),
  ]);
  const mi = await menuIntelligenceMod.getMenuIntelligence(sb, userId, {
    tenantId: input.tenantId,
    windowDays: input.windowDays,
  });

  const menu = selectMenuFacts(mi);

  return {
    restaurant: {
      tenantId: input.tenantId,
      businessName: businessNameOf(tenant),
      currency: mi.currency,
    },
    period: { windowDays: mi.windowDays, generatedAt: mi.generatedAt },
    totals: {
      factId: "totals:period",
      revenue: mi.totals.revenue,
      cost: mi.totals.cost,
      grossProfit: mi.totals.grossProfit,
      itemsSold: mi.totals.itemsSold,
    },
    menu,
    hasData: mi.totals.itemsSold > 0,
  };
}

/** All fact ids actually present in a context — the whitelist supportingFactIds is checked against. */
export function factIdsOf(context: MenuIntelligenceContext): Set<string> {
  return new Set([context.totals.factId, ...context.menu.map((m) => m.factId)]);
}

/**
 * A stable hash of the context content (never of anything provider/model-
 * specific) — recorded alongside an evaluation so two runs can be confirmed
 * to have reasoned over identical facts, without persisting the full
 * context payload itself.
 */
export function hashMenuIntelligenceContext(context: MenuIntelligenceContext): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex").slice(0, 32);
}
