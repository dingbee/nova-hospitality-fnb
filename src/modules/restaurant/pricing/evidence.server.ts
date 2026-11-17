/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Commercial evidence for the Intelligence Core — facts only.
 *
 * No reasoning, no recommendations, no thresholds with opinions attached. The
 * existing Intelligence Core decides what any of this means.
 */
import { assertTenantRead } from "../core/access.server";
import type { commercialEvidenceSchema } from "./contracts";
import type { z } from "zod";

type Sb = any;

export async function commercialEvidence(
  sb: Sb,
  userId: string,
  input: z.infer<typeof commercialEvidenceSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const since = new Date(Date.now() - input.lookbackDays * 86_400_000).toISOString();

  const [prices, discounts, promotions, taxes, items] = await Promise.all([
    sb
      .from("restaurant_prices")
      .select(
        "id, product_id, menu_item_id, scope, amount, currency, version, status, effective_from, supersedes_id",
      )
      .eq("tenant_id", input.tenantId)
      .gte("effective_from", since)
      .order("effective_from", { ascending: false })
      .limit(500),
    sb
      .from("restaurant_discount_applications")
      .select("id, amount, value, basis, scope, discount_rule_id, created_at, approved_by")
      .eq("tenant_id", input.tenantId)
      .gte("created_at", since)
      .limit(2000),
    sb
      .from("restaurant_promotions")
      .select("id, code, name, status, action, value, starts_at, ends_at")
      .eq("tenant_id", input.tenantId)
      .limit(200),
    sb
      .from("restaurant_tax_rules")
      .select("id, code, rate, basis, inclusive, active, effective_from")
      .eq("tenant_id", input.tenantId)
      .limit(200),
    sb
      .from("restaurant_order_items")
      .select(
        "menu_item_id, quantity, line_total, line_cost, discount, tax_amount, service_charge_amount, promotion_id, status, created_at",
      )
      .eq("tenant_id", input.tenantId)
      .gte("created_at", since)
      .limit(5000),
  ]);

  const lines = ((items.data ?? []) as any[]).filter((i) => i.status !== "voided");
  const revenue = lines.reduce((s, i) => s + Number(i.line_total ?? 0), 0);
  const cost = lines.reduce((s, i) => s + Number(i.line_cost ?? 0), 0);
  const discountTotal = lines.reduce((s, i) => s + Number(i.discount ?? 0), 0);
  const taxTotal = lines.reduce((s, i) => s + Number(i.tax_amount ?? 0), 0);
  const serviceTotal = lines.reduce((s, i) => s + Number(i.service_charge_amount ?? 0), 0);
  const promotedLines = lines.filter((i) => i.promotion_id);

  const priceRows = (prices.data ?? []) as any[];
  const discountRows = (discounts.data ?? []) as any[];

  return {
    window: { since, days: input.lookbackDays },
    price_changes: {
      count: priceRows.length,
      by_scope: countBy(priceRows, (r) => r.scope),
      pending_approval: priceRows.filter((r) => r.status === "pending_approval").length,
      recent: priceRows.slice(0, 20).map((r) => ({
        price_id: r.id,
        menu_item_id: r.menu_item_id,
        product_id: r.product_id,
        amount: Number(r.amount),
        currency: r.currency,
        version: r.version,
        effective_from: r.effective_from,
      })),
    },
    discounts: {
      applications: discountRows.length,
      total_amount: round(discountRows.reduce((s, d) => s + Number(d.amount ?? 0), 0)),
      unapproved: discountRows.filter((d) => !d.approved_by).length,
      by_scope: countBy(discountRows, (d) => d.scope),
      discount_rate_percent: revenue > 0 ? round((discountTotal / revenue) * 100) : 0,
    },
    promotions: ((promotions.data ?? []) as any[]).map((p) => ({
      id: p.id,
      code: p.code,
      status: p.status,
      action: p.action,
      value: Number(p.value),
      lines_sold: promotedLines.filter((l) => l.promotion_id === p.id).length,
      revenue: round(
        promotedLines
          .filter((l) => l.promotion_id === p.id)
          .reduce((s, l) => s + Number(l.line_total ?? 0), 0),
      ),
    })),
    tax: {
      active_rules: ((taxes.data ?? []) as any[]).filter((t) => t.active).length,
      collected: round(taxTotal),
      effective_rate_percent: revenue > 0 ? round((taxTotal / revenue) * 100) : 0,
    },
    revenue: {
      gross: round(revenue),
      cost: round(cost),
      gross_profit: round(revenue - cost),
      margin_percent: revenue > 0 ? round(((revenue - cost) / revenue) * 100) : 0,
      service_charges: round(serviceTotal),
      lines: lines.length,
    },
  };
}

const round = (n: number) => Number(n.toFixed(2));

function countBy<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r) ?? "unknown";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
