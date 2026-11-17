import { z } from "zod";

export const commercialProviderStatus = z.enum(["enabled", "disabled"]);
export const commercialProviderCategory = z.enum([
  "payments",
  "mobile_money",
  "fiscal",
  "notifications",
  "api",
]);

export const upsertCommercialProviderSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().min(2).max(80).regex(/^[a-z0-9_]+$/),
  name: z.string().min(2).max(120),
  category: commercialProviderCategory,
  integrationType: z.string().min(2).max(80),
  description: z.string().max(500).default(""),
  status: commercialProviderStatus.default("enabled"),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});

export const updateCommercialProviderStatusSchema = z.object({
  id: z.string().uuid(),
  status: commercialProviderStatus,
});

export type UpsertCommercialProviderInput = z.infer<typeof upsertCommercialProviderSchema>;
export type UpdateCommercialProviderStatusInput = z.infer<typeof updateCommercialProviderStatusSchema>;
