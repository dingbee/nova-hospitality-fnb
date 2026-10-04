/** Receipt delivery RPC surface. Thin wrappers only. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { listDeliveriesSchema, requestDeliverySchema, sharedReceiptSchema } from "./delivery.types";

export const requestReceiptDeliveryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => requestDeliverySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./delivery.server");
    return mod.requestDelivery(context.supabase, context.userId, data);
  });

export const listReceiptDeliveriesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listDeliveriesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./delivery.server");
    return mod.listDeliveries(context.supabase, context.userId, data);
  });

export const receiptDeliveryProvidersFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const mod = await import("./delivery.server");
    return mod.providerStatus();
  });

/** Guest Portal: resolve/create an expiring link to the already-issued receipt for a fully-paid table order. */
export const getOrCreateGuestReceiptLinkFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    sharedReceiptSchema
      .extend({
        tableId: sharedReceiptSchema.shape.token.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const mod = await import("./delivery.server");
    return mod.getOrCreateGuestReceiptLink(data as { tableId: string; orderId: string });
  });


/** Token-scoped guest view of an issued receipt. Public by design. */
export const getSharedReceiptFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => sharedReceiptSchema.parse(d))
  .handler(async ({ data }) => {
    const mod = await import("./delivery.server");
    return mod.getSharedReceipt(data.token);
  });