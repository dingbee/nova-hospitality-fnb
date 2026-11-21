import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { guestLineSchema } from "@/modules/restaurant/selforder/selforder.contracts";

export const guestPortalMenuSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** Browse-only WhatsApp landing page. Scope is derived exclusively from the one-time bearer session. */
export const guestPortalMenuFn = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => guestPortalMenuSchema.parse(value))
  .handler(async ({ data }) => {
    const { guestPortalMenu } = await import("./guest-portal.server");
    return guestPortalMenu(data);
  });

export const submitGuestCommerceOrderSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  guestName: z.string().trim().max(160).optional(),
  clientRequestId: z.string().min(8).max(80),
  lines: z.array(guestLineSchema).min(1).max(50),
});

/** WCE-04: submit a takeaway order through the existing authoritative sales engine. */
export const submitGuestCommerceOrderFn = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => submitGuestCommerceOrderSchema.parse(value))
  .handler(async ({ data }) => {
    const { submitGuestCommerceOrder } = await import("./guest-portal.server");
    return submitGuestCommerceOrder(data);
  });

export type GuestPortalMenuInput = z.infer<typeof guestPortalMenuSchema>;
export type SubmitGuestCommerceOrderInput = z.infer<typeof submitGuestCommerceOrderSchema>;
