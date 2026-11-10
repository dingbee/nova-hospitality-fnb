/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Room charge: the outlet's only route to a guest folio.
 *
 * Order of operations is deliberate and must not be reordered. The folio is
 * charged *first*; only a confirmed posting is allowed to become an outlet
 * payment. If the PMS refuses, nothing is recorded as settled and the till is
 * told to take another tender. If the PMS does not answer at all, the attempt
 * is left as `unknown` — never silently retried, never assumed paid — and it
 * surfaces at reconciliation as an exception a human must clear.
 */
import { assertCapability } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { folioIdempotencyKey, folioFailureMessage } from "@/domains/hospitality/folio/folio.rules";
import { loadPmsFolioPort } from "../core/ports/pms-folio.port";
import type { RoomChargeCommitInput, RoomChargeQuoteInput, RoomChargeSearchInput } from "./roomcharge.contracts";
import { takePosPayment } from "./pos.server";
import { getStayNasRoomChargeStatus, requestStayNasRoomChargeReversal } from "@/modules/restaurant/folio/lb03-client.server";
import { refundPayment } from "./bill.server";

type Sb = any;

async function loadOrder(sb: Sb, tenantId: string, orderId: string) {
  const { data } = await sb
    .from("restaurant_orders")
    .select("id, order_number, status, payment_state, total, paid_total, currency, location_id, property_id, table_id")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .single();
  if (!data) throw new Error("Order not found.");
  return data;
}

/** In-house stays this till may charge. Read-only, capability-gated. */
export async function searchRoomChargeTargets(sb: Sb, userId: string, input: RoomChargeSearchInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.room_charge");
  const { findChargeableStays } = await loadPmsFolioPort();
  return findChargeableStays(sb, userId, { tenantId: input.tenantId, query: input.query, limit: 20 });
}

/** Pre-flight: can this exact amount go to this exact folio, right now? */
export async function quoteRoomCharge(sb: Sb, userId: string, input: RoomChargeQuoteInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.room_charge");
  const order = await loadOrder(sb, input.tenantId, input.orderId);
  const outstanding = Number(order.total ?? 0) - Number(order.paid_total ?? 0);
  if (input.amount > outstanding + 0.001) {
    return { eligible: false, code: "invalid_amount", message: folioFailureMessage("invalid_amount"), stay: null };
  }
  const { validateRoomCharge } = await loadPmsFolioPort();
  return validateRoomCharge(sb, userId, {
    tenantId: input.tenantId,
    bookingId: input.bookingId,
    amount: input.amount,
    currency: String(order.currency ?? "TZS"),
  });
}

export async function commitRoomCharge(sb: Sb, userId: string, input: RoomChargeCommitInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.room_charge");
  const order = await loadOrder(sb, input.tenantId, input.orderId);
  const currency = String(order.currency ?? "TZS");
  const outstanding = Number(order.total ?? 0) - Number(order.paid_total ?? 0);
  if (input.amount > outstanding + 0.001) throw new Error(folioFailureMessage("invalid_amount"));

  const idempotencyKey = folioIdempotencyKey({
    tenantId: input.tenantId,
    orderId: input.orderId,
    splitBillId: input.splitBillId,
    clientRequestId: input.clientRequestId,
  });

  const adapter = await loadPmsFolioPort();
  const posting = await adapter.postRoomCharge(sb, userId, {
    bookingId: input.bookingId,
    amount: input.amount,
    currency,
    description: `Outlet charge — order ${order.order_number ?? order.id}`,
    idempotencyKey,
    source: {
      sourceSystem: "restaurant_pos",
      tenantId: input.tenantId,
      propertyId: order.property_id ?? undefined,
      locationId: order.location_id ?? undefined,
      orderId: input.orderId,
      correlationId: input.clientRequestId,
    },
  });

  const eventBase = {
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_order" as const,
    entityId: input.orderId,
    source: "restaurant-pos",
  };

  if (posting.status !== "posted") {
    await emitRestaurantEvent(sb, userId, {
      ...eventBase,
      type:
        posting.status === "unknown"
          ? "restaurant.payment.room_charge_unknown"
          : "restaurant.payment.room_charge_failed",
      payload: {
        order_number: order.order_number,
        booking_id: input.bookingId,
        amount: input.amount,
        currency,
        failure_code: posting.failureCode ?? null,
        idempotency_key: idempotencyKey,
      },
      dedupeKey: `roomcharge:${posting.status}:${idempotencyKey}`,
    });
    return {
      posted: false,
      status: posting.status,
      failureCode: posting.failureCode ?? "posting_rejected",
      message: posting.failureMessage ?? folioFailureMessage(posting.failureCode),
      order: null,
      receipt: null,
    };
  }

  // Only a confirmed folio posting becomes an outlet payment. The payment row
  // shares the till's request key, so a retry cannot double-record it either.
  const result = await takePosPayment(sb, userId, {
    tenantId: input.tenantId,
    orderId: input.orderId,
    clientRequestId: input.clientRequestId,
    method: "room_charge",
    amount: input.amount,
    reference: posting.postingReference ?? undefined,
    bookingId: input.bookingId,
    state: "room_charged",
    closeWhenSettled: input.closeWhenSettled,
  });

  // Link the local POS payment to the integration operation. StayNas folio
  // records are never updated from the LexiBite database.
  const { data: posPayment } = await sb
    .from("restaurant_payments")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", input.orderId)
    .eq("client_request_id", input.clientRequestId)
    .maybeSingle();
  if (posPayment?.id) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("lb03_pos_room_charge_operations")
      .update({ pos_payment_id: posPayment.id, updated_at: new Date().toISOString() })
      .eq("tenant_id", input.tenantId)
      .eq("order_id", input.orderId);
  }

  await emitRestaurantEvent(sb, userId, {
    ...eventBase,
    type: "restaurant.payment.room_charge_posted",
    payload: {
      order_number: order.order_number,
      booking_id: input.bookingId,
      amount: input.amount,
      currency,
      folio_reference: posting.folioReference ?? null,
      posting_reference: posting.postingReference ?? null,
      duplicate: posting.duplicate,
    },
    dedupeKey: `roomcharge:posted:${idempotencyKey}`,
  });

  return {
    posted: true,
    status: "posted" as const,
    duplicate: posting.duplicate,
    postingReference: posting.postingReference ?? null,
    folioReference: posting.folioReference ?? null,
    order: result.order,
    settled: result.settled,
    receipt: result.receipt,
  };
}

export async function requestRoomChargeReversal(sb:Sb,userId:string,input:import("./roomcharge.contracts").RoomChargeReversalInput){
 await assertCapability(sb,userId,input.tenantId,"sales.void");
 await loadOrder(sb,input.tenantId,input.orderId);
 const idempotencyKey=`roomcharge-reversal:${input.tenantId}:${input.orderId}:${input.clientRequestId}`;
 const result=await requestStayNasRoomChargeReversal({
  tenantId:input.tenantId,orderId:input.orderId,amount:input.amount,
  reasonCode:input.reasonCode,reason:input.reason,idempotencyKey
 });
 await emitRestaurantEvent(sb,userId,{
  tenantId:input.tenantId,entityType:"restaurant_order",entityId:input.orderId,
  source:"restaurant-pos",type:"restaurant.payment.room_charge_reversal_requested",
  payload:{amount:input.amount,reasonCode:input.reasonCode,status:result.status,requestId:result.requestId??null},
  dedupeKey:`roomcharge:reversal:${idempotencyKey}`
 });
 return result;
}

/** Finalize the POS-side compensating refund only after StayNas confirms its hotel-approved folio adjustment. */
export async function finalizeRoomChargeReversal(sb:Sb,userId:string,input:import("./roomcharge.contracts").RoomChargeReversalFinalizeInput){
 await assertCapability(sb,userId,input.tenantId,"sales.void");
 const truth=await getStayNasRoomChargeStatus({tenantId:input.tenantId,orderId:input.orderId});
 if(!truth.authoritative||!truth.operations.length)throw new Error("StayNas reversal status is not authoritatively available.");
 const operation=truth.operations[0] as any;
 if(!["PARTIALLY_REVERSED","REVERSED"].includes(operation.state))
  throw new Error("Hotel approval and folio adjustment are not complete.");
 const {data:payment}=await sb.from("restaurant_payments")
  .select("id,amount").eq("tenant_id",input.tenantId).eq("order_id",input.orderId)
  .eq("method","room_charge").is("refund_of",null).maybeSingle();
 if(!payment)throw new Error("The originating room-charge POS payment cannot be located.");
 const {data:refundRows}=await sb.from("restaurant_payments")
  .select("amount").eq("tenant_id",input.tenantId).eq("refund_of",payment.id).eq("state","refunded");
 const alreadyRefunded=((refundRows??[]) as Array<{amount:number}>).reduce((sum,row)=>sum+Math.abs(Number(row.amount)),0);
 const authorizedReversed=Number(operation.reversed_amount??0);
 const delta=Math.round((authorizedReversed-alreadyRefunded)*100)/100;
 if(delta<=0.001)return {refunded:false,duplicate:true,amount:alreadyRefunded,state:operation.state};
 if(delta>Math.abs(Number(payment.amount))-alreadyRefunded+0.001)
  throw new Error("StayNas reversal exceeds the remaining POS payment amount.");
 const refund=await refundPayment(sb,userId,{
  tenantId:input.tenantId,orderId:input.orderId,paymentId:payment.id,amount:delta,
  reason:`Hotel-approved StayNas folio adjustment ${operation.reversal_reference??""}`.trim(),
  clientRequestId:`lb03-refund:${input.orderId}:${Math.round(authorizedReversed*100)}`
 });
 return {refunded:true,duplicate:Boolean(refund.duplicate),amount:delta,state:operation.state,order:refund.order};
}
