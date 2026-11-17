import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { listSuppliersSchema, upsertSupplierSchema } from "../core/contracts";
import { deactivateSupplierProductSchema, upsertSupplierProductSchema } from "./suppliers.server";

export const listRestaurantSuppliersFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listSuppliersSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./suppliers.server");
    return mod.listSuppliers(context.supabase, context.userId, data);
  });

export const listRestaurantSupplierProductsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ tenantId: z.string().uuid(), supplierId: z.string().uuid().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./suppliers.server");
    return mod.listSupplierProducts(context.supabase, context.userId, data.tenantId, data.supplierId);
  });

export const upsertRestaurantSupplierFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertSupplierSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./suppliers.server");
    return mod.upsertSupplier(context.supabase, context.userId, data);
  });

export const upsertRestaurantSupplierProductFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertSupplierProductSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./suppliers.server");
    return mod.upsertSupplierProduct(context.supabase, context.userId, data);
  });

export const deactivateRestaurantSupplierProductFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => deactivateSupplierProductSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./suppliers.server");
    return mod.deactivateSupplierProduct(context.supabase, context.userId, data);
  });
