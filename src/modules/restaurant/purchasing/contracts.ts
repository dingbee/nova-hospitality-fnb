/**
 * Purchasing read contracts (Sprint 5.5 completion) — browser-safe.
 *
 * The purchase order is the anchor document of the procurement lifecycle:
 * confirmation, receiving and invoicing are separate facts that hang off it.
 * This contract only adds a *read*; every mutation keeps its existing owner.
 */
import { z } from "zod";

const uuid = z.string().uuid();

export const getPurchaseOrderDetailSchema = z.object({ tenantId: uuid, id: uuid });
export type GetPurchaseOrderDetailInput = z.infer<typeof getPurchaseOrderDetailSchema>;