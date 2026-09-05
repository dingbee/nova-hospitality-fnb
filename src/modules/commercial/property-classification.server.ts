/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P01 §14 — Property Commercial Classification Engine.
 *
 * Runs once, automatically, every time a property is added
 * (`masterdata.server.ts#upsertProperty` calls `classifyProperty` right
 * after insert). It never runs for an update to an existing property —
 * `commercial_property_classifications` records exactly one decision per
 * property, made at creation time (enforced by a unique index on
 * property_id); any later change in commercial treatment is a
 * `commercial_overrides` row plus an audit entry, never a second
 * classification row.
 *
 * Steps (spec §14, 1-13): identify subscription/plan → determine the
 * property's sequence number for this tenant → load the plan's (and, if
 * active, the programme's) property policy → check for an active
 * property-scoped or tenant-scoped commercial override → classify →
 * determine chargeability and price → record the decision → write the
 * audit entry. "A chargeable additional property must never silently
 * activate" — every path below either marks the property non-chargeable or
 * an explicit, audited, priced `additional_chargeable` row; there is no
 * path that charges without a resolvable price, and no path that skips the
 * audit entry.
 *
 * "An additional outlet within an already entitled property is not
 * automatically an additional chargeable property" — this engine is never
 * invoked for outlets (`restaurant_locations`) at all, only for properties
 * (`restaurant_properties`); outlet creation carries no commercial charge
 * by construction, exactly as the spec requires.
 */
import { writeCommercialAudit } from "./audit.server";
import type { PropertyClassification } from "./contracts";
import { getEffectiveSubscription } from "./subscription.server";

type Sb = any;

export interface PropertyClassificationResult {
  classification: PropertyClassification;
  chargeable: boolean;
  priceApplied: number | null;
  currency: string;
  propertySequence: number;
  requiresApproval: boolean;
  notes: string;
}

interface PropertyPolicyRow {
  included_properties: number;
  additional_property_price: number | null;
  property_limit: number | null;
  requires_approval_above: number | null;
  enterprise_treatment: boolean;
  plan_id: string;
  programme_id: string | null;
}

async function findPropertyPolicy(
  sb: Sb,
  planId: string,
  programmeId: string | null,
): Promise<PropertyPolicyRow | null> {
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from("commercial_property_policies")
    .select(
      "included_properties, additional_property_price, property_limit, requires_approval_above, enterprise_treatment, plan_id, programme_id",
    )
    .eq("plan_id", planId)
    .eq("status", "active")
    .lte("effective_from", nowIso)
    .or(`effective_until.is.null,effective_until.gt.${nowIso}`);
  if (error) throw new Error(error.message);
  const rows: PropertyPolicyRow[] = data ?? [];
  if (rows.length === 0) return null;
  const withProgramme = programmeId ? rows.find((r) => r.programme_id === programmeId) : null;
  return withProgramme ?? rows.find((r) => r.programme_id === null) ?? rows[0];
}

async function findPropertyOverride(sb: Sb, tenantId: string, propertyId: string) {
  const nowIso = new Date().toISOString();
  const { data } = await sb
    .from("commercial_overrides")
    .select("payload, reason")
    .eq("scope_type", "property")
    .eq("scope_id", propertyId)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .lte("effective_from", nowIso)
    .or(`effective_until.is.null,effective_until.gt.${nowIso}`)
    .maybeSingle();
  return data ?? null;
}

export async function classifyProperty(
  sb: Sb,
  userId: string,
  tenantId: string,
  propertyId: string,
): Promise<PropertyClassificationResult> {
  // 1. Identify subscription / plan / programme.
  const sub = await getEffectiveSubscription(sb, tenantId);

  // 2. Determine this property's sequence for the tenant (existing classified
  // properties + this one, ordered by when they were classified).
  const { count } = await sb
    .from("commercial_property_classifications")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  const propertySequence = (count ?? 0) + 1;

  // 3-4. Load the additional-property policy for this plan/programme.
  const policy = await findPropertyPolicy(sb, sub.planId, sub.programmeId);

  // 5. Check for an explicit commercial override on this exact property.
  const override = await findPropertyOverride(sb, tenantId, propertyId);

  let classification: PropertyClassification;
  let chargeable = false;
  let priceApplied: number | null = null;
  let requiresApproval = false;
  let notes: string;

  if (override) {
    classification = "override_covered";
    chargeable = Boolean(override.payload?.chargeable);
    priceApplied = typeof override.payload?.price === "number" ? override.payload.price : null;
    notes = `Commercial override applied: ${override.reason}`;
  } else if (propertySequence === 1) {
    classification = "base";
    notes = "First property for this tenant — base property, never chargeable.";
  } else if (policy && propertySequence <= policy.included_properties) {
    classification = "included";
    notes = `Within the ${sub.planCode.toUpperCase()} plan's included property allowance (${policy.included_properties}).`;
  } else if (policy?.enterprise_treatment) {
    classification = "enterprise";
    notes = "Enterprise plan property — commercial terms negotiated outside standard pricing.";
  } else if (sub.programmeId && policy?.programme_id === sub.programmeId) {
    classification = "programme_covered";
    notes = `Covered by the ${sub.programmeCode ?? "active"} programme's property policy.`;
  } else if (policy?.additional_property_price != null) {
    classification = "additional_chargeable";
    chargeable = true;
    priceApplied = policy.additional_property_price;
    requiresApproval =
      policy.requires_approval_above != null && propertySequence > policy.requires_approval_above;
    notes = `Property #${propertySequence} exceeds the ${sub.planCode.toUpperCase()} plan's ${policy.included_properties} included propert${policy.included_properties === 1 ? "y" : "ies"} — billed at the configured additional-property rate.`;
  } else {
    // No policy, or a policy with no configured additional-property price:
    // never fabricate a charge. Non-chargeable by default until an admin
    // configures a real price.
    classification = "additional_included";
    notes = policy
      ? "No additional-property price is configured for this plan — not billed until an admin sets one."
      : "No property policy is configured for this plan — not billed until an admin configures one.";
  }

  const { data: row, error } = await sb
    .from("commercial_property_classifications")
    .insert({
      tenant_id: tenantId,
      property_id: propertyId,
      subscription_id: sub.subscriptionId,
      plan_id: sub.planId,
      programme_id: sub.programmeId,
      classification,
      chargeable,
      price_applied: priceApplied,
      currency: "TZS",
      property_sequence: propertySequence,
      decided_by: userId,
      notes,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "property.classify",
    entityType: "commercial_property_classifications",
    entityId: row.id,
    tenantId,
    after: {
      propertyId,
      classification,
      chargeable,
      priceApplied,
      propertySequence,
      requiresApproval,
    },
    reason: notes,
  });

  // P02 §12 — a chargeable property is invoiced (as a draft — never
  // silently activated) the moment it's classified, so the customer can
  // see immediately why the charge exists. Never fabricates a price: only
  // runs when priceApplied is set, exactly the same guard classification
  // already applied above.
  if (chargeable && priceApplied != null) {
    const { recordPropertyCharge } = await import("./billing.server");
    await recordPropertyCharge(sb, userId, tenantId, row.id);
  }

  return {
    classification,
    chargeable,
    priceApplied,
    currency: "TZS",
    propertySequence,
    requiresApproval,
    notes,
  };
}
