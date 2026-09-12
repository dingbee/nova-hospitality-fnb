/**
 * P10 Phase 4 — device identity.
 *
 * A stable, locally-generated identifier for *this browser storage origin*,
 * persisted in IndexedDB (survives refresh/restart, unlike an in-memory
 * value) and bound to the tenant/property/outlet context it was first
 * registered under. This is not a request id and not a session token: it
 * identifies the physical/virtual terminal across many sessions and many
 * queued operations, and is carried in every queue entry's `deviceId` field
 * so the server-side audit trail (`emitRestaurantEvent`'s `source`/payload)
 * can distinguish "which till queued this" from "which staff member sent
 * it" (userId, resolved server-side from the bearer token — never from
 * anything this module writes).
 */
import { get, put, STORES } from "./db";

export interface DeviceIdentity {
  id: "device";
  deviceId: string;
  createdAt: string;
  /** The tenant/property/outlet this device was registered against. A
   * device is bound to exactly one tenant at a time — see
   * `reconcileDeviceContext` below for what happens when the signed-in
   * context no longer matches. */
  tenantId: string;
  propertyId: string | null;
  outletId: string | null;
  registeredAt: string;
  /** Bumped on every re-registration (tenant/outlet change, explicit
   * reset). Included in queue entries transitively via deviceId lookups so
   * a stale queued operation from before a reset is identifiable. */
  registrationEpoch: number;
}

function newDeviceId(): string {
  // crypto.randomUUID is available in every browser this PWA targets and in
  // Node 19+ (this repo's test runtime); no uuid dependency needed.
  return crypto.randomUUID();
}

/** Reads the currently-registered device identity, if any. Never creates
 * one — registration is a deliberate, online, authenticated action (see
 * `registerDevice`), not an implicit side effect of a read. */
export async function getDeviceIdentity(): Promise<DeviceIdentity | undefined> {
  return get<DeviceIdentity>(STORES.device, "device");
}

/**
 * Registers (or re-registers) this device against a tenant/property/outlet
 * context. Only ever called from an authenticated, online code path — this
 * function performs no authorization itself; the caller must already have
 * proven the current user may act in this scope via the normal server
 * function boundary (getDeviceIdentity/registerDevice never talk to
 * Supabase directly, so there is nothing here a malicious client could
 * intercept to fabricate a scope it wasn't actually granted — the moment
 * any queued operation reaches the server it is re-authorized exactly like
 * every other request).
 */
export async function registerDevice(context: {
  tenantId: string;
  propertyId: string | null;
  outletId: string | null;
}): Promise<DeviceIdentity> {
  const existing = await getDeviceIdentity();
  const now = new Date().toISOString();

  const identity: DeviceIdentity = {
    id: "device",
    deviceId: existing?.deviceId ?? newDeviceId(),
    createdAt: existing?.createdAt ?? now,
    tenantId: context.tenantId,
    propertyId: context.propertyId,
    outletId: context.outletId,
    registeredAt: now,
    registrationEpoch: (existing?.registrationEpoch ?? 0) + 1,
  };
  await put(STORES.device, identity);
  return identity;
}

export type DeviceContextChange =
  | { kind: "none" }
  | { kind: "unregistered" }
  | { kind: "tenant_changed"; from: string; to: string }
  | { kind: "outlet_changed"; from: string | null; to: string | null };

/**
 * P10 Phase 4/5 — "what happens when tenant context changes" /
 * "what happens when device changes". Compares the device's registered
 * scope against the currently-signed-in principal's scope. This never
 * silently rebinds the device: the caller is expected to block queueing
 * new offline operations and prompt a re-registration when this returns
 * anything other than `{ kind: "none" }`. It does not touch the existing
 * queue — a tenant/outlet change is surfaced as a conflict when that
 * specific queued item is synced (see conflict.ts's
 * "tenant/property/outlet mismatch" case), never silently discarded.
 */
export async function detectDeviceContextChange(current: {
  tenantId: string;
  propertyId: string | null;
  outletId: string | null;
}): Promise<DeviceContextChange> {
  const existing = await getDeviceIdentity();
  if (!existing) return { kind: "unregistered" };
  if (existing.tenantId !== current.tenantId) {
    return { kind: "tenant_changed", from: existing.tenantId, to: current.tenantId };
  }
  if (existing.outletId !== current.outletId) {
    return { kind: "outlet_changed", from: existing.outletId, to: current.outletId };
  }
  return { kind: "none" };
}
