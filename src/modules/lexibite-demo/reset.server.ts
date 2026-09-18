/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * LexiBite Demo Access — deterministic reset (P02.4 §11).
 *
 * Never a public endpoint. Gated by the existing, narrow, platform-wide
 * commercial-admin allow-list (src/modules/commercial/access.server.ts) —
 * the same mechanism already used for every other platform-level operation
 * in this codebase — checked here AND again inside
 * restaurant_reset_demo_environment() itself (defense in depth: even a
 * caller who reached this function through some other path than
 * resetDemoEnvironmentFn still hits the same SQL-level check).
 *
 * Scope: only the guest-self-order write surface (orders/order_items/
 * kitchen_tickets/payments created after the last reset) and expired demo
 * viewer memberships. Explicitly does NOT touch inventory stock movements —
 * see the Nolmark integration doc's "known limitations" section for why a
 * full ledger-accurate rollback is out of scope for this pass.
 */
import { assertCommercialAdmin } from "@/modules/commercial/access.server";

type Sb = any;

export interface DemoResetReport {
  ordersDeleted: number;
  orderItemsDeleted: number;
  paymentsDeleted: number;
  kitchenTicketsDeleted: number;
  membershipsRevoked: number;
  dryRun: boolean;
}

export async function resetDemoEnvironment(
  sb: Sb,
  userId: string,
  dryRun = true,
): Promise<DemoResetReport> {
  await assertCommercialAdmin(sb, userId);
  const { data, error } = await sb.rpc("restaurant_reset_demo_environment", { _dry_run: dryRun });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        orders_deleted: number;
        order_items_deleted: number;
        payments_deleted: number;
        kitchen_tickets_deleted: number;
        memberships_revoked: number;
        dry_run: boolean;
      }
    | undefined;
  if (!row) throw new Error("Reset did not return a report.");
  return {
    ordersDeleted: row.orders_deleted,
    orderItemsDeleted: row.order_items_deleted,
    paymentsDeleted: row.payments_deleted,
    kitchenTicketsDeleted: row.kitchen_tickets_deleted,
    membershipsRevoked: row.memberships_revoked,
    dryRun: row.dry_run,
  };
}
