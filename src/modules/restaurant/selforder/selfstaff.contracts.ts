import { z } from "zod";

/**
 * Guest "request staff" / status lookup — table + order id only, exactly
 * like every other guest-facing contract in this module. Nothing about
 * tenant/property/location/request status/timestamps/staff identity is
 * ever accepted from the client; selfstaff.server.ts re-derives all of it
 * from the resolved table.
 */
export const requestStaffSchema = z.object({
  tableId: z.string().uuid(),
  orderId: z.string().uuid(),
});
export type RequestStaffInput = z.infer<typeof requestStaffSchema>;
