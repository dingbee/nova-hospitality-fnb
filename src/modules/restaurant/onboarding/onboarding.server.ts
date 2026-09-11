/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P12 First-Run Experience — server module.
 *
 * Two things happen here that don't happen anywhere else in the app:
 *
 * 1. `bootstrapTenant` — the one genuinely new authoritative write. A
 *    brand-new authenticated user holds no `restaurant_members` row
 *    anywhere, so the ordinary RLS-scoped path (`restaurant_can_write`)
 *    can never let them create their first tenant — a real chicken-and-egg
 *    problem. `restaurant_bootstrap_tenant` (migration 0049) is the single,
 *    narrow SECURITY DEFINER function that solves it: it derives the owner
 *    strictly from `auth.uid()`, never a parameter, so a caller can only
 *    ever make themselves the owner of a brand-new tenant.
 *
 * 2. Everything after that (property, outlet, operating model) goes
 *    through the *existing* authoritative functions
 *    (upsertProperty/upsertLocation, or the same settings-merge pattern
 *    upsertBusinessProfile already uses) — because the caller now genuinely
 *    holds the 'owner' role those functions check. No parallel
 *    configuration engine.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { upsertProperty } from "../masterdata/masterdata.server";
import { upsertLocation } from "../inventory/locations.server";
import type {
  bootstrapTenantSchema,
  createFirstOutletSchema,
  setOperatingModelSchema,
} from "./contracts";

type Sb = any;

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base.length >= 2 ? base : "restaurant";
}

export async function bootstrapTenant(
  sb: Sb,
  _userId: string,
  input: z.infer<typeof bootstrapTenantSchema>,
): Promise<{ tenantId: string; memberId: string; slug: string }> {
  const baseSlug = slugify(input.name);
  let slug = baseSlug;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data, error } = await sb.rpc("restaurant_bootstrap_tenant", {
      _name: input.name,
      _slug: slug,
      _timezone: input.timezone,
      _currency: input.currency,
      _country: input.country ?? null,
      _business_type: input.businessType,
    });
    if (!error) {
      const row = (Array.isArray(data) ? data[0] : data) as
        { tenant_id: string; member_id: string } | undefined;
      if (!row?.tenant_id) {
        throw new Error("Couldn't create your restaurant. Please try again.");
      }
      return { tenantId: row.tenant_id, memberId: row.member_id, slug };
    }
    if (/already taken/i.test(error.message) && attempt < 3) {
      slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
      continue;
    }
    throw new Error(error.message);
  }
  throw new Error(
    "Couldn't find an available name for your restaurant. Please try a different name.",
  );
}

/**
 * §10-12 — single-outlet-optimized property + outlet creation in one call.
 * A first-time owner with one restaurant should never have to understand
 * "property vs outlet" as two separate decisions; this creates both from
 * the two names the wizard actually asks for. Reuses upsertProperty and
 * upsertLocation exactly as the (multi-outlet-aware) Setup Workbench does
 * for every later property/outlet a tenant adds — the underlying hierarchy
 * is unchanged, only the first-run UX collapses it.
 */
export async function createFirstOutlet(
  sb: Sb,
  userId: string,
  input: z.infer<typeof createFirstOutletSchema>,
) {
  const property = await upsertProperty(sb, userId, {
    tenantId: input.tenantId,
    name: input.propertyName,
    slug: slugify(input.propertyName),
    timezone: "Africa/Dar_es_Salaam",
    currency: "TZS",
    status: "active",
  });

  const location = await upsertLocation(sb, userId, {
    tenantId: input.tenantId,
    propertyId: property.id,
    name: input.outletName,
    slug: slugify(input.outletName),
    locationType: "restaurant",
    isStorage: false,
    active: true,
  });

  return { propertyId: property.id as string, locationId: location.id as string };
}

export async function setOperatingModel(
  sb: Sb,
  userId: string,
  input: z.infer<typeof setOperatingModelSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const { data: tenant, error: readErr } = await sb
    .from("restaurant_tenants")
    .select("settings")
    .eq("id", input.tenantId)
    .single();
  if (readErr) throw new Error(readErr.message);
  const existing = (tenant?.settings ?? {}) as Record<string, any>;
  const settings = {
    ...existing,
    onboarding: {
      ...(existing.onboarding ?? {}),
      operatingMode: input.operatingMode,
      serviceFeatures: input.serviceFeatures,
    },
  };
  const { data, error } = await sb
    .from("restaurant_tenants")
    .update({ settings })
    .eq("id", input.tenantId)
    .select("id, name, slug, settings")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export type OnboardingStage = "property" | "outlet" | "operating_model" | "ready";

export interface OnboardingStatus {
  tenantId: string;
  stage: OnboardingStage;
  percentComplete: number;
  businessName: string | null;
  businessType: string | null;
  property: { done: boolean; count: number };
  outlet: { done: boolean; count: number };
  operatingModel: { done: boolean; value: string | null; features: string[] };
}

/**
 * §15/§17/§19 — progress derived from live rows, exactly like Setup
 * Workbench's own doc comment: "never from a stored step". This is what
 * makes resumability free: leave after creating the business, come back
 * next week, this recomputes the same true stage from the same rows.
 */
export async function getOnboardingStatus(
  sb: Sb,
  userId: string,
  tenantId: string,
): Promise<OnboardingStatus> {
  await assertTenantRead(sb, userId, tenantId);
  const [
    { data: tenant, error: tErr },
    { data: properties, error: pErr },
    { data: locations, error: lErr },
  ] = await Promise.all([
    sb.from("restaurant_tenants").select("id, name, settings").eq("id", tenantId).single(),
    sb.from("restaurant_properties").select("id").eq("tenant_id", tenantId),
    sb.from("restaurant_locations").select("id").eq("tenant_id", tenantId),
  ]);
  if (tErr) throw new Error(tErr.message);
  if (pErr) throw new Error(pErr.message);
  if (lErr) throw new Error(lErr.message);

  const settings = (tenant?.settings ?? {}) as {
    onboarding?: {
      businessType?: string | null;
      operatingMode?: string | null;
      serviceFeatures?: string[] | null;
    };
  };
  const propertyCount = (properties ?? []).length;
  const outletCount = (locations ?? []).length;
  const operatingModeValue = settings.onboarding?.operatingMode ?? null;

  const steps = [propertyCount > 0, outletCount > 0, Boolean(operatingModeValue)];
  const percentComplete = Math.round((steps.filter(Boolean).length / steps.length) * 100);

  let stage: OnboardingStage = "property";
  if (propertyCount === 0) stage = "property";
  else if (outletCount === 0) stage = "outlet";
  else if (!operatingModeValue) stage = "operating_model";
  else stage = "ready";

  return {
    tenantId,
    stage,
    percentComplete,
    businessName: tenant?.name ?? null,
    businessType: settings.onboarding?.businessType ?? null,
    property: { done: propertyCount > 0, count: propertyCount },
    outlet: { done: outletCount > 0, count: outletCount },
    operatingModel: {
      done: Boolean(operatingModeValue),
      value: operatingModeValue,
      features: settings.onboarding?.serviceFeatures ?? [],
    },
  };
}
