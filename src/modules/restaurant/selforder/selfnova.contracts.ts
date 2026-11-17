import { z } from "zod";

/**
 * Ask NOVA — table-scoped only, exactly like every other guest-facing
 * contract in this module. Nothing about tenant/property/location/catalogue
 * data is ever accepted from the client; selfnova.server.ts re-derives the
 * entire menu from the resolved table before a single word reaches the
 * model.
 */
export const askNovaSchema = z.object({
  tableId: z.string().uuid(),
  message: z.string().trim().min(1).max(500),
  /** Bounded prior turns for a short back-and-forth — kept small so the request stays compact (requirement 10), not an open-ended chat log. */
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(2000),
      }),
    )
    .max(6)
    .optional(),
  /**
   * GEP2 — the guest's current basket, exactly as the client already
   * represents it (see selforder-cart.ts's CartLine), reduced to what NOVA
   * needs to resolve "remove"/"set_quantity"/"add another one" references.
   * A hint only, same trust model as everything else on this surface: the
   * server never derives price/availability/identity from it, only uses it
   * to know which real items are already in front of the guest.
   */
  basket: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(999),
      }),
    )
    .max(50)
    .optional(),
});
export type AskNovaInput = z.infer<typeof askNovaSchema>;
