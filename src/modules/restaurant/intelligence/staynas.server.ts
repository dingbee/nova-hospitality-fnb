/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * LB-04 — read-only StayNas integration surface for Pro Intelligence.
 * All reads are tenant- and property-scoped; this module never writes source
 * records, accepts guest PII, creates POs or posts financial events.
 */
import {
  assertTenantRead,
  getTenantScope,
  resolveMultiPropertyScope,
} from "../core/access.server";
import type { P05WindowInput } from "./p05.types";

type Sb = any;
type LinkStatus = "foundation_not_installed" | "mapping_required" | "currency_mismatch" |
  "data_pending" | "attention_required" | "active";

function missingFoundation(error: any): boolean {
  const message = String(error?.message ?? "").toLowerCase();
  return error?.code === "42P01" || error?.code === "PGRST205" ||
    message.includes("lb04_property_links");
}

export async function getStayNasIntegrationIntelligence(
  sb: Sb,
  userId: string,
  input: P05WindowInput,
) {
  const { tenantId } = input;
  const tenantScope = await getTenantScope(sb, userId, tenantId);
  const propertyId = await resolveMultiPropertyScope(
    sb,
    tenantId,
    tenantScope,
    input.propertyId ?? null,
  );
  await assertTenantRead(sb, userId, tenantId, { propertyId: propertyId ?? null }, tenantScope);
  const { assertEntitled } = await import("@/modules/commercial/resolver.server");
  await assertEntitled(sb, tenantId, "advanced_analytics", { propertyId: propertyId ?? null });

  let linksQuery = sb
    .from("lb04_property_links")
    .select("id, property_id, staynas_organisation_id, staynas_property_id, currency, status, verified_at")
    .eq("tenant_id", tenantId);
  if (propertyId) linksQuery = linksQuery.eq("property_id", propertyId);
  const linksResult = await linksQuery.order("created_at", { ascending: false });
  if (linksResult.error) {
    if (missingFoundation(linksResult.error)) {
      return {
        status: "foundation_not_installed" as LinkStatus,
        scope: propertyId ?? "accessible tenant properties",
        linkSummary: { active: 0, pending: 0, suspended: 0, currencyMismatch: 0 },
        links: [],
        metrics: [],
        forecasts: [],
        anomalies: [],
        recommendations: [],
        limitations: ["LB-04 analytical tables are not installed in this tenant database."],
      };
    }
    throw new Error(linksResult.error.message);
  }

  const links = (linksResult.data ?? []) as any[];
  const propertyIds = [...new Set(links.map((link) => String(link.property_id)))];
  let propertyRows: any[] = [];
  if (propertyIds.length > 0) {
    const { data, error } = await sb
      .from("restaurant_properties")
      .select("id, name, currency")
      .eq("tenant_id", tenantId)
      .in("id", propertyIds);
    if (error) throw new Error(error.message);
    propertyRows = (data ?? []) as any[];
  }
  const propertyById = new Map(propertyRows.map((row) => [row.id, row]));
  const currencyMismatch = links.filter((link) => {
    const property = propertyById.get(link.property_id);
    return property && property.currency !== link.currency;
  });
  const verifiedLinks = links.filter((link) =>
    link.status === "active" && link.verified_at &&
    propertyById.get(link.property_id)?.currency === link.currency,
  );
  const verifiedPropertyIds = [...new Set(verifiedLinks.map((link) => String(link.property_id)))];

  const summary = {
    active: verifiedLinks.length,
    pending: links.filter((link) => link.status === "pending" || (link.status === "active" && !link.verified_at)).length,
    suspended: links.filter((link) => link.status === "suspended").length,
    currencyMismatch: currencyMismatch.length,
  };
  if (verifiedPropertyIds.length === 0) {
    return {
      status: (currencyMismatch.length > 0 ? "currency_mismatch" : "mapping_required") as LinkStatus,
      scope: propertyId ?? "accessible tenant properties",
      linkSummary: summary,
      links: links.map((link) => ({
        propertyName: propertyById.get(link.property_id)?.name ?? "Property",
        currency: link.currency,
        status: link.status,
        verified: Boolean(link.verified_at),
      })),
      metrics: [],
      forecasts: [],
      anomalies: [],
      recommendations: [],
      limitations: currencyMismatch.length > 0
        ? ["Property-link currency does not match the live LexiBite property currency; cross-product metrics are blocked."]
        : ["No active, verified StayNas property mapping is available in this property scope."],
    };
  }

  const [metricsResult, forecastsResult, anomaliesResult, recommendationsResult] = await Promise.all([
    sb.from("lb04_analytical_metrics")
      .select("metric_code, value, currency, period_start, period_end, source_system, freshness, reconciliation_status, calculated_at")
      .eq("tenant_id", tenantId).in("property_id", verifiedPropertyIds)
      .order("calculated_at", { ascending: false }).limit(40),
    sb.from("lb04_forecasts")
      .select("metric_code, projected_value, currency, forecast_period_start, forecast_period_end, method, model_version, reliability, generated_at")
      .eq("tenant_id", tenantId).in("property_id", verifiedPropertyIds)
      .order("generated_at", { ascending: false }).limit(20),
    sb.from("lb04_anomalies")
      .select("anomaly_code, severity, detection_method, recommended_investigation, detected_at, status")
      .eq("tenant_id", tenantId).in("property_id", verifiedPropertyIds)
      .in("status", ["open", "acknowledged"])
      .order("detected_at", { ascending: false }).limit(20),
    sb.from("lb04_recommendations")
      .select("recommendation_type, status, expected_impact, generated_at, expires_at")
      .eq("tenant_id", tenantId).in("property_id", verifiedPropertyIds)
      .in("status", ["advisory", "accepted"])
      .order("generated_at", { ascending: false }).limit(20),
  ]);
  const failed = [metricsResult, forecastsResult, anomaliesResult, recommendationsResult]
    .find((result) => result.error);
  if (failed?.error) {
    if (missingFoundation(failed.error)) {
      return {
        status: "foundation_not_installed" as LinkStatus,
        scope: propertyId ?? "accessible tenant properties",
        linkSummary: summary,
        links: [],
        metrics: [],
        forecasts: [],
        anomalies: [],
        recommendations: [],
        limitations: ["One or more LB-04 analytical tables are not installed in this tenant database."],
      };
    }
    throw new Error(failed.error.message);
  }

  const metrics = (metricsResult.data ?? []) as any[];
  const forecasts = (forecastsResult.data ?? []) as any[];
  const anomalies = (anomaliesResult.data ?? []) as any[];
  const recommendations = (recommendationsResult.data ?? []) as any[];
  const status: LinkStatus = currencyMismatch.length > 0 || anomalies.length > 0 ||
    metrics.some((metric) => metric.freshness === "stale" || metric.reconciliation_status === "disputed")
    ? "attention_required"
    : metrics.length === 0 && forecasts.length === 0
      ? "data_pending"
      : "active";

  return {
    status,
    scope: propertyId ?? "accessible tenant properties",
    linkSummary: summary,
    links: verifiedLinks.map((link) => ({
      propertyName: propertyById.get(link.property_id)?.name ?? "Property",
      currency: link.currency,
      status: link.status,
      verified: true,
    })),
    metrics,
    forecasts,
    anomalies,
    recommendations,
    limitations: [
      "Guest-level PII is not returned by this interface.",
      "Revenue and profitability remain subject to LB-03 posting, reversal and reconciliation acceptance.",
      "Recommendations are advisory; this interface does not create purchase orders or mutate source records.",
    ],
  };
}
