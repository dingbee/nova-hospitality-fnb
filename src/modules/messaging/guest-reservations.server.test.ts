import { describe, expect, it, vi } from "vitest";
import {
  checkGuestReservationAvailability,
  createGuestTableReservation,
  cancelGuestTableReservation,
  localDateTimeToUtc,
} from "./guest-reservations.server";

const tenantId = "tenant-1";
const propertyId = "property-1";
const locationId = "location-1";
const guestCustomerId = "guest-1";
const token = "A".repeat(43);

function futureLocalDateTime() {
  const instant = new Date(Date.now() + 48 * 60 * 60_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Dar_es_Salaam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

function reservationDb(rows: Record<string, any[]>, rpcResult: unknown = null) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "wa_resolve_guest_portal_session") {
      return {
        data: {
          session_id: "session-1",
          tenant_id: tenantId,
          property_id: propertyId,
          location_id: locationId,
          binding_id: "binding-1",
          conversation_id: "conversation-1",
          currency: "TZS",
          scope: "guest_commerce",
        },
        error: null,
      };
    }
    if (name === "restaurant_create_guest_table_reservation") {
      return { data: rpcResult, error: null };
    }
    throw new Error("Unexpected RPC " + name);
  });
  return {
    rpc,
    from(table: string) {
      let filtered = rows[table] ?? [];
      let patch: Record<string, unknown> | null = null;
      const builder: any = {
        select: () => builder,
        update: (value: Record<string, unknown>) => {
          patch = value;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filtered = filtered.filter((row) => row[column] === value);
          return builder;
        },
        neq: (column: string, value: unknown) => {
          filtered = filtered.filter((row) => row[column] !== value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          const set = new Set(values);
          filtered = filtered.filter((row) => set.has(row[column]));
          return builder;
        },
        lt: (column: string, value: string) => {
          filtered = filtered.filter((row) => String(row[column]) < value);
          return builder;
        },
        gt: (column: string, value: string) => {
          filtered = filtered.filter((row) => String(row[column]) > value);
          return builder;
        },
        maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => {
          if (patch) for (const row of filtered) Object.assign(row, patch);
          return Promise.resolve({ data: filtered, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

function baseRows() {
  return {
    wa_conversations: [
      {
        id: "conversation-1",
        tenant_id: tenantId,
        property_id: propertyId,
        location_id: locationId,
        guest_customer_id: guestCustomerId,
      },
    ],
    restaurant_properties: [
      {
        id: propertyId,
        tenant_id: tenantId,
        timezone: "Africa/Dar_es_Salaam",
        settings: { reservations: { durationMinutes: 90 } },
        status: "active",
      },
    ],
    restaurant_locations: [
      {
        id: locationId,
        tenant_id: tenantId,
        property_id: propertyId,
        settings: {},
        status: "active",
        location_type: "restaurant",
        is_storage: false,
      },
    ],
    restaurant_guest_customers: [
      {
        id: guestCustomerId,
        tenant_id: tenantId,
        display_name: "Amina",
        phone_e164: "+255712345678",
        status: "active",
      },
    ],
    restaurant_tables: [
      {
        id: "table-1",
        tenant_id: tenantId,
        property_id: propertyId,
        location_id: locationId,
        seats: 2,
        status: "available",
        active: true,
      },
      {
        id: "table-2",
        tenant_id: tenantId,
        property_id: propertyId,
        location_id: locationId,
        seats: 4,
        status: "available",
        active: true,
      },
    ],
    restaurant_table_reservations: [],
  };
}

describe("property-timezone reservation handling", () => {
  it("converts the property's local time to UTC, independent of the guest device timezone", () => {
    expect(localDateTimeToUtc("2026-11-18T19:00", "Africa/Dar_es_Salaam")).toBe(
      "2026-11-18T16:00:00.000Z",
    );
  });

  it("rejects a local time that does not exist during a daylight-saving transition", () => {
    expect(() => localDateTimeToUtc("2026-03-08T02:30", "America/New_York")).toThrow(
      "does not exist",
    );
  });

  it("returns outlet-scoped table availability and subtracts overlapping reservations", async () => {
    const localStart = futureLocalDateTime();
    const start = new Date(localDateTimeToUtc(localStart, "Africa/Dar_es_Salaam"));
    const endsAt = new Date(start.getTime() + 90 * 60_000).toISOString();
    const db = reservationDb({
      ...baseRows(),
      restaurant_table_reservations: [
        {
          table_id: "table-2",
          starts_at: new Date(start.getTime() - 30 * 60_000).toISOString(),
          ends_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
          status: "confirmed",
          tenant_id: tenantId,
          property_id: propertyId,
          location_id: locationId,
        },
      ],
    });
    const result = await checkGuestReservationAvailability(db as any, {
      token,
      localStart,
      partySize: 3,
    });
    expect(result).toMatchObject({
      available: false,
      availableTableCount: 0,
      partySize: 3,
      timezone: "Africa/Dar_es_Salaam",
      durationMinutes: 90,
      startsAt: start.toISOString(),
      endsAt,
    });
  });

  it("allows a smaller party when the best-fit table is free", async () => {
    const result = await checkGuestReservationAvailability(reservationDb(baseRows()) as any, {
      token,
      localStart: futureLocalDateTime(),
      partySize: 2,
    });
    expect(result.available).toBe(true);
    expect(result.availableTableCount).toBe(2);
  });

  it("fails closed for a blocked guest", async () => {
    const rows = baseRows();
    rows.restaurant_guest_customers[0].status = "blocked";
    await expect(
      checkGuestReservationAvailability(reservationDb(rows) as any, {
        token,
        localStart: futureLocalDateTime(),
        partySize: 2,
      }),
    ).rejects.toThrow("verified guest contact");
  });

  it("creates an idempotent reservation through the service-only atomic RPC", async () => {
    const rows = baseRows();
    const rpcResult = [
      {
        reservation_id: "reservation-1",
        booking_reference: "R-AB12CD34",
        table_id: "table-1",
        starts_at: "2026-11-18T16:00:00.000Z",
        ends_at: "2026-11-18T17:30:00.000Z",
        reservation_status: "confirmed",
      },
    ];
    const db = reservationDb(rows, rpcResult);
    const result = await createGuestTableReservation(db as any, {
      token,
      localStart: futureLocalDateTime(),
      partySize: 2,
      clientRequestId: "request-12345678",
    });
    expect(result.bookingReference).toBe("R-AB12CD34");
    expect(result.status).toBe("confirmed");
    expect(db.rpc).toHaveBeenCalledWith(
      "restaurant_create_guest_table_reservation",
      expect.objectContaining({
        _tenant_id: tenantId,
        _property_id: propertyId,
        _location_id: locationId,
        _guest_customer_id: guestCustomerId,
        _guest_phone_e164: "+255712345678",
        _party_size: 2,
        _duration_minutes: 90,
        _client_request_id: "wa-guest-reservation:session-1:request-12345678",
      }),
    );
  });
});


describe("guest reservation cancellation", () => {
  it("cancels only the same guest's future confirmed reservation", async () => {
    const startsAt = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
    const rows = {
      ...baseRows(),
      restaurant_table_reservations: [
        {
          id: "reservation-1",
          tenant_id: tenantId,
          property_id: propertyId,
          location_id: locationId,
          guest_customer_id: guestCustomerId,
          status: "confirmed",
          starts_at: startsAt,
        },
      ],
    };
    const db = reservationDb(rows);
    const result = await cancelGuestTableReservation(db as any, {
      token,
      reservationId: "reservation-1",
    });
    expect(result.cancelled).toBe(true);
    expect(rows.restaurant_table_reservations[0].status).toBe("cancelled");
  });
});
