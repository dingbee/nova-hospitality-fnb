/**
 * Guest "request bill" contract — table + order id only, mirroring every
 * other guest contract in this module (selforder.contracts.ts,
 * selfpay.contracts.ts). No tenant/property/location, no order status, no
 * timestamp, no staff identity — every one of those is derived server-side
 * from the table/order lookup, never accepted from the client.
 */
import { z } from "zod";

const uuid = z.string().uuid();

export const requestGuestBillSchema = z.object({
  tableId: uuid,
  orderId: uuid,
});
export type RequestGuestBillInput = z.infer<typeof requestGuestBillSchema>;
