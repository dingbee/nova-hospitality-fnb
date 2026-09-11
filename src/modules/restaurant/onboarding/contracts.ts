/**
 * P12 First-Run Experience — browser-safe contracts.
 *
 * Deliberately thin: onboarding orchestrates the existing authoritative
 * domains (restaurant_tenants, restaurant_properties, restaurant_locations)
 * rather than inventing a parallel configuration model. The only new
 * concept here is `settings.onboarding.operatingMode` — a value stored in
 * the tenant's existing `settings` jsonb column, the same place
 * `settings.business` and `settings.serviceRequests` already live.
 */
import { z } from "zod";
import { DEFAULT_CURRENCY, DEFAULT_TIMEZONE } from "../core/product";

const uuid = z.string().uuid();

/** §9 — operating-model business types. Influences later defaults/templates; never locks the tenant in. */
export const BUSINESS_TYPES = [
  "restaurant",
  "cafe",
  "bar",
  "hotel_restaurant",
  "fast_casual",
  "fine_dining",
  "quick_service",
  "multi_outlet_group",
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  restaurant: "Restaurant",
  cafe: "Café",
  bar: "Bar",
  hotel_restaurant: "Hotel restaurant",
  fast_casual: "Fast casual",
  fine_dining: "Fine dining",
  quick_service: "Quick service",
  multi_outlet_group: "Multi-outlet group",
};

/** §13 — service model. Determines which setup requirements are relevant. */
export const OPERATING_MODES = [
  "table_service",
  "counter_service",
  "bar_service",
  "quick_service",
] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

export const OPERATING_MODE_LABELS: Record<OperatingMode, string> = {
  table_service: "Table service",
  counter_service: "Counter service",
  bar_service: "Bar service",
  quick_service: "Quick service / takeaway",
};

export const SERVICE_FEATURES = ["guestQrOrdering", "kitchen", "bar", "takeaway"] as const;
export type ServiceFeature = (typeof SERVICE_FEATURES)[number];

export const SERVICE_FEATURE_LABELS: Record<ServiceFeature, string> = {
  guestQrOrdering: "Guest QR ordering",
  kitchen: "Kitchen production",
  bar: "Bar production",
  takeaway: "Takeaway / collection",
};

/**
 * §3/§13 closure — P13's fiscalisation readiness check
 * (`readiness.server.ts`) gates Tanzania-specific TRA requirements on
 * `settings.onboarding.country` matching the full country name (see its
 * `requiresFiscalisation` check), not an ISO code. This list stores that
 * same full-name string so the two modules agree — the onboarding form was
 * previously not collecting this field at all, silently leaving every
 * real signup's country unset and therefore every Tanzanian owner's
 * fiscalisation requirement invisible to them in P13.
 */
export const COUNTRIES = ["Tanzania", "Kenya", "Uganda", "Rwanda", "Other"] as const;
export type Country = (typeof COUNTRIES)[number];

export const bootstrapTenantSchema = z.object({
  name: z.string().trim().min(2, "Give your restaurant a name.").max(160),
  businessType: z.enum(BUSINESS_TYPES),
  country: z.string().max(60).optional(),
  currency: z.string().min(3).max(3).default(DEFAULT_CURRENCY),
  timezone: z.string().min(2).max(60).default(DEFAULT_TIMEZONE),
});
export type BootstrapTenantInput = z.infer<typeof bootstrapTenantSchema>;

export const createFirstOutletSchema = z.object({
  tenantId: uuid,
  propertyName: z.string().trim().min(2).max(160),
  outletName: z.string().trim().min(2).max(120),
});
export type CreateFirstOutletInput = z.infer<typeof createFirstOutletSchema>;

export const setOperatingModelSchema = z.object({
  tenantId: uuid,
  operatingMode: z.enum(OPERATING_MODES),
  serviceFeatures: z.array(z.enum(SERVICE_FEATURES)).default([]),
});
export type SetOperatingModelInput = z.infer<typeof setOperatingModelSchema>;

export const getOnboardingStatusSchema = z.object({
  tenantId: uuid,
});

/**
 * §20 — P12 onboarding funnel telemetry. Reuses the canonical restaurant
 * event system (`restaurant/events`) rather than a parallel analytics
 * engine; see `events/contracts.ts`'s `restaurant.onboarding.*` types.
 * `occurredAt` lets the client report the real moment a pre-tenant step
 * happened (entered/welcome_viewed/business_started) even though the
 * event itself can only be recorded once a tenant exists to scope it to
 * — the same deferred-identify pattern any analytics tool uses for
 * anonymous-then-identified events.
 */
export const ONBOARDING_EVENT_TYPES = [
  "restaurant.onboarding.entered",
  "restaurant.onboarding.welcome_viewed",
  "restaurant.onboarding.business.started",
  "restaurant.onboarding.business.completed",
  "restaurant.onboarding.property.started",
  "restaurant.onboarding.property.completed",
  "restaurant.onboarding.outlet.started",
  "restaurant.onboarding.outlet.completed",
  "restaurant.onboarding.operating_model.viewed",
  "restaurant.onboarding.operating_model.selected",
  "restaurant.onboarding.resumed",
  "restaurant.onboarding.completed",
  "restaurant.onboarding.p13_handoff.initiated",
  "restaurant.onboarding.p13_handoff.completed",
] as const;
export type OnboardingEventType = (typeof ONBOARDING_EVENT_TYPES)[number];

export const recordOnboardingEventSchema = z.object({
  tenantId: uuid,
  type: z.enum(ONBOARDING_EVENT_TYPES),
  /** Flat, non-PII fields only — never a business name or free text. */
  payload: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({}),
  occurredAt: z.string().datetime().optional(),
});
export type RecordOnboardingEventInput = z.infer<typeof recordOnboardingEventSchema>;
