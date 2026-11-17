/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P04 — Commercial Intelligence & Automation.
 *
 * The intelligence layer over P01 (policy)/P02 (transactions)/P03
 * (operations): it derives its state entirely from existing authoritative
 * commercial records — the same balance calculation as customers.server.ts
 * (`getCustomerBalance`), the same ageing calculation as billing-period.ts
 * (`ageingFor`), the same unbilled-property predicate as billing.server.ts
 * (`loadUnbilledPropertyCharges`), the same "current agreement carries the
 * frozen recurring price" model P02 already established. Nothing here
 * duplicates a calculation that already exists elsewhere in the commercial
 * engine.
 *
 * `loadPortfolioFacts` is the ONE place per-tenant commercial facts are
 * assembled from those authoritative sources — every read below (overview,
 * customer list, forecast, signal scan) is a projection or aggregation of
 * that one fact set, never a second independent computation.
 */
import { assertCommercialAdmin } from "./access.server";
import { writeCommercialAudit } from "./audit.server";
import { ageingFor, type AgeingBucket } from "./billing-period";
import { loadUnbilledPropertyCharges } from "./billing.server";
import { computeHealth, type HealthFacts, type HealthResult } from "./health";
import type {
  CompleteRecommendationInput,
  DismissRecommendationInput,
  ListCommercialRecommendationsInput,
  ListCommercialSignalsInput,
  RecommendationActionType,
  SignalCategory,
  SignalSeverity,
} from "./contracts";

type Sb = any;

/* ============================================================ fact model */

interface TenantFacts {
  tenantId: string;
  name: string;
  subscriptionStatus: string | null;
  renewalDate: string | null;
  daysUntilRenewal: number | null;
  /** Current monthly-equivalent recurring revenue from the active agreement — null when no agreement carries a fixed price (never fabricated). */
  monthlyEquivalent: number | null;
  /** Monthly-equivalent delta vs. the agreement this one superseded, if any (negative = contraction, positive = expansion). */
  renewalDelta: number | null;
  balance: number;
  worstAgeingBucket: AgeingBucket;
  propertyCount: number;
  chargeablePropertyCount: number;
  unbilledChargeableValue: number;
  worstQuotaState: HealthFacts["worstQuotaState"];
  health: HealthResult;
}

/** monthly_price if billing_interval is monthly, annual_price/12 if annual — null if neither is set (e.g. an Enterprise agreement with negotiated-elsewhere pricing). Never fabricates a figure P02 didn't record. */
function monthlyEquivalentOf(
  agreement: {
    billing_interval: string;
    monthly_price: number | null;
    annual_price: number | null;
  } | null,
): number | null {
  if (!agreement) return null;
  if (agreement.billing_interval === "annual") {
    return agreement.annual_price != null
      ? Math.round((agreement.annual_price / 12) * 100) / 100
      : null;
  }
  return agreement.monthly_price ?? null;
}

async function loadPortfolioFacts(sb: Sb): Promise<TenantFacts[]> {
  const { data: tenants, error: tenantErr } = await sb
    .from("restaurant_tenants")
    .select("id, name")
    .order("name")
    .limit(500);
  if (tenantErr) throw new Error(tenantErr.message);
  const tenantRows: { id: string; name: string }[] = tenants ?? [];
  if (tenantRows.length === 0) return [];
  const tenantIds = tenantRows.map((t) => t.id);

  const [{ data: subs }, { data: invoices }, { data: classifications }, { data: counters }] =
    await Promise.all([
      sb
        .from("restaurant_subscriptions")
        .select("tenant_id, status, renewal_date, agreement_id")
        .in("tenant_id", tenantIds),
      sb
        .from("commercial_invoices")
        .select("tenant_id, balance, status, due_date")
        .in("tenant_id", tenantIds)
        .not("status", "in", "(void,cancelled)"),
      sb
        .from("commercial_property_classifications")
        .select("tenant_id, chargeable")
        .in("tenant_id", tenantIds),
      sb
        .from("commercial_usage_counters")
        .select("tenant_id, state, period_start, period_end")
        .in("tenant_id", tenantIds),
    ]);

  const subByTenant = new Map<string, any>((subs ?? []).map((s: any) => [s.tenant_id, s]));

  const agreementIds = [...new Set((subs ?? []).map((s: any) => s.agreement_id).filter(Boolean))];
  const { data: agreements } =
    agreementIds.length > 0
      ? await sb
          .from("commercial_agreements")
          .select(
            "id, tenant_id, billing_interval, monthly_price, annual_price, renewed_from_agreement_id",
          )
          .in("id", agreementIds)
      : { data: [] };
  const agreementById = new Map<string, any>((agreements ?? []).map((a: any) => [a.id, a]));
  const priorIds = [
    ...new Set((agreements ?? []).map((a: any) => a.renewed_from_agreement_id).filter(Boolean)),
  ];
  const { data: priorAgreements } =
    priorIds.length > 0
      ? await sb
          .from("commercial_agreements")
          .select("id, billing_interval, monthly_price, annual_price")
          .in("id", priorIds)
      : { data: [] };
  const priorById = new Map<string, any>((priorAgreements ?? []).map((a: any) => [a.id, a]));

  const balanceByTenant = new Map<string, number>();
  const worstBucketByTenant = new Map<string, AgeingBucket>();
  const bucketRank: Record<AgeingBucket, number> = {
    current: 0,
    "1-30": 1,
    "31-60": 2,
    "61-90": 3,
    "90+": 4,
  };
  const today = new Date();
  for (const inv of (invoices ?? []) as any[]) {
    balanceByTenant.set(
      inv.tenant_id,
      Math.round(((balanceByTenant.get(inv.tenant_id) ?? 0) + Number(inv.balance)) * 100) / 100,
    );
    const { bucket } = ageingFor(inv.due_date, today);
    const current = worstBucketByTenant.get(inv.tenant_id) ?? "current";
    if (bucketRank[bucket] > bucketRank[current]) worstBucketByTenant.set(inv.tenant_id, bucket);
  }

  const propertyCountByTenant = new Map<string, number>();
  const chargeableCountByTenant = new Map<string, number>();
  for (const c of (classifications ?? []) as any[]) {
    propertyCountByTenant.set(c.tenant_id, (propertyCountByTenant.get(c.tenant_id) ?? 0) + 1);
    if (c.chargeable) {
      chargeableCountByTenant.set(c.tenant_id, (chargeableCountByTenant.get(c.tenant_id) ?? 0) + 1);
    }
  }

  const quotaRank: Record<NonNullable<HealthFacts["worstQuotaState"]>, number> = {
    NORMAL: 0,
    OVERRIDE: 0,
    WARNING: 1,
    NEAR_LIMIT: 2,
    LIMIT_REACHED: 3,
    BLOCKED: 4,
  };
  const worstQuotaByTenant = new Map<string, HealthFacts["worstQuotaState"]>();
  const nowMs = today.getTime();
  for (const c of (counters ?? []) as any[]) {
    const start = new Date(c.period_start).getTime();
    const end = new Date(c.period_end).getTime();
    if (nowMs < start || nowMs >= end) continue; // not the current period
    const state = c.state as NonNullable<HealthFacts["worstQuotaState"]>;
    const current = worstQuotaByTenant.get(c.tenant_id) ?? "NORMAL";
    if (quotaRank[state] > quotaRank[current]) worstQuotaByTenant.set(c.tenant_id, state);
  }

  const unbilledByTenant = new Map<string, number>();
  await Promise.all(
    tenantRows.map(async (t) => {
      const rows = await loadUnbilledPropertyCharges(sb, t.id);
      const total = (rows as any[]).reduce((s, r) => s + Number(r.price_applied ?? 0), 0);
      if (total > 0) unbilledByTenant.set(t.id, Math.round(total * 100) / 100);
    }),
  );

  return tenantRows.map((t) => {
    const sub = subByTenant.get(t.id) ?? null;
    const agreement = sub?.agreement_id ? (agreementById.get(sub.agreement_id) ?? null) : null;
    const priorAgreement = agreement?.renewed_from_agreement_id
      ? (priorById.get(agreement.renewed_from_agreement_id) ?? null)
      : null;
    const monthlyEquivalent = monthlyEquivalentOf(agreement);
    const priorMonthlyEquivalent = monthlyEquivalentOf(priorAgreement);
    const renewalDelta =
      monthlyEquivalent != null && priorMonthlyEquivalent != null
        ? Math.round((monthlyEquivalent - priorMonthlyEquivalent) * 100) / 100
        : null;

    const renewalDate: string | null = sub?.renewal_date ?? null;
    const daysUntilRenewal = renewalDate
      ? Math.ceil((new Date(`${renewalDate}T00:00:00Z`).getTime() - today.getTime()) / 86400000)
      : null;

    const balance = balanceByTenant.get(t.id) ?? 0;
    const worstAgeingBucket = worstBucketByTenant.get(t.id) ?? "current";
    const worstQuotaState = worstQuotaByTenant.get(t.id) ?? null;

    const health = computeHealth({
      subscriptionStatus: sub?.status ?? null,
      worstAgeingBucket,
      outstandingBalance: balance,
      daysUntilRenewal,
      worstQuotaState,
      recentContraction: renewalDelta != null && renewalDelta < 0,
    });

    return {
      tenantId: t.id,
      name: t.name,
      subscriptionStatus: sub?.status ?? null,
      renewalDate,
      daysUntilRenewal,
      monthlyEquivalent,
      renewalDelta,
      balance,
      worstAgeingBucket,
      propertyCount: propertyCountByTenant.get(t.id) ?? 0,
      chargeablePropertyCount: chargeableCountByTenant.get(t.id) ?? 0,
      unbilledChargeableValue: unbilledByTenant.get(t.id) ?? 0,
      worstQuotaState,
      health,
    };
  });
}

/* ================================================================ reads */

export async function getCommercialIntelligenceOverview(sb: Sb, userId: string) {
  await assertCommercialAdmin(sb, userId);
  const facts = await loadPortfolioFacts(sb);

  const revenueFacts = facts.filter((f) =>
    ["active", "trial", "past_due", "renewing"].includes(f.subscriptionStatus ?? ""),
  );
  const mrr =
    Math.round(revenueFacts.reduce((s, f) => s + (f.monthlyEquivalent ?? 0), 0) * 100) / 100;
  const arr = Math.round(mrr * 12 * 100) / 100;

  const activeCustomers = facts.filter((f) => f.subscriptionStatus === "active").length;
  const activeSubscriptions = facts.filter((f) =>
    ["active", "trial", "renewing"].includes(f.subscriptionStatus ?? ""),
  ).length;

  const renewalExposure30 = facts.filter(
    (f) => f.daysUntilRenewal != null && f.daysUntilRenewal >= 0 && f.daysUntilRenewal <= 30,
  ).length;
  const overdueExposure =
    Math.round(
      facts.reduce((s, f) => s + (f.worstAgeingBucket !== "current" ? f.balance : 0), 0) * 100,
    ) / 100;
  const atRiskRevenue =
    Math.round(
      facts
        .filter((f) => f.health.band === "AT_RISK" || f.health.band === "CRITICAL")
        .reduce((s, f) => s + (f.monthlyEquivalent ?? 0), 0) * 100,
    ) / 100;
  const expansionOpportunity =
    Math.round(facts.reduce((s, f) => s + f.unbilledChargeableValue, 0) * 100) / 100;

  const healthDistribution = { HEALTHY: 0, WATCH: 0, AT_RISK: 0, CRITICAL: 0 };
  for (const f of facts) healthDistribution[f.health.band] += 1;

  return {
    mrr,
    arr,
    activeCustomers,
    activeSubscriptions,
    portfolioSize: facts.length,
    renewalExposure30,
    overdueExposure,
    atRiskRevenue,
    expansionOpportunity,
    healthDistribution,
  };
}

export async function listCustomerIntelligence(sb: Sb, userId: string) {
  await assertCommercialAdmin(sb, userId);
  const facts = await loadPortfolioFacts(sb);

  const tenantIds = facts.map((f) => f.tenantId);
  const [{ data: openSignals }, { data: openRecs }] =
    tenantIds.length > 0
      ? await Promise.all([
          sb
            .from("commercial_signals")
            .select("tenant_id")
            .eq("status", "active")
            .in("tenant_id", tenantIds),
          sb
            .from("commercial_recommendations")
            .select("tenant_id")
            .eq("status", "open")
            .in("tenant_id", tenantIds),
        ])
      : [{ data: [] }, { data: [] }];

  const signalCount = new Map<string, number>();
  for (const s of (openSignals ?? []) as any[]) {
    signalCount.set(s.tenant_id, (signalCount.get(s.tenant_id) ?? 0) + 1);
  }
  const recCount = new Map<string, number>();
  for (const r of (openRecs ?? []) as any[]) {
    recCount.set(r.tenant_id, (recCount.get(r.tenant_id) ?? 0) + 1);
  }

  return facts.map((f) => ({
    tenantId: f.tenantId,
    name: f.name,
    healthBand: f.health.band,
    healthScore: f.health.score,
    mrr: f.monthlyEquivalent,
    balance: f.balance,
    renewalDate: f.renewalDate,
    daysUntilRenewal: f.daysUntilRenewal,
    propertyCount: f.propertyCount,
    chargeablePropertyCount: f.chargeablePropertyCount,
    openSignalCount: signalCount.get(f.tenantId) ?? 0,
    openRecommendationCount: recCount.get(f.tenantId) ?? 0,
  }));
}

export async function getCommercialForecast(sb: Sb, userId: string) {
  await assertCommercialAdmin(sb, userId);
  const facts = await loadPortfolioFacts(sb);

  const revenueFacts = facts.filter((f) =>
    ["active", "trial", "past_due", "renewing"].includes(f.subscriptionStatus ?? ""),
  );
  const mrr =
    Math.round(revenueFacts.reduce((s, f) => s + (f.monthlyEquivalent ?? 0), 0) * 100) / 100;
  const arr = Math.round(mrr * 12 * 100) / 100;

  const atRiskMrr =
    Math.round(
      revenueFacts
        .filter(
          (f) =>
            f.health.band === "AT_RISK" ||
            f.health.band === "CRITICAL" ||
            (f.daysUntilRenewal != null && f.daysUntilRenewal < 0),
        )
        .reduce((s, f) => s + (f.monthlyEquivalent ?? 0), 0) * 100,
    ) / 100;

  const renewalAdjustedForecast = Math.round((mrr - atRiskMrr) * 100) / 100;
  const overdueExposure =
    Math.round(
      facts.reduce((s, f) => s + (f.worstAgeingBucket !== "current" ? f.balance : 0), 0) * 100,
    ) / 100;
  const expansionOpportunity =
    Math.round(facts.reduce((s, f) => s + f.unbilledChargeableValue, 0) * 100) / 100;

  return {
    mrr,
    arr,
    atRiskRecurringRevenue: atRiskMrr,
    renewalAdjustedForecast,
    overdueExposure,
    expansionOpportunity,
    assumptions: [
      "MRR includes only subscriptions in active/trial/past_due/renewing status, valued at their current agreement's frozen price (annual agreements divided by 12) — never the live pricing catalogue.",
      "At-risk recurring revenue is the MRR of customers whose computed health band is AT_RISK or CRITICAL, or whose renewal date has passed without a recorded renewal.",
      "Renewal-adjusted forecast assumes every at-risk customer above does not renew — a deterministic worst-case bound, not a probability-weighted prediction.",
      "Overdue exposure and expansion opportunity are computed the same way as the Collections and Additional Properties views — no separate calculation.",
      "These are deterministic calculations from recorded data, not machine-learning predictions.",
    ],
  };
}

/* ============================================================ signal scan */

interface SignalCandidate {
  category: SignalCategory;
  signal_type: string;
  severity: SignalSeverity;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  recommendation: { actionType: RecommendationActionType; title: string; rationale: string } | null;
}

/** Deterministic, documented rules — one candidate signal per condition per tenant. Mutually-exclusive conditions (e.g. renewal risk vs. plain approach) only ever emit the stronger one, so a tenant never carries two signals that would spawn duplicate recommendations for the same underlying situation. */
function candidatesFor(f: TenantFacts): SignalCandidate[] {
  const out: SignalCandidate[] = [];
  const name = f.name;

  // RENEWAL
  const atRisk = f.subscriptionStatus === "past_due" || f.balance > 0;
  if (f.daysUntilRenewal != null && f.daysUntilRenewal < 0) {
    out.push({
      category: "renewal",
      signal_type: "renewal_overdue",
      severity: "critical",
      title: `Renewal overdue — ${name}`,
      detail: `Renewal date passed ${Math.abs(f.daysUntilRenewal)} day(s) ago with no recorded renewal.`,
      evidence: { daysUntilRenewal: f.daysUntilRenewal, subscriptionStatus: f.subscriptionStatus },
      recommendation: {
        actionType: "REVIEW_RENEWAL",
        title: `Review overdue renewal for ${name}`,
        rationale: `Renewal date passed ${Math.abs(f.daysUntilRenewal)} day(s) ago with no recorded renewal.`,
      },
    });
  } else if (f.daysUntilRenewal != null && f.daysUntilRenewal <= 30 && atRisk) {
    out.push({
      category: "renewal",
      signal_type: "renewal_at_risk",
      severity: "high",
      title: `Renewal at risk — ${name}`,
      detail: `Renews in ${f.daysUntilRenewal} day(s) while ${f.subscriptionStatus === "past_due" ? "past due" : "carrying an outstanding balance"}.`,
      evidence: {
        daysUntilRenewal: f.daysUntilRenewal,
        balance: f.balance,
        subscriptionStatus: f.subscriptionStatus,
      },
      recommendation: {
        actionType: "REVIEW_RENEWAL",
        title: `Review at-risk renewal for ${name}`,
        rationale: `Renews in ${f.daysUntilRenewal} day(s) while ${f.subscriptionStatus === "past_due" ? "past due" : "carrying an outstanding balance"}.`,
      },
    });
  } else if (f.daysUntilRenewal != null && f.daysUntilRenewal <= 30) {
    out.push({
      category: "renewal",
      signal_type: "renewal_approaching",
      severity: f.daysUntilRenewal <= 7 ? "medium" : "low",
      title: `Renewal approaching — ${name}`,
      detail: `Renews in ${f.daysUntilRenewal} day(s).`,
      evidence: { daysUntilRenewal: f.daysUntilRenewal },
      recommendation: {
        actionType: "REVIEW_RENEWAL",
        title: `Review renewal for ${name}`,
        rationale: `Renews in ${f.daysUntilRenewal} day(s).`,
      },
    });
  }

  // COLLECTION
  if (f.worstAgeingBucket === "61-90" || f.worstAgeingBucket === "90+") {
    out.push({
      category: "collection",
      signal_type: "invoice_materially_overdue",
      severity: f.worstAgeingBucket === "90+" ? "critical" : "high",
      title: `Materially overdue balance — ${name}`,
      detail: `Outstanding balance of ${f.balance.toLocaleString()} with the oldest invoice in the ${f.worstAgeingBucket}-day bucket.`,
      evidence: { balance: f.balance, worstAgeingBucket: f.worstAgeingBucket },
      recommendation: {
        actionType: "CONTACT_CUSTOMER",
        title: `Contact ${name} regarding overdue balance`,
        rationale: `Outstanding balance of ${f.balance.toLocaleString()} with the oldest invoice in the ${f.worstAgeingBucket}-day bucket.`,
      },
    });
  } else if (f.worstAgeingBucket === "1-30" || f.worstAgeingBucket === "31-60") {
    out.push({
      category: "collection",
      signal_type: "invoice_overdue",
      severity: f.worstAgeingBucket === "31-60" ? "medium" : "low",
      title: `Overdue balance — ${name}`,
      detail: `Outstanding balance of ${f.balance.toLocaleString()} with the oldest invoice in the ${f.worstAgeingBucket}-day bucket.`,
      evidence: { balance: f.balance, worstAgeingBucket: f.worstAgeingBucket },
      recommendation: {
        actionType: "REVIEW_COLLECTION",
        title: `Review overdue balance for ${name}`,
        rationale: `Outstanding balance of ${f.balance.toLocaleString()} with the oldest invoice in the ${f.worstAgeingBucket}-day bucket.`,
      },
    });
  }

  // CUSTOMER HEALTH
  if (f.health.band === "CRITICAL") {
    out.push({
      category: "health",
      signal_type: "health_critical",
      severity: "critical",
      title: `Customer health critical — ${name}`,
      detail: `${name} has entered CRITICAL health (score ${f.health.score}/100).`,
      evidence: { score: f.health.score, reasons: f.health.reasons },
      recommendation: {
        actionType: "REVIEW_CUSTOMER",
        title: `Customer ${name} has entered CRITICAL health`,
        rationale: f.health.reasons.map((r) => r.detail).join(" "),
      },
    });
  } else if (f.health.band === "AT_RISK") {
    out.push({
      category: "health",
      signal_type: "health_at_risk",
      severity: "high",
      title: `Customer health at risk — ${name}`,
      detail: `${name} appears AT_RISK (score ${f.health.score}/100).`,
      evidence: { score: f.health.score, reasons: f.health.reasons },
      recommendation: {
        actionType: "REVIEW_CUSTOMER",
        title: `Customer ${name} appears AT_RISK`,
        rationale: f.health.reasons.map((r) => r.detail).join(" "),
      },
    });
  }

  // EXPANSION
  if (f.unbilledChargeableValue > 0) {
    out.push({
      category: "expansion",
      signal_type: "expansion_opportunity",
      severity: "info",
      title: `Expansion opportunity — ${name}`,
      detail: `${f.chargeablePropertyCount} chargeable propert${f.chargeablePropertyCount === 1 ? "y" : "ies"} with ${f.unbilledChargeableValue.toLocaleString()} not yet invoiced.`,
      evidence: {
        unbilledChargeableValue: f.unbilledChargeableValue,
        chargeablePropertyCount: f.chargeablePropertyCount,
      },
      recommendation: {
        actionType: "REVIEW_EXPANSION",
        title: `Customer ${name} appears ready for an additional property`,
        rationale: `${f.chargeablePropertyCount} chargeable propert${f.chargeablePropertyCount === 1 ? "y" : "ies"} with ${f.unbilledChargeableValue.toLocaleString()} not yet invoiced.`,
      },
    });
  }
  if (f.worstQuotaState === "LIMIT_REACHED" || f.worstQuotaState === "BLOCKED") {
    out.push({
      category: "expansion",
      signal_type: "upgrade_opportunity",
      severity: "medium",
      title: `Upgrade opportunity — ${name}`,
      detail: `Usage has reached its configured limit this period (${f.worstQuotaState}).`,
      evidence: { worstQuotaState: f.worstQuotaState },
      recommendation: {
        actionType: "REVIEW_UPGRADE",
        title: `Customer ${name} is approaching quota limits`,
        rationale: `Usage has reached its configured limit this period (${f.worstQuotaState}) — a higher plan or quota may be warranted.`,
      },
    });
  }

  // USAGE (only when not already the stronger upgrade_opportunity above)
  if (f.worstQuotaState === "NEAR_LIMIT" || f.worstQuotaState === "WARNING") {
    out.push({
      category: "usage",
      signal_type: f.worstQuotaState === "NEAR_LIMIT" ? "quota_near_limit" : "quota_warning",
      severity: f.worstQuotaState === "NEAR_LIMIT" ? "medium" : "low",
      title: `Usage ${f.worstQuotaState === "NEAR_LIMIT" ? "near limit" : "warning"} — ${name}`,
      detail: `Usage quota state this period: ${f.worstQuotaState}.`,
      evidence: { worstQuotaState: f.worstQuotaState },
      recommendation: {
        actionType: "REVIEW_USAGE",
        title: `Customer ${name} is approaching quota limits`,
        rationale: `Usage quota state this period: ${f.worstQuotaState}.`,
      },
    });
  }

  // REVENUE
  if (f.renewalDelta != null && f.renewalDelta < 0) {
    out.push({
      category: "revenue",
      signal_type: "revenue_contraction",
      severity: "medium",
      title: `Revenue contraction — ${name}`,
      detail: `Most recent renewal reduced recurring revenue by ${Math.abs(f.renewalDelta).toLocaleString()}/mo.`,
      evidence: { renewalDelta: f.renewalDelta },
      recommendation: {
        actionType: "CONTACT_CUSTOMER",
        title: `Contact ${name} — recent renewal reduced recurring revenue`,
        rationale: `Most recent renewal reduced recurring revenue by ${Math.abs(f.renewalDelta).toLocaleString()}/mo.`,
      },
    });
  } else if (f.renewalDelta != null && f.renewalDelta > 0) {
    out.push({
      category: "revenue",
      signal_type: "revenue_expansion",
      severity: "info",
      title: `Revenue expansion — ${name}`,
      detail: `Most recent renewal increased recurring revenue by ${f.renewalDelta.toLocaleString()}/mo.`,
      evidence: { renewalDelta: f.renewalDelta },
      recommendation: null,
    });
  }

  return out;
}

export interface SignalScanResult {
  tenantsScanned: number;
  signalsCreated: number;
  signalsTouched: number;
  signalsResolved: number;
  recommendationsCreated: number;
}

/**
 * §7/§8/§18 — recomputes the full signal set from current commercial state,
 * idempotently: a condition already represented by an active signal has its
 * `last_seen_at` touched, never a duplicate row (the unique `dedupe_key`
 * enforces this at the database level too, so a concurrent double-call
 * cannot create two rows for the same condition). A condition no longer
 * present resolves its signal. Recommendations are created once per signal
 * (by a `rec:<signal dedupe key>` key) and never recreated once dismissed or
 * completed — a rescan surfaces new problems, it never re-litigates a
 * decision an admin already made.
 */
export async function runCommercialSignalScan(sb: Sb, userId: string): Promise<SignalScanResult> {
  await assertCommercialAdmin(sb, userId);
  const facts = await loadPortfolioFacts(sb);
  const now = new Date().toISOString();

  const desired = facts.flatMap((f) =>
    candidatesFor(f).map((c) => ({
      tenantId: f.tenantId,
      ...c,
      dedupeKey: `${c.signal_type}:${f.tenantId}`,
    })),
  );
  const desiredKeys = new Set(desired.map((d) => d.dedupeKey));

  const { data: existingActive } = await sb
    .from("commercial_signals")
    .select("id, dedupe_key")
    .eq("status", "active");
  const existingByKey = new Map<string, any>(
    (existingActive ?? []).map((s: any) => [s.dedupe_key, s]),
  );

  let created = 0;
  let touched = 0;
  for (const d of desired) {
    const existing = existingByKey.get(d.dedupeKey);
    if (existing) {
      await sb
        .from("commercial_signals")
        .update({
          last_seen_at: now,
          severity: d.severity,
          title: d.title,
          detail: d.detail,
          evidence: d.evidence,
        })
        .eq("id", existing.id);
      touched += 1;
    } else {
      const { error } = await sb.from("commercial_signals").insert({
        tenant_id: d.tenantId,
        category: d.category,
        signal_type: d.signal_type,
        severity: d.severity,
        dedupe_key: d.dedupeKey,
        title: d.title,
        detail: d.detail,
        evidence: d.evidence,
        status: "active",
        first_detected_at: now,
        last_seen_at: now,
      });
      // A unique-index race (concurrent rescans) is a benign duplicate-insert loss, not a caller-visible failure.
      if (error && !String(error.message ?? "").includes("dedupe_key"))
        throw new Error(error.message);
      created += 1;
    }
  }

  let resolved = 0;
  for (const [key, row] of existingByKey) {
    if (!desiredKeys.has(key)) {
      await sb
        .from("commercial_signals")
        .update({ status: "resolved", resolved_at: now })
        .eq("id", row.id);
      resolved += 1;
    }
  }

  const recCandidates = desired.filter((d) => d.recommendation);
  const recDedupeKeys = recCandidates.map((d) => `rec:${d.dedupeKey}`);
  const { data: existingRecs } =
    recDedupeKeys.length > 0
      ? await sb
          .from("commercial_recommendations")
          .select("dedupe_key")
          .in("dedupe_key", recDedupeKeys)
      : { data: [] };
  const existingRecKeys = new Set((existingRecs ?? []).map((r: any) => r.dedupe_key));

  let recommendationsCreated = 0;
  for (const d of recCandidates) {
    const recKey = `rec:${d.dedupeKey}`;
    if (existingRecKeys.has(recKey)) continue;
    const { data: signalRow } = await sb
      .from("commercial_signals")
      .select("id")
      .eq("dedupe_key", d.dedupeKey)
      .maybeSingle();
    const { error } = await sb.from("commercial_recommendations").insert({
      tenant_id: d.tenantId,
      signal_id: signalRow?.id ?? null,
      action_type: d.recommendation!.actionType,
      title: d.recommendation!.title,
      rationale: d.recommendation!.rationale,
      evidence: d.evidence,
      status: "open",
      dedupe_key: recKey,
    });
    if (error && !String(error.message ?? "").includes("dedupe_key"))
      throw new Error(error.message);
    recommendationsCreated += 1;
  }

  return {
    tenantsScanned: facts.length,
    signalsCreated: created,
    signalsTouched: touched,
    signalsResolved: resolved,
    recommendationsCreated,
  };
}

/* ============================================================ CRUD reads */

export async function listCommercialSignals(
  sb: Sb,
  userId: string,
  filter: ListCommercialSignalsInput,
) {
  await assertCommercialAdmin(sb, userId);
  let q = sb
    .from("commercial_signals")
    .select("*, restaurant_tenants(name, slug)")
    .order("severity", { ascending: false })
    .order("last_seen_at", { ascending: false });
  if (filter.tenantId) q = q.eq("tenant_id", filter.tenantId);
  if (filter.status) q = q.eq("status", filter.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listCommercialRecommendations(
  sb: Sb,
  userId: string,
  filter: ListCommercialRecommendationsInput,
) {
  await assertCommercialAdmin(sb, userId);
  let q = sb
    .from("commercial_recommendations")
    .select("*, restaurant_tenants(name, slug)")
    .order("created_at", { ascending: false });
  if (filter.tenantId) q = q.eq("tenant_id", filter.tenantId);
  if (filter.status) q = q.eq("status", filter.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * §9 — completing a recommendation IS the controlled, auditable commercial
 * action: no financial mutation happens here (a real one, if the admin took
 * it, already went through the appropriate P02/P03 server function) — this
 * only records that the review/contact task was done, by whom, and any note,
 * in the existing commercial audit trail.
 */
export async function completeRecommendation(
  sb: Sb,
  userId: string,
  input: CompleteRecommendationInput,
) {
  await assertCommercialAdmin(sb, userId);
  const { data: existing, error: readErr } = await sb
    .from("commercial_recommendations")
    .select("*")
    .eq("id", input.id)
    .single();
  if (readErr) throw new Error(readErr.message);
  if (existing.status !== "open") return existing;

  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("commercial_recommendations")
    .update({
      status: "completed",
      completed_by: userId,
      completed_at: now,
      resolution_note: input.note ?? null,
    })
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "recommendation.complete",
    entityType: "commercial_recommendations",
    entityId: data.id,
    tenantId: data.tenant_id,
    before: existing,
    after: data,
    reason: input.note ?? null,
  });
  return data;
}

export async function dismissRecommendation(
  sb: Sb,
  userId: string,
  input: DismissRecommendationInput,
) {
  await assertCommercialAdmin(sb, userId);
  const { data: existing, error: readErr } = await sb
    .from("commercial_recommendations")
    .select("*")
    .eq("id", input.id)
    .single();
  if (readErr) throw new Error(readErr.message);
  if (existing.status !== "open") return existing;

  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("commercial_recommendations")
    .update({
      status: "dismissed",
      completed_by: userId,
      completed_at: now,
      resolution_note: input.reason,
    })
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "recommendation.dismiss",
    entityType: "commercial_recommendations",
    entityId: data.id,
    tenantId: data.tenant_id,
    before: existing,
    after: data,
    reason: input.reason,
  });
  return data;
}
