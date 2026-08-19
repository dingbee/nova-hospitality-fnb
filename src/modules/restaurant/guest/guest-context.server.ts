/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 5.11 — guest-aware service context.
 * Allergies and dietary requirements are safety data: they are never inferred
 * silently, never auto-confirmed, and always surface as a warning rather than
 * a promise of safety.
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import {
  conflictsWithDiet,
  parseGuestStatement,
  promoteState,
  type GuestContextState,
  type GuestDietaryEntry,
} from "./dietary";
import { checkAgainstGuestAllergies } from "../menu/allergens";
import { buildAllergenContext, resolveMenuItemAllergens } from "../menu/allergens.server";
import type { CaptureStatementInput, GuestContextInput, RecordGuestContextInput } from "./guest-context.contracts";

type Sb = any;

const toEntry = (r: any): GuestDietaryEntry => ({
  id: r.id,
  guestId: r.guest_id,
  kind: r.kind,
  key: r.key,
  value: r.value,
  state: (r.state ?? "observed") as GuestContextState,
  confidence: r.confidence == null ? null : Number(r.confidence),
  severity: r.severity ?? null,
  source: r.source ?? "manual",
  observedCount: Number(r.observed_count ?? 1),
});

async function resolveGuestId(sb: Sb, input: GuestContextInput): Promise<string | null> {
  if (input.guestId) return input.guestId;
  if (input.bookingId) {
    const { data } = await sb.from("bookings").select("guest_id").eq("id", input.bookingId).maybeSingle();
    return data?.guest_id ?? null;
  }
  if (input.orderId) {
    const { data } = await sb
      .from("restaurant_orders")
      .select("guest_id, booking_id")
      .eq("id", input.orderId)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    if (data?.guest_id) return data.guest_id;
    if (data?.booking_id) {
      const { data: b } = await sb.from("bookings").select("guest_id").eq("id", data.booking_id).maybeSingle();
      return b?.guest_id ?? null;
    }
  }
  return null;
}

export interface GuestServiceContext {
  guestId: string | null;
  guestName: string | null;
  entries: GuestDietaryEntry[];
  allergies: string[];
  diets: string[];
  dislikes: string[];
  /** True when nothing is known — the UI must say "unknown", not "no allergies". */
  unknown: boolean;
}

export async function getGuestServiceContext(
  sb: Sb,
  userId: string,
  input: GuestContextInput,
): Promise<GuestServiceContext> {
  await assertCapability(sb, userId, input.tenantId, "guest.context.read");
  const guestId = await resolveGuestId(sb, input);
  if (!guestId) {
    return { guestId: null, guestName: null, entries: [], allergies: [], diets: [], dislikes: [], unknown: true };
  }
  const [prefRes, guestRes] = await Promise.all([
    sb
      .from("guest_preferences")
      .select("id, guest_id, kind, key, value, state, confidence, severity, source, observed_count")
      .eq("guest_id", guestId),
    sb.from("guests").select("full_name").eq("id", guestId).maybeSingle(),
  ]);
  const entries = ((prefRes.data ?? []) as any[]).map(toEntry);
  return {
    guestId,
    guestName: guestRes.data?.full_name ?? null,
    entries,
    allergies: entries.filter((e) => e.kind === "allergy").map((e) => e.key),
    diets: entries.filter((e) => e.kind === "dietary_requirement").map((e) => e.key),
    dislikes: entries.filter((e) => e.kind === "preference").map((e) => e.key),
    unknown: entries.length === 0,
  };
}

export interface MenuGuestFlag {
  menuItemId: string;
  name: string;
  status: "conflict" | "verify" | "ok";
  reasons: string[];
}

/**
 * Screen the menu against a guest's known context.
 * "ok" means *no known conflict*, never "safe".
 */
export async function screenMenuForGuest(
  sb: Sb,
  userId: string,
  input: GuestContextInput,
): Promise<{ context: GuestServiceContext; flags: MenuGuestFlag[] }> {
  const context = await getGuestServiceContext(sb, userId, input);
  const [ctx, itemsRes] = await Promise.all([
    buildAllergenContext(sb, input.tenantId),
    sb
      .from("restaurant_menu_items")
      .select("id, name, description, tags, allergens, allergen_status, lifecycle_status")
      .eq("tenant_id", input.tenantId),
  ]);

  const flags: MenuGuestFlag[] = [];
  for (const item of (itemsRes.data ?? []) as any[]) {
    if (item.lifecycle_status && item.lifecycle_status !== "active") continue;
    const profile = resolveMenuItemAllergens(ctx, item);
    const reasons: string[] = [];
    let status: MenuGuestFlag["status"] = "ok";

    if (context.allergies.length > 0) {
      const check = checkAgainstGuestAllergies(profile, context.allergies);
      if (check.status === "conflict") {
        status = "conflict";
        reasons.push(check.headline);
      } else if (check.status === "verify") {
        status = "verify";
        reasons.push(check.headline);
      }
    }

    for (const diet of context.diets) {
      const hit = conflictsWithDiet(diet, {
        name: item.name,
        description: item.description,
        tags: item.tags,
      });
      if (hit) {
        if (status !== "conflict") status = "conflict";
        reasons.push(`Contains ${hit} — conflicts with ${diet}`);
      }
    }

    for (const dislike of context.dislikes) {
      const hit = `${item.name} ${item.description ?? ""}`.toLowerCase().includes(dislike.toLowerCase());
      if (hit) {
        if (status === "ok") status = "verify";
        reasons.push(`Guest previously avoided ${dislike}`);
      }
    }

    if (status !== "ok") flags.push({ menuItemId: item.id, name: item.name, status, reasons: [...new Set(reasons)] });
  }

  return { context, flags };
}

/** Explicit staff entry. Allergies always emit a high-severity canonical event. */
export async function recordGuestContext(sb: Sb, userId: string, input: RecordGuestContextInput) {
  await assertCapability(sb, userId, input.tenantId, "guest.context.manage");
  const now = new Date().toISOString();

  const { data: existing } = await sb
    .from("guest_preferences")
    .select("id, state, observed_count, evidence")
    .eq("guest_id", input.guestId)
    .eq("kind", input.kind)
    .eq("key", input.key)
    .maybeSingle();

  const observedCount = Number(existing?.observed_count ?? 0) + 1;
  const state = promoteState((existing?.state ?? "observed") as GuestContextState, observedCount, input.confirmed);
  const evidence = [
    ...((existing?.evidence ?? []) as any[]).slice(-9),
    { at: now, by: userId, source: input.source, value: input.value },
  ];
  const row = {
    guest_id: input.guestId,
    category: input.kind === "allergy" ? "dietary" : "other",
    kind: input.kind,
    key: input.key,
    value: input.value,
    state,
    severity: input.severity ?? null,
    confidence: input.confirmed ? 0.95 : Math.min(0.9, 0.4 + observedCount * 0.15),
    source: input.source,
    evidence,
    observed_count: observedCount,
    last_observed_at: now,
    updated_by: userId,
    updated_at: now,
  };

  const q = existing
    ? sb.from("guest_preferences").update(row).eq("id", existing.id)
    : sb.from("guest_preferences").insert(row);
  const { data, error } = await q.select("id").single();
  if (error) throw new Error(error.message);

  const type =
    input.kind === "allergy"
      ? "restaurant.guest.allergen.recorded"
      : input.kind === "dietary_requirement"
        ? "restaurant.guest.dietary_requirement.recorded"
        : input.confirmed
          ? "restaurant.guest.preference.confirmed"
          : "restaurant.guest.preference.observed";

  await emitRestaurantEvent(sb, userId, {
    type: type as any,
    tenantId: input.tenantId,
    entityType: "guest_preference",
    entityId: data.id,
    source: "restaurant-os",
    payload: {
      guest_id: input.guestId,
      kind: input.kind,
      key: input.key,
      state,
      severity: input.severity ?? null,
      observed_count: observedCount,
    },
  });

  return { id: data.id, state, observedCount };
}

/**
 * Capture a casual statement made during service. Parsed results are stored as
 * *observed* only; an allergy still needs staff confirmation to be trusted.
 */
export async function captureGuestStatement(sb: Sb, userId: string, input: CaptureStatementInput) {
  await assertCapability(sb, userId, input.tenantId, "guest.context.manage");
  const parsed = parseGuestStatement(input.statement);
  if (!parsed) return { captured: false, parsed: null };
  const result = await recordGuestContext(sb, userId, {
    tenantId: input.tenantId,
    guestId: input.guestId,
    kind: parsed.kind,
    key: parsed.key,
    value: parsed.value ?? input.statement.slice(0, 300),
    severity: parsed.kind === "allergy" ? "severe" : null,
    confirmed: false,
    source: "guest-statement",
  });
  return { captured: true, parsed, ...result };
}

export async function listGuestContextForTenant(sb: Sb, userId: string, tenantId: string, limit = 100) {
  await assertTenantRead(sb, userId, tenantId);
  const { data } = await sb
    .from("guest_preferences")
    .select("id, guest_id, kind, key, value, state, severity, confidence, observed_count, last_observed_at")
    .in("kind", ["allergy", "dietary_requirement"])
    .order("last_observed_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as any[];
}