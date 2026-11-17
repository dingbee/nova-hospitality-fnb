/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows / AI gateway payloads are untyped at this boundary. */
/**
 * P01 — AI commercial governance.
 *
 * Customers experience "Intelligence", never "token accounting" — this
 * module is the only place that changes. Internally, every AI workload
 * still goes through the same two steps as any other governed capability:
 *
 *   1. assertAiCapability — the capability (e.g. "menu_intelligence") must
 *      be entitled AND its linked quota (if the admin configured one) must
 *      not already be BLOCKED. Called BEFORE the provider request, so a
 *      blocked tenant never even reaches the model — no cost is incurred
 *      on a call that will be refused.
 *   2. recordAiUsage — called AFTER the provider responds, incrementing the
 *      linked quota counter by one request and writing a row to
 *      commercial_ai_usage_log with the real token/cost numbers, for cost
 *      visibility, fair-use governance and future margin/billing analysis.
 *      This is the ONLY place raw model economics are recorded — nothing
 *      here is ever surfaced to a restaurant user.
 */
import { assertEntitled } from "./resolver.server";
import { incrementUsage, findQuotaCodeForCapability } from "./quota.server";
import { QuotaExceededError } from "./quota.server";

type Sb = any;

export interface AiUsageInput {
  tenantId: string;
  propertyId?: string | null;
  locationId?: string | null;
  userId: string | null;
  capabilityCode: string;
  model: string;
  provider: string;
  workloadType: string;
  requestCount?: number;
  inputUsage?: number;
  outputUsage?: number;
  estimatedCost?: number;
  currency?: string;
}

/** Call before making the provider request. Throws QuotaExceededError or CommercialEntitlementError if this workload must not proceed. */
export async function assertAiCapability(
  sb: Sb,
  tenantId: string,
  capabilityCode: string,
  propertyId?: string | null,
): Promise<void> {
  // assertEntitled throws for a nonexistent/deprecated/unavailable
  // capability, so the lookup below is guaranteed to find a row.
  await assertEntitled(sb, tenantId, capabilityCode, { propertyId });
  const { data: capability } = await sb
    .from("commercial_capabilities")
    .select("id")
    .eq("code", capabilityCode)
    .single();
  const quotaCode = await findQuotaCodeForCapability(sb, tenantId, capability.id);
  if (quotaCode) {
    // Pre-flight increment: reserves the request against the quota before
    // any provider cost is incurred. If the provider call itself fails,
    // the reservation still stands — the tenant asked for the workload and
    // got a real attempt, which is the correct unit to meter.
    await incrementUsage(sb, tenantId, quotaCode, { propertyId, amount: 1 });
  }
}

/** Call after the provider responds (success or failure) to record real usage for cost visibility and margin management. */
export async function recordAiUsage(sb: Sb, usage: AiUsageInput): Promise<void> {
  const { error } = await sb.from("commercial_ai_usage_log").insert({
    tenant_id: usage.tenantId,
    property_id: usage.propertyId ?? null,
    location_id: usage.locationId ?? null,
    user_id: usage.userId,
    capability_code: usage.capabilityCode,
    model: usage.model,
    provider: usage.provider,
    workload_type: usage.workloadType,
    request_count: usage.requestCount ?? 1,
    input_usage: usage.inputUsage ?? 0,
    output_usage: usage.outputUsage ?? 0,
    estimated_cost: usage.estimatedCost ?? 0,
    currency: usage.currency ?? "USD",
  });
  if (error) console.warn("[commercial] AI usage log not recorded", error.message);
}

export { QuotaExceededError };
