/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P08 — /api/v1/orders. Thin wrappers over the EXISTING canonical order
 * modules (src/modules/restaurant/sales/pos.server.ts, sales.server.ts,
 * orderScope.server.ts) — no order/POS business logic is duplicated here.
 *
 * Two of those functions (getOrder, transitionOrder) validate tenant
 * membership only, not property scope (see their own implementations) —
 * safe for a human caller because Postgres RLS is still the backstop
 * behind them. This module's own request path always uses the
 * service-role admin client (bypasses RLS by necessity — see
 * credentials.server.ts's header comment), so THIS file adds the missing
 * property-scope check itself, using only the resolved credential's own
 * property_id — never a client-supplied one.
 */
import { openPosOrder } from "@/modules/restaurant/sales/pos.server";
import { getOrder, listOrders, transitionOrder } from "@/modules/restaurant/sales/sales.server";
import { resolveOrderScope } from "@/modules/restaurant/sales/orderScope.server";
import { assertCredentialCoversProperty, requireScope } from "../scope.server";
import { enqueueWebhookEvent } from "../webhooks.server";
import { sha256Hex } from "../crypto.server";
import { ApiError } from "../errors";
import type { ApiCreateOrderInput } from "../contracts";
import type { ResolvedCredential } from "../credentials.server";

export async function apiCreateOrder(
  supabaseAdmin: any,
  credential: ResolvedCredential,
  input: ApiCreateOrderInput,
  idempotencyKey: string,
) {
  requireScope(credential, "orders:write");

  const scope = await resolveOrderScope(supabaseAdmin, credential.tenantId, {
    tableId: input.tableId ?? null,
    propertyId: credential.propertyId,
    locationId: null,
  });
  assertCredentialCoversProperty(credential, scope.propertyId);

  // Deterministic, bounded-length (openPosOrderSchema caps clientRequestId
  // at 80 chars) key derived from the caller's own Idempotency-Key, so a
  // retried POST with the same header ALSO short-circuits inside
  // openPosOrder's own native idempotency (belt-and-braces with the
  // router's generic Idempotency-Key wrapper — see router.server.ts).
  const clientRequestId = `api:${credential.id.slice(0, 8)}:${sha256Hex(idempotencyKey).slice(0, 32)}`;

  const order = await openPosOrder(supabaseAdmin, credential.serviceUserId, {
    tenantId: credential.tenantId,
    propertyId: scope.propertyId ?? credential.propertyId ?? undefined,
    locationId: scope.locationId ?? undefined,
    tableId: input.tableId,
    orderType: input.orderType,
    guestCount: input.guestCount,
    guestName: input.guestName,
    currency: input.currency,
    clientRequestId,
    terminalId: `api:${credential.id}`,
    lines: input.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      menuItemId: l.menuItemId,
      course: l.course,
      notes: l.notes,
      discount: 0,
      modifiers: [],
    })),
  } as any);

  if (!order.idempotent) {
    await enqueueWebhookEvent(supabaseAdmin, {
      tenantId: credential.tenantId,
      propertyId: scope.propertyId ?? null,
      eventType: "order.created",
      payload: {
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        total: order.total,
        currency: order.currency,
      },
    });
  }
  return order;
}

export async function apiGetOrder(
  supabaseAdmin: any,
  credential: ResolvedCredential,
  orderId: string,
) {
  requireScope(credential, "orders:read");
  const result = await getOrder(supabaseAdmin, credential.serviceUserId, {
    tenantId: credential.tenantId,
    orderId,
  });
  assertCredentialCoversProperty(credential, result.order?.property_id ?? null);
  return result;
}

export async function apiListOrders(
  supabaseAdmin: any,
  credential: ResolvedCredential,
  input: { status?: string; limit: number },
) {
  requireScope(credential, "orders:read");
  return listOrders(supabaseAdmin, credential.serviceUserId, {
    tenantId: credential.tenantId,
    propertyId: credential.propertyId ?? undefined,
    status: input.status as any,
    limit: input.limit,
  });
}

export async function apiTransitionOrderStatus(
  supabaseAdmin: any,
  credential: ResolvedCredential,
  orderId: string,
  input: { status: string; reason?: string },
) {
  requireScope(credential, "orders:write");

  const { data: existing } = await supabaseAdmin
    .from("restaurant_orders")
    .select("id, property_id, status")
    .eq("tenant_id", credential.tenantId)
    .eq("id", orderId)
    .maybeSingle();
  if (!existing) throw new ApiError("not_found", "Order not found.");
  assertCredentialCoversProperty(credential, existing.property_id ?? null);

  const result = await transitionOrder(supabaseAdmin, credential.serviceUserId, {
    tenantId: credential.tenantId,
    orderId,
    status: input.status as any,
    reason: input.reason,
  });

  await enqueueWebhookEvent(supabaseAdmin, {
    tenantId: credential.tenantId,
    propertyId: existing.property_id ?? null,
    eventType: "order.status_changed",
    payload: { orderId, status: input.status, previousStatus: existing.status },
  });
  return result;
}
