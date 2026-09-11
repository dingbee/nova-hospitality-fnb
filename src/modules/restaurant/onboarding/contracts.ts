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

export const bootstrapTenantSchema = z.object({
  name: z.string().trim().min(2, "Give your restaurant a name.").max(160),
  businessType: z.enum(BUSINESS_TYPES),
  country: z.string().max(2).optional(),
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
