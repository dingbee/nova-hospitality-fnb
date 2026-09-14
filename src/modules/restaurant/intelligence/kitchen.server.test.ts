import { describe, expect, it } from "vitest";
import { createP05FakeSupabase, OWNER, OWNER_MEMBER, TENANT_A, TENANT_B } from "./p05.test-helpers";
import { getKitchenIntelligence } from "./kitchen.server";

const DAY = 864e5;
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

function ticket(id: string, stationId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_A,
    location_id: null,
    station_id: stationId,
    status: "served",
    queued_at: iso(1),
    prep_seconds: 600,
    is_delayed: false,
    target_minutes: 10,
    ...extra,
  };
}

function station(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_A,
    property_id: null,
    location_id: null,
    name: `Station ${id}`,
    target_prep_minutes: 10,
    active: true,
    ...extra,
  };
}

describe("getKitchenIntelligence — correctness", () => {
  it("computes average prep time per station", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_kitchen_tickets: [
        ticket("t1", "s1", { prep_seconds: 600 }),
        ticket("t2", "s1", { prep_seconds: 1200 }),
      ],
      restaurant_stations: [station("s1")],
      restaurant_locations: [],
    });
    const result = await getKitchenIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 7 });
    const s1 = result.stations.find((s) => s.stationId === "s1");
    expect(s1?.averagePrepMinutes).toBe(15);
    expect(s1?.tickets).toBe(2);
  });
});

describe("getKitchenIntelligence — tenant isolation", () => {
  it("never mixes another tenant's tickets or stations into station performance", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_kitchen_tickets: [
        ticket("a-ticket", "a-station"),
        ticket("b-ticket", "b-station", { tenant_id: TENANT_B }),
      ],
      restaurant_stations: [station("a-station"), station("b-station", { tenant_id: TENANT_B })],
      restaurant_locations: [],
    });
    const result = await getKitchenIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 7 });
    expect(result.stations.map((s) => s.stationId)).not.toContain("b-station");
  });

  it("rejects a caller with no membership in the tenant", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [],
      restaurant_kitchen_tickets: [],
      restaurant_stations: [],
      restaurant_locations: [],
    });
    await expect(
      getKitchenIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 7 }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
  });
});

describe("getKitchenIntelligence — property isolation", () => {
  it("excludes another property's tickets when scoped by propertyId only (no locationId)", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER], // tenant-wide grant — legitimately sees every property
      restaurant_kitchen_tickets: [
        ticket("a-ticket", "shared-station", { location_id: "loc-a", prep_seconds: 600 }),
        ticket("b-ticket", "shared-station", { location_id: "loc-b", prep_seconds: 6000 }),
      ],
      restaurant_stations: [station("shared-station", { property_id: "prop-a" })],
      restaurant_locations: [
        { id: "loc-a", tenant_id: TENANT_A, property_id: "prop-a" },
        { id: "loc-b", tenant_id: TENANT_A, property_id: "prop-b" },
      ],
    });
    const result = await getKitchenIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
      propertyId: "prop-a",
    });
    const stationResult = result.stations.find((s) => s.stationId === "shared-station");
    expect(stationResult?.tickets).toBe(1);
    expect(stationResult?.averagePrepMinutes).toBe(10);
  });

  it("excludes another property's stations from station performance", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_kitchen_tickets: [],
      restaurant_stations: [
        station("a-station", { property_id: "prop-a" }),
        station("b-station", { property_id: "prop-b" }),
      ],
      restaurant_locations: [],
    });
    const result = await getKitchenIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
      propertyId: "prop-a",
    });
    expect(result.stations.map((s) => s.stationId)).not.toContain("b-station");
  });

  it("rejects a caller whose property grant does not cover the requested property", async () => {
    const scopedMember = {
      tenant_id: TENANT_A,
      user_id: OWNER,
      role: "owner",
      property_id: "prop-1",
    };
    const sb = createP05FakeSupabase({
      restaurant_members: [scopedMember],
      restaurant_kitchen_tickets: [],
      restaurant_stations: [],
      restaurant_locations: [],
    });
    await expect(
      getKitchenIntelligence(sb, OWNER, {
        tenantId: TENANT_A,
        windowDays: 7,
        propertyId: "prop-forged",
      }),
    ).rejects.toThrow(/do not have access to this property/);
  });
});
