/**
 * Master Data Workbench contracts — browser-safe.
 */
import { z } from "zod";
import { DEFAULT_CURRENCY, DEFAULT_TIMEZONE } from "../core/product";

const uuid = z.string().uuid();

export const upsertPropertySchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  name: z.string().min(2).max(160),
  slug: z.string().min(2).max(120).regex(/^[a-z0-9-]+$/),
  timezone: z.string().min(2).max(60).default(DEFAULT_TIMEZONE),
  currency: z.string().min(3).max(3).default(DEFAULT_CURRENCY),
  status: z.string().max(30).default("active"),
});
export type UpsertPropertyInput = z.infer<typeof upsertPropertySchema>;

export const upsertBusinessProfileSchema = z.object({
  tenantId: uuid,
  legalName: z.string().min(2).max(200),
  tradingName: z.string().max(200).optional(),
  code: z.string().max(40).optional(),
  taxId: z.string().max(80).optional(),
  defaultCurrency: z.string().min(3).max(3).default(DEFAULT_CURRENCY),
  timezone: z.string().min(2).max(60).default(DEFAULT_TIMEZONE),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional(),
  address: z.string().max(400).optional(),
});
export type UpsertBusinessProfileInput = z.infer<typeof upsertBusinessProfileSchema>;

export const listInventoryCategoriesSchema = z.object({
  tenantId: uuid,
  kind: z.string().max(40).optional(),
});

export const upsertInventoryUnitSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  code: z.string().min(1).max(20),
  name: z.string().min(2).max(80),
  dimension: z.string().min(2).max(40).default("count"),
  baseUnitId: uuid.nullish(),
  factor: z.number().min(0.000001).default(1),
});
export type UpsertInventoryUnitInput = z.infer<typeof upsertInventoryUnitSchema>;

export const upsertInventoryCategorySchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  parentId: uuid.nullish(),
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(120).regex(/^[a-z0-9-]+$/),
  kind: z.string().min(2).max(40).default("ingredient"),
  sortOrder: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});
export type UpsertInventoryCategoryInput = z.infer<typeof upsertInventoryCategorySchema>;

export const upsertProductCategorySchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  propertyId: uuid.optional(),
  parentId: uuid.nullish(),
  kind: z.string().min(2).max(40).default("menu"),
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(120).regex(/^[a-z0-9-]+$/),
  description: z.string().max(500).optional(),
  sortOrder: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});
export type UpsertProductCategoryInput = z.infer<typeof upsertProductCategorySchema>;

export const listAllMasterDataSchema = z.object({ tenantId: uuid });
