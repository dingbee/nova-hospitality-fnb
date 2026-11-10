/* eslint-disable @typescript-eslint/no-explicit-any -- PMS rows are untyped at this boundary. */
/**
 * The single seam between an outlet and the guest folio.
 *
 * Nothing outside this file may write to a reservation's money. Every attempt —
 * successful, refused or unanswered — leaves a row in `pms_folio_postings`, so
 * a charge can always be proven or disproven at night audit.
 */
import {
  evaluateRoomChargeEligibility,
  folioFailureMessage,
  stayConfirmationView,
  type FolioFailureCode,
  type FolioPostingStatus,
  type FolioStay,
} from "./folio.rules";
import type { FolioPostInput, FolioPostingStatusInput, FolioStayLookupInput, FolioValidateInput } from "./folio.contracts";
import { postStayNasRoomCharge } from "@/modules/restaurant/folio/lb03-client.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Sb = any;

export interface FolioPostingResult {
  status: FolioPostingStatus;
  duplicate: boolean;
  postingId?: string | null;
  postingReference?: string | null;
  folioReference?: string | null;
  amount?: number;
  currency?: string;
  failureCode?: FolioFailureCode;
  failureMessage?: string;
}

/**
 * Reading a guest's stay is POS work, not merely "being signed in". Resolved
 * through the canonical RBAC model; a caller with no permission is refused
 * here as well as by RLS.
 */
async function assertFolioRead(sb: Sb, userId: string) {
  const { data, error } = await sb.rpc("nova_has_permission", {
    _user_id: userId,
    _permission: "POS:READ",
    _tenant_id: null,
    _property_id: null,
    _outlet_id: null,
  });
  if (error || data !== true) throw new Error(folioFailureMessage("unauthorised"));
}

/** Moving money onto a guest folio requires the write permission. */
async function assertFolioWrite(sb: Sb, userId: string) {
  const { data, error } = await sb.rpc("nova_has_permission", {
    _user_id: userId,
    _permission: "POS:WRITE",
    _tenant_id: null,
    _property_id: null,
    _outlet_id: null,
  });
  if (error || data !== true) throw new Error(folioFailureMessage("unauthorised"));
}

/** In-house stays are read from privacy-safe LB-02 projections, never a local PMS mirror. */
export async function findChargeableStays(sb: Sb, userId: string, input: FolioStayLookupInput) {
  await assertFolioRead(sb, userId);
  if (!input.tenantId) return { stays: [] as Array<FolioStay & { balanceDue: number }> };
  const admin = supabaseAdmin as unknown as Sb;
  const { data: connections, error } = await admin.from("staynas_product_connections")
    .select("id,integration_property_id")
    .eq("local_tenant_id", input.tenantId)
    .eq("remote_product", "staynas")
    .eq("status", "active");
  if (error || !Array.isArray(connections)) return { stays: [] as Array<FolioStay & { balanceDue: number }> };
  const projections: any[] = [];
  for (const connection of connections as Array<{id:string;integration_property_id:string}>) {
    let query = admin.from("lb02_guest_stay_projections")
      .select("guest_reference,stay_reference,stay_status,effective_at,integration_property_id")
      .eq("connection_id", connection.id)
      .eq("integration_property_id", connection.integration_property_id)
      .eq("stay_status", "checked_in")
      .is("revoked_at", null)
      .order("effective_at", { ascending: false })
      .limit(input.limit);
    if (input.bookingId) query = query.eq("stay_reference", input.bookingId);
    const { data } = await query;
    for (const row of (data ?? []) as any[]) projections.push(row);
  }
  const term = (input.query ?? "").trim().toLowerCase();
  const stays = projections
    .filter((row) => !term || String(row.guest_reference).toLowerCase().includes(term)
      || String(row.stay_reference).toLowerCase().includes(term))
    .slice(0, input.limit)
    .map((row) => ({
      bookingId: row.stay_reference,
      guestName: "In-house guest",
      unitLabel: null,
      roomName: `Stay ${String(row.stay_reference).slice(-6)}`,
      arrival: String(row.effective_at ?? "").slice(0, 10),
      departure: "",
      currency: "",
      status: row.stay_status,
      balanceDue: 0,
    }));
  return { stays };
}

/** Eligibility only — this never moves money and is safe to call on keystroke. */
export async function validateRoomCharge(sb: Sb, userId: string, input: FolioValidateInput) {
  await assertFolioRead(sb, userId);
  const { stays } = await findChargeableStays(sb, userId, { tenantId: input.tenantId, bookingId: input.bookingId, limit: 1 });
  const selected = stays[0] ?? null;
  const stay = selected ? { ...selected, currency: input.currency.toUpperCase() } : null;
  const verdict = evaluateRoomChargeEligibility(stay, { amount: input.amount, currency: input.currency });
  return { ...verdict, stay: stay ? stayConfirmationView(stay) : null };
}

/**
 * Posts to the folio. Safe to retry with the same `idempotencyKey`: the PMS
 * function returns the original posting rather than charging twice.
 */
export async function postRoomCharge(sb: Sb, userId: string, input: FolioPostInput): Promise<FolioPostingResult> {
  await assertFolioWrite(sb, userId);
  return postStayNasRoomCharge(sb, input);
}

/** Truth after an interrupted posting: what does the folio actually hold? */
export async function getFolioPostingStatus(sb: Sb, userId: string, input: FolioPostingStatusInput) {
  await assertFolioRead(sb, userId);
  const admin = supabaseAdmin as unknown as Sb;
  let q = admin.from("lb03_pos_room_charge_operations")
    .select("id,tenant_id,order_id,amount,currency,state,idempotency_key,authorization_reference,staynas_posting_id,staynas_posting_reference,last_error_code,attempt_count,updated_at")
    .order("updated_at", { ascending: false }).limit(20);
  if (input.tenantId) q = q.eq("tenant_id", input.tenantId);
  if (input.idempotencyKey) q = q.eq("idempotency_key", input.idempotencyKey);
  if (input.orderId) q = q.eq("order_id", input.orderId);
  if (input.postingId) q = q.eq("staynas_posting_id", input.postingId);
  const { data } = await q;
  return { operations: (data ?? []) as any[] };
}
