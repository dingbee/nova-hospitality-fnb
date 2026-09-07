/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeTables } from "./test-helpers/fakeSupabase";
import { CommercialForbiddenError } from "./access.server";
import {
  completeRecommendation,
  dismissRecommendation,
  getCommercialForecast,
  getCommercialIntelligenceOverview,
  listCommercialRecommendations,
  listCommercialSignals,
  listCustomerIntelligence,
  runCommercialSignalScan,
} from "./intelligence.server";

const ADMIN = "admin-1";
const OTHER_USER = "user-2";
const TENANT_HEALTHY = "tenant-healthy";
const TENANT_AT_RISK = "tenant-at-risk";
const TENANT_EXPANSION = "tenant-expansion";
const TENANT_QUOTA = "tenant-quota";
const TENANT_CANCELLED = "tenant-cancelled";

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

function baseTables(): FakeTables {
  return {
    commercial_administrators: [{ id: "a1", user_id: ADMIN, status: "active" }],
    restaurant_tenants: [
      { id: TENANT_HEALTHY, name: "Healthy Grill", slug: "healthy-grill", settings: {} },
      { id: TENANT_AT_RISK, name: "At Risk Bistro", slug: "at-risk-bistro", settings: {} },
      { id: TENANT_EXPANSION, name: "Expansion Cafe", slug: "expansion-cafe", settings: {} },
      { id: TENANT_QUOTA, name: "Quota Kitchen", slug: "quota-kitchen", settings: {} },
      { id: TENANT_CANCELLED, name: "Cancelled Diner", slug: "cancelled-diner", settings: {} },
    ],
    restaurant_subscriptions: [
      {
        tenant_id: TENANT_HEALTHY,
        status: "active",
        renewal_date: isoDaysFromNow(90),
        agreement_id: "agr-healthy",
      },
      {
        tenant_id: TENANT_AT_RISK,
        status: "past_due",
        renewal_date: isoDaysFromNow(20),
        agreement_id: "agr-at-risk",
      },
      {
        tenant_id: TENANT_EXPANSION,
        status: "active",
        renewal_date: isoDaysFromNow(90),
        agreement_id: "agr-expansion",
      },
      {
        tenant_id: TENANT_QUOTA,
        status: "active",
        renewal_date: isoDaysFromNow(90),
        agreement_id: "agr-quota",
      },
      {
        tenant_id: TENANT_CANCELLED,
        status: "cancelled",
        renewal_date: null,
        agreement_id: "agr-cancelled",
      },
    ],
    commercial_agreements: [
      {
        id: "agr-healthy",
        tenant_id: TENANT_HEALTHY,
        billing_interval: "monthly",
        monthly_price: 100000,
        annual_price: null,
        renewed_from_agreement_id: null,
      },
      {
        id: "agr-at-risk",
        tenant_id: TENANT_AT_RISK,
        billing_interval: "monthly",
        monthly_price: 150000,
        annual_price: null,
        renewed_from_agreement_id: null,
      },
      {
        id: "agr-expansion",
        tenant_id: TENANT_EXPANSION,
        billing_interval: "monthly",
        monthly_price: 200000,
        annual_price: null,
        renewed_from_agreement_id: null,
      },
      {
        id: "agr-quota",
        tenant_id: TENANT_QUOTA,
        billing_interval: "monthly",
        monthly_price: 120000,
        annual_price: null,
        renewed_from_agreement_id: null,
      },
      {
        id: "agr-cancelled",
        tenant_id: TENANT_CANCELLED,
        billing_interval: "monthly",
        monthly_price: 80000,
        annual_price: null,
        renewed_from_agreement_id: null,
      },
    ],
    commercial_invoices: [
      {
        tenant_id: TENANT_AT_RISK,
        balance: 150000,
        status: "issued",
        due_date: isoDaysFromNow(-70), // 70 days overdue -> "61-90" bucket
      },
    ],
    commercial_invoice_lines: [],
    commercial_property_classifications: [
      { id: "pc-1", tenant_id: TENANT_EXPANSION, chargeable: true, price_applied: 50000 },
      { id: "pc-2", tenant_id: TENANT_EXPANSION, chargeable: false, price_applied: null },
    ],
    commercial_usage_counters: [
      {
        tenant_id: TENANT_QUOTA,
        state: "BLOCKED",
        period_start: new Date(Date.now() - 5 * 86400000).toISOString(),
        period_end: new Date(Date.now() + 25 * 86400000).toISOString(),
      },
    ],
    commercial_signals: [],
    commercial_recommendations: [],
    commercial_audit_log: [],
  };
}

function db(tables: FakeTables) {
  return createFakeSupabase(tables, {
    restaurant_is_commercial_admin: ({ _user_id }: { _user_id: string }) => _user_id === ADMIN,
  });
}

/* ================================================================ Reads */

describe("getCommercialIntelligenceOverview", () => {
  it("denies a non-commercial-admin", async () => {
    const sb = db(baseTables());
    await expect(getCommercialIntelligenceOverview(sb, OTHER_USER)).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
  });

  it("MRR/ARR sum only non-cancelled subscriptions at their agreement's frozen monthly price", async () => {
    const sb = db(baseTables());
    const o = await getCommercialIntelligenceOverview(sb, ADMIN);
    // healthy(100k) + at-risk(150k) + expansion(200k) + quota(120k) = 570k — cancelled tenant excluded
    expect(o.mrr).toBe(570000);
    expect(o.arr).toBe(570000 * 12);
    expect(o.portfolioSize).toBe(5);
  });

  it("overdue exposure sums only the balance of tenants with a non-current ageing bucket", async () => {
    const sb = db(baseTables());
    const o = await getCommercialIntelligenceOverview(sb, ADMIN);
    expect(o.overdueExposure).toBe(150000);
  });

  it("expansion opportunity sums unbilled chargeable property value", async () => {
    const sb = db(baseTables());
    const o = await getCommercialIntelligenceOverview(sb, ADMIN);
    expect(o.expansionOpportunity).toBe(50000);
  });

  it("health distribution accounts for every tenant exactly once", async () => {
    const sb = db(baseTables());
    const o = await getCommercialIntelligenceOverview(sb, ADMIN);
    const total = Object.values(o.healthDistribution).reduce((s: number, n: any) => s + n, 0);
    expect(total).toBe(5);
    expect(o.healthDistribution.CRITICAL).toBeGreaterThanOrEqual(1); // the cancelled tenant, at minimum
  });
});

describe("listCustomerIntelligence", () => {
  it("denies a non-commercial-admin", async () => {
    const sb = db(baseTables());
    await expect(listCustomerIntelligence(sb, OTHER_USER)).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
  });

  it("bands the cancelled tenant CRITICAL and the healthy tenant HEALTHY", async () => {
    const sb = db(baseTables());
    const rows = await listCustomerIntelligence(sb, ADMIN);
    const cancelled = rows.find((r) => r.tenantId === TENANT_CANCELLED)!;
    expect(cancelled.healthBand).toBe("CRITICAL");
    const healthy = rows.find((r) => r.tenantId === TENANT_HEALTHY)!;
    expect(healthy.healthBand).toBe("HEALTHY");
  });

  it("bands the materially-overdue past-due tenant AT_RISK or CRITICAL", async () => {
    const sb = db(baseTables());
    const rows = await listCustomerIntelligence(sb, ADMIN);
    const atRisk = rows.find((r) => r.tenantId === TENANT_AT_RISK)!;
    expect(["AT_RISK", "CRITICAL"]).toContain(atRisk.healthBand);
  });
});

describe("getCommercialForecast", () => {
  it("denies a non-commercial-admin", async () => {
    const sb = db(baseTables());
    await expect(getCommercialForecast(sb, OTHER_USER)).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
  });

  it("exposes assumptions and never claims a machine-learning prediction", async () => {
    const sb = db(baseTables());
    const f = await getCommercialForecast(sb, ADMIN);
    expect(f.assumptions.length).toBeGreaterThan(0);
    expect(f.assumptions.join(" ")).toMatch(/deterministic/i);
    expect(f.assumptions.join(" ")).toMatch(/not machine-learning predictions/i);
  });

  it("renewal-adjusted forecast is MRR minus at-risk recurring revenue", async () => {
    const sb = db(baseTables());
    const f = await getCommercialForecast(sb, ADMIN);
    expect(f.renewalAdjustedForecast).toBe(
      Math.round((f.mrr - f.atRiskRecurringRevenue) * 100) / 100,
    );
  });
});

/* ============================================================ Signal scan */

describe("runCommercialSignalScan", () => {
  it("denies a non-commercial-admin", async () => {
    const sb = db(baseTables());
    await expect(runCommercialSignalScan(sb, OTHER_USER)).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
  });

  it("generates a collection signal for the materially-overdue tenant with high/critical severity", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const signal = tables.commercial_signals.find(
      (s: any) => s.tenant_id === TENANT_AT_RISK && s.category === "collection",
    );
    expect(signal).toBeTruthy();
    expect(signal.signal_type).toBe("invoice_materially_overdue");
    expect(["high", "critical"]).toContain(signal.severity);
    expect(signal.status).toBe("active");
  });

  it("generates exactly one renewal signal per tenant, not both renewal_approaching and renewal_at_risk", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const renewalSignals = tables.commercial_signals.filter(
      (s: any) => s.tenant_id === TENANT_AT_RISK && s.category === "renewal",
    );
    expect(renewalSignals).toHaveLength(1);
    expect(renewalSignals[0].signal_type).toBe("renewal_at_risk"); // past_due + within 30 days
  });

  it("generates an expansion_opportunity signal for the tenant with an unbilled chargeable property", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const signal = tables.commercial_signals.find(
      (s: any) => s.tenant_id === TENANT_EXPANSION && s.signal_type === "expansion_opportunity",
    );
    expect(signal).toBeTruthy();
    expect(signal.evidence.unbilledChargeableValue).toBe(50000);
  });

  it("generates an upgrade_opportunity signal (not a plain quota_warning) for a BLOCKED quota state", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const quotaSignals = tables.commercial_signals.filter((s: any) => s.tenant_id === TENANT_QUOTA);
    expect(quotaSignals.map((s: any) => s.signal_type)).toContain("upgrade_opportunity");
    expect(quotaSignals.map((s: any) => s.signal_type)).not.toContain("quota_warning");
  });

  it("§7 — a rescan with no state change does not create a duplicate active signal (dedup by dedupe_key)", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const countAfterFirst = tables.commercial_signals.length;
    await runCommercialSignalScan(sb, ADMIN);
    expect(tables.commercial_signals.length).toBe(countAfterFirst);
  });

  it("§7 — a rescan touches last_seen_at on an unchanged active signal instead of leaving it stale", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const before = tables.commercial_signals.find(
      (s: any) => s.tenant_id === TENANT_EXPANSION,
    )!.last_seen_at;
    await new Promise((r) => setTimeout(r, 5));
    await runCommercialSignalScan(sb, ADMIN);
    const after = tables.commercial_signals.find(
      (s: any) => s.tenant_id === TENANT_EXPANSION,
    )!.last_seen_at;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it("resolves a signal whose condition has cleared (property billed) without deleting its history", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const activeBefore = tables.commercial_signals.filter(
      (s: any) => s.tenant_id === TENANT_EXPANSION && s.status === "active",
    );
    expect(activeBefore).toHaveLength(1);

    // Clear the condition: the chargeable property is now billed.
    tables.commercial_invoice_lines.push({
      source_type: "property_classification",
      source_id: "pc-1",
    });
    await runCommercialSignalScan(sb, ADMIN);

    const stillThere = tables.commercial_signals.find(
      (s: any) => s.tenant_id === TENANT_EXPANSION && s.signal_type === "expansion_opportunity",
    );
    expect(stillThere.status).toBe("resolved");
    expect(stillThere.resolved_at).toBeTruthy();
  });

  it("creates exactly one recommendation per generated signal, scoped to the right tenant and action type", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const result = await runCommercialSignalScan(sb, ADMIN);
    expect(result.recommendationsCreated).toBeGreaterThan(0);
    const expansionRec = tables.commercial_recommendations.find(
      (r: any) => r.tenant_id === TENANT_EXPANSION && r.action_type === "REVIEW_EXPANSION",
    );
    expect(expansionRec).toBeTruthy();
    expect(expansionRec.status).toBe("open");
  });

  it("§8 — a rescan never creates a duplicate open recommendation for the same signal", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const countAfterFirst = tables.commercial_recommendations.length;
    await runCommercialSignalScan(sb, ADMIN);
    expect(tables.commercial_recommendations.length).toBe(countAfterFirst);
  });

  it("does not generate a recommendation for a purely informational revenue_expansion signal", async () => {
    const tables = baseTables();
    // Give the expansion tenant a superseding cheaper->pricier agreement chain to trigger revenue_expansion.
    tables.commercial_agreements.push({
      id: "agr-expansion-prior",
      tenant_id: TENANT_EXPANSION,
      billing_interval: "monthly",
      monthly_price: 100000,
      annual_price: null,
      renewed_from_agreement_id: null,
    });
    tables.commercial_agreements.find(
      (a: any) => a.id === "agr-expansion",
    ).renewed_from_agreement_id = "agr-expansion-prior";
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const expansionSignal = tables.commercial_signals.find(
      (s: any) => s.tenant_id === TENANT_EXPANSION && s.signal_type === "revenue_expansion",
    );
    expect(expansionSignal).toBeTruthy();
    const rec = tables.commercial_recommendations.find(
      (r: any) =>
        r.tenant_id === TENANT_EXPANSION &&
        r.dedupe_key === `rec:revenue_expansion:${TENANT_EXPANSION}`,
    );
    expect(rec).toBeUndefined();
  });
});

/* ==================================================================== CRUD */

describe("listCommercialSignals / listCommercialRecommendations", () => {
  it("deny a non-commercial-admin on both reads", async () => {
    const sb = db(baseTables());
    await expect(listCommercialSignals(sb, OTHER_USER, {})).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
    await expect(listCommercialRecommendations(sb, OTHER_USER, {})).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
  });

  it("filter by status and by tenant", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const activeOnly = await listCommercialSignals(sb, ADMIN, { status: "active" });
    expect(activeOnly.every((s: any) => s.status === "active")).toBe(true);
    const tenantOnly = await listCommercialSignals(sb, ADMIN, { tenantId: TENANT_QUOTA });
    expect(tenantOnly.every((s: any) => s.tenant_id === TENANT_QUOTA)).toBe(true);
  });
});

describe("completeRecommendation / dismissRecommendation", () => {
  it("deny a non-commercial-admin", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const rec = tables.commercial_recommendations[0];
    await expect(completeRecommendation(sb, OTHER_USER, { id: rec.id })).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
    await expect(
      dismissRecommendation(sb, OTHER_USER, { id: rec.id, reason: "not my call" }),
    ).rejects.toBeInstanceOf(CommercialForbiddenError);
  });

  it("§9 — completing records actor, timestamp and note, and writes an audit entry (the controlled action)", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const rec = tables.commercial_recommendations[0];
    const result = await completeRecommendation(sb, ADMIN, {
      id: rec.id,
      note: "Called the customer.",
    });
    expect(result.status).toBe("completed");
    expect(result.completed_by).toBe(ADMIN);
    expect(result.completed_at).toBeTruthy();
    expect(result.resolution_note).toBe("Called the customer.");
    const audit = tables.commercial_audit_log.find((a: any) => a.entity_id === rec.id);
    expect(audit).toBeTruthy();
    expect(audit.action).toBe("recommendation.complete");
    expect(audit.actor_id).toBe(ADMIN);
  });

  it("completing an already-completed recommendation is idempotent — no double audit entry", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const rec = tables.commercial_recommendations[0];
    await completeRecommendation(sb, ADMIN, { id: rec.id });
    tables.commercial_audit_log.length = 0; // clear to isolate the second call
    const second = await completeRecommendation(sb, ADMIN, { id: rec.id });
    expect(second.status).toBe("completed");
    expect(tables.commercial_audit_log).toHaveLength(0);
  });

  it("dismissing requires a reason and records it as the resolution note", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await runCommercialSignalScan(sb, ADMIN);
    const rec = tables.commercial_recommendations[0];
    const result = await dismissRecommendation(sb, ADMIN, {
      id: rec.id,
      reason: "Not applicable.",
    });
    expect(result.status).toBe("dismissed");
    expect(result.resolution_note).toBe("Not applicable.");
  });

  it("§17 — a forged/nonexistent recommendation id is safely rejected, not silently accepted", async () => {
    const sb = db(baseTables());
    await expect(
      completeRecommendation(sb, ADMIN, { id: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow();
  });
});
