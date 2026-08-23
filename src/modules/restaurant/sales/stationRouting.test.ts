import { describe, expect, it } from "vitest";
import {
  resolveCataloguedLineStation,
  resolveOpenItemStation,
  sendToStationLabel,
  type StationRow,
} from "./stationRouting";

const BAR_STATION_TYPES = ["bar", "cocktail", "coffee", "service_bar", "beverage"] as const;

const kitchenStation: StationRow = { id: "kitchen-1", stationType: "kitchen" };
const barStation: StationRow = { id: "bar-1", stationType: "bar" };
const foreignTenantStation: StationRow = { id: "foreign-station", stationType: "bar" };

const tenantStations: StationRow[] = [kitchenStation, barStation];

describe("resolveCataloguedLineStation — server authority over the product's own configuration", () => {
  it("routes a beverage product configured with a bar station to BAR — reproduces the screenshot failure", () => {
    // "UAT bar POS drink": a beverage product whose catalogue configuration points at the bar station.
    const product = { stationId: barStation.id, isBeverage: true };
    const result = resolveCataloguedLineStation(product, tenantStations, BAR_STATION_TYPES);
    expect(result).toBe(barStation.id);
    expect(tenantStations.find((s) => s.id === result)?.stationType).toBe("bar");
  });

  it("routes a food product to KITCHEN", () => {
    const product = { stationId: kitchenStation.id, isBeverage: false };
    const result = resolveCataloguedLineStation(product, tenantStations, BAR_STATION_TYPES);
    expect(result).toBe(kitchenStation.id);
  });

  it("mixed order: a beverage line and a food line resolve to different stations independently", () => {
    const beverage = resolveCataloguedLineStation({ stationId: barStation.id, isBeverage: true }, tenantStations, BAR_STATION_TYPES);
    const food = resolveCataloguedLineStation({ stationId: kitchenStation.id, isBeverage: false }, tenantStations, BAR_STATION_TYPES);
    expect(beverage).toBe(barStation.id);
    expect(food).toBe(kitchenStation.id);
    expect(beverage).not.toBe(food);
  });

  it("a beverage product with no configured station falls back to the tenant's bar lane default, not kitchen", () => {
    const product = { stationId: null, isBeverage: true };
    const result = resolveCataloguedLineStation(product, tenantStations, BAR_STATION_TYPES);
    expect(result).toBe(barStation.id);
  });

  it("a food product with no configured station falls back to the tenant's kitchen lane default", () => {
    const product = { stationId: null, isBeverage: false };
    const result = resolveCataloguedLineStation(product, tenantStations, BAR_STATION_TYPES);
    expect(result).toBe(kitchenStation.id);
  });

  it("MALICIOUS: the product's own configuration wins even if a client tried to force a different lane — the caller never gets to pass a client stationId in at all for catalogued lines", () => {
    // resolveCataloguedLineStation's signature has no client-proposed-station
    // parameter for a catalogued line, by construction: there is nothing for
    // a compromised client to override. A beverage always resolves through
    // its own product configuration/classification, never through client input.
    const product = { stationId: barStation.id, isBeverage: true };
    const result = resolveCataloguedLineStation(product, tenantStations, BAR_STATION_TYPES);
    expect(result).not.toBe(kitchenStation.id);
    expect(result).toBe(barStation.id);
  });

  it("a product's configured station that no longer belongs to this tenant's station list is ignored, not trusted", () => {
    const product = { stationId: foreignTenantStation.id, isBeverage: true };
    // tenantStations does not include foreignTenantStation, simulating a
    // stale/foreign reference — must fall back to the lane default instead.
    const result = resolveCataloguedLineStation(product, tenantStations, BAR_STATION_TYPES);
    expect(result).toBe(barStation.id);
    expect(result).not.toBe(foreignTenantStation.id);
  });

  it("no product info at all and no kitchen-type station configured resolves to null, never a wrong station", () => {
    const result = resolveCataloguedLineStation(null, [barStation], BAR_STATION_TYPES);
    expect(result).toBeNull();
  });
});

describe("resolveOpenItemStation — a client proposal is honoured only for non-catalogued items, and only within this tenant", () => {
  it("accepts a proposed station that genuinely belongs to this tenant", () => {
    expect(resolveOpenItemStation(kitchenStation.id, tenantStations)).toBe(kitchenStation.id);
  });

  it("MALICIOUS: rejects a proposed station belonging to a foreign tenant", () => {
    expect(resolveOpenItemStation(foreignTenantStation.id, tenantStations)).toBeNull();
  });

  it("rejects a fabricated station id that matches nothing", () => {
    expect(resolveOpenItemStation("not-a-real-station", tenantStations)).toBeNull();
  });

  it("no proposal resolves to unassigned (null), not a default station", () => {
    expect(resolveOpenItemStation(undefined, tenantStations)).toBeNull();
    expect(resolveOpenItemStation(null, tenantStations)).toBeNull();
  });
});

describe("sendToStationLabel — the till label can never claim a drink is headed to the kitchen", () => {
  it("an all-bar pending set says 'Send to bar'", () => {
    expect(sendToStationLabel(["bar", "cocktail"], BAR_STATION_TYPES)).toBe("Send to bar");
  });

  it("an all-kitchen pending set says 'Send to kitchen'", () => {
    expect(sendToStationLabel(["kitchen", "kitchen"], BAR_STATION_TYPES)).toBe("Send to kitchen");
  });

  it("a mixed pending set names both", () => {
    expect(sendToStationLabel(["kitchen", "bar"], BAR_STATION_TYPES)).toBe("Send to kitchen & bar");
  });

  it("an unassigned (null) station type in an otherwise-bar set is treated as non-bar, keeping the label a mix rather than a bare 'Send to bar'", () => {
    expect(sendToStationLabel(["bar", null], BAR_STATION_TYPES)).toBe("Send to kitchen & bar");
  });

  it("empty pending set defaults to 'Send to kitchen' (existing kitchen-only behaviour is unchanged)", () => {
    expect(sendToStationLabel([], BAR_STATION_TYPES)).toBe("Send to kitchen");
  });
});
