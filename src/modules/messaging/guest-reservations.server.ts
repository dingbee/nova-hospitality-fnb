/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are validated and projected at this server boundary. */
import { resolveWhatsAppGuestPortalSession } from "./guest-portal-sessions.server";

type Db = any;
type GuestReservationSession = {
  sessionId: string;
  tenantId: string;
  propertyId: string;
  locationId: string;
  conversationId: string;
  scope: string;
};

type ReservationContext = {
  session: GuestReservationSession;
  guestCustomerId: string;
  guestName: string;
  guestPhoneE164: string;
  timezone: string;
  durationMinutes: number;
};

function getLocalParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function timezoneOffsetAt(instant: Date, timeZone: string): number {
  const parts = getLocalParts(instant, timeZone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    instant.getTime()
  );
}

/** Convert a browser datetime-local value using the property's IANA timezone, never the guest device timezone. */
export function localDateTimeToUtc(localDateTime: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localDateTime);
  if (!match) throw new Error("Choose a valid reservation date and time.");
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const target = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: 0,
  };
  const localAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  let instant = new Date(localAsUtc - timezoneOffsetAt(new Date(localAsUtc), timeZone));
  instant = new Date(localAsUtc - timezoneOffsetAt(instant, timeZone));
  const roundTrip = getLocalParts(instant, timeZone);
  if (
    roundTrip.year !== target.year ||
    roundTrip.month !== target.month ||
    roundTrip.day !== target.day ||
    roundTrip.hour !== target.hour ||
    roundTrip.minute !== target.minute
  ) {
    throw new Error("That local time does not exist in the restaurant's timezone. Choose another time.");
  }
  return instant.toISOString();
}

function configuredDuration(locationSettings: any, propertySettings: any): number {
  const configured =
    locationSettings?.reservations?.durationMinutes ??
    propertySettings?.reservations?.durationMinutes;
  const value = Number(configured ?? 90);
  return Number.isInteger(value) && value >= 30 && value <= 240 ? value : 90;
}

async function resolveReservationContext(admin: Db, token: string): Promise<ReservationContext> {
  const session = await resolveWhatsAppGuestPortalSession(admin, token);
  if (!session || session.scope !== "guest_commerce") {
    throw new Error("This Guest Portal session has expired. Return to WhatsApp and request a fresh link.");
  }

  const [
    { data: conversation, error: conversationError },
    { data: property, error: propertyError },
    { data: location, error: locationError },
  ] = await Promise.all([
    admin
      .from("wa_conversations")
      .select("guest_customer_id")
      .eq("id", session.conversationId)
      .eq("tenant_id", session.tenantId)
      .eq("property_id", session.propertyId)
      .eq("location_id", session.locationId)
      .maybeSingle(),
    admin
      .from("restaurant_properties")
      .select("timezone, settings, status")
      .eq("id", session.propertyId)
      .eq("tenant_id", session.tenantId)
      .maybeSingle(),
    admin
      .from("restaurant_locations")
      .select("settings, status, location_type, is_storage")
      .eq("id", session.locationId)
      .eq("tenant_id", session.tenantId)
      .eq("property_id", session.propertyId)
      .maybeSingle(),
  ]);
  if (
    conversationError ||
    !conversation?.guest_customer_id ||
    propertyError ||
    !property ||
    property.status !== "active" ||
    locationError ||
    !location ||
    location.status !== "active" ||
    location.is_storage ||
    !["outlet", "restaurant", "bar"].includes(location.location_type)
  ) {
    throw new Error("Reservation context is unavailable for this outlet.");
  }

  const { data: guest, error: guestError } = await admin
    .from("restaurant_guest_customers")
    .select("id, display_name, phone_e164, status")
    .eq("id", conversation.guest_customer_id)
    .eq("tenant_id", session.tenantId)
    .maybeSingle();
  if (guestError || !guest || guest.status === "blocked" || !guest.phone_e164) {
    throw new Error("A verified guest contact is required to make a reservation.");
  }

  return {
    session,
    guestCustomerId: guest.id,
    guestName: guest.display_name ?? "",
    guestPhoneE164: guest.phone_e164,
    timezone: property.timezone || "Africa/Dar_es_Salaam",
    durationMinutes: configuredDuration(location.settings, property.settings),
  };
}

function reservationWindow(localStart: string, context: ReservationContext) {
  const startsAt = localDateTimeToUtc(localStart, context.timezone);
  const start = new Date(startsAt);
  if (start.getTime() < Date.now() + 15 * 60_000 || start.getTime() > Date.now() + 90 * 24 * 60 * 60_000) {
    throw new Error("Reservations must be at least 15 minutes ahead and within the next 90 days.");
  }
  return {
    startsAt,
    endsAt: new Date(start.getTime() + context.durationMinutes * 60_000).toISOString(),
  };
}

export async function checkGuestReservationAvailability(
  admin: Db,
  input: { token: string; localStart: string; partySize: number },
) {
  if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 30) {
    throw new Error("Choose a party size between 1 and 30.");
  }
  const context = await resolveReservationContext(admin, input.token);
  const window = reservationWindow(input.localStart, context);
  const { session } = context;
  const [{ data: tables, error: tableError }, { data: reservations, error: reservationError }] =
    await Promise.all([
      admin
        .from("restaurant_tables")
        .select("id, seats, status")
        .eq("tenant_id", session.tenantId)
        .eq("property_id", session.propertyId)
        .eq("location_id", session.locationId)
        .eq("active", true)
        .neq("status", "out_of_service"),
      admin
        .from("restaurant_table_reservations")
        .select("table_id, starts_at, ends_at, status")
        .eq("tenant_id", session.tenantId)
        .eq("property_id", session.propertyId)
        .eq("location_id", session.locationId)
        .in("status", ["requested", "confirmed", "seated"])
        .lt("starts_at", window.endsAt)
        .gt("ends_at", window.startsAt),
    ]);
  if (tableError || reservationError) {
    throw new Error("Reservation availability could not be checked.");
  }

  const occupied = new Set((reservations ?? []).map((reservation: any) => reservation.table_id));
  const availableTables = (tables ?? []).filter(
    (table: any) => Number(table.seats) >= input.partySize && !occupied.has(table.id),
  );
  return {
    available: availableTables.length > 0,
    availableTableCount: availableTables.length,
    partySize: input.partySize,
    timezone: context.timezone,
    durationMinutes: context.durationMinutes,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
  };
}

export async function createGuestTableReservation(
  admin: Db,
  input: {
    token: string;
    localStart: string;
    partySize: number;
    guestName?: string;
    clientRequestId: string;
  },
) {
  if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 30) {
    throw new Error("Choose a party size between 1 and 30.");
  }
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.clientRequestId)) {
    throw new Error("The reservation request could not be verified. Please retry.");
  }
  const context = await resolveReservationContext(admin, input.token);
  const window = reservationWindow(input.localStart, context);
  const guestName = input.guestName?.trim() || context.guestName;
  if (!guestName || guestName.length > 160) {
    throw new Error("Enter the name for this reservation.");
  }

  const { data, error } = await admin.rpc("restaurant_create_guest_table_reservation", {
    _tenant_id: context.session.tenantId,
    _property_id: context.session.propertyId,
    _location_id: context.session.locationId,
    _guest_customer_id: context.guestCustomerId,
    _guest_name: guestName,
    _guest_phone_e164: context.guestPhoneE164,
    _guest_email: null,
    _party_size: input.partySize,
    _starts_at: window.startsAt,
    _duration_minutes: context.durationMinutes,
    _client_request_id: "wa-guest-reservation:" + context.session.sessionId + ":" + input.clientRequestId,
  });
  if (error) {
    if (String(error.message ?? "").includes("NO_TABLE_AVAILABLE")) {
      throw new Error("That time has just become unavailable. Choose another time.");
    }
    throw new Error("The reservation could not be confirmed. Please retry.");
  }
  const reservation = Array.isArray(data) ? data[0] : data;
  if (!reservation?.reservation_id || !reservation.booking_reference) {
    throw new Error("The reservation confirmation could not be verified.");
  }
  return {
    reservationId: reservation.reservation_id,
    bookingReference: reservation.booking_reference,
    startsAt: reservation.starts_at,
    endsAt: reservation.ends_at,
    status: reservation.reservation_status,
    timezone: context.timezone,
  };
}


export async function cancelGuestTableReservation(
  admin: Db,
  input: { token: string; reservationId: string },
) {
  const context = await resolveReservationContext(admin, input.token);
  const { data: reservation, error } = await admin
    .from("restaurant_table_reservations")
    .select("id, status, starts_at")
    .eq("id", input.reservationId)
    .eq("tenant_id", context.session.tenantId)
    .eq("property_id", context.session.propertyId)
    .eq("location_id", context.session.locationId)
    .eq("guest_customer_id", context.guestCustomerId)
    .maybeSingle();
  if (error || !reservation) throw new Error("This reservation could not be found.");
  if (!["requested", "confirmed"].includes(reservation.status)) {
    throw new Error("This reservation can no longer be cancelled online.");
  }
  if (new Date(reservation.starts_at).getTime() <= Date.now()) {
    throw new Error("Reservations that have already started must be changed by the restaurant.");
  }
  const { data: linkedOrders, error: linkedOrderError } = await admin
    .from("restaurant_orders")
    .select("id")
    .eq("tenant_id", context.session.tenantId)
    .eq("guest_reservation_id", input.reservationId)
    .in("status", ["open", "sent", "served"])
    .limit(1);
  if (linkedOrderError) throw new Error("The reservation's order status could not be verified.");
  if (linkedOrders?.length) {
    throw new Error("An order is already linked to this reservation. Contact the outlet to change it.");
  }
  const { error: updateError } = await admin
    .from("restaurant_table_reservations")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", input.reservationId)
    .eq("tenant_id", context.session.tenantId)
    .eq("property_id", context.session.propertyId)
    .eq("location_id", context.session.locationId)
    .eq("guest_customer_id", context.guestCustomerId)
    .in("status", ["requested", "confirmed"]);
  if (updateError) throw new Error("The reservation could not be cancelled. Please contact the outlet.");
  return { cancelled: true as const, reservationId: input.reservationId };
}
