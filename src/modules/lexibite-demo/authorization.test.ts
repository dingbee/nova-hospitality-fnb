/**
 * P02.4 — proves the demo role ('viewer') is genuinely least-privilege
 * using the EXISTING, already-enforced capability map
 * (src/modules/restaurant/core/permissions.ts) — no new authorization
 * system is introduced for the demo, so this test exercises the real one.
 */
import { describe, expect, it } from "vitest";
import {
  hasRestaurantCapability,
  RESTAURANT_CAPABILITIES,
  type RestaurantCapability,
} from "@/modules/restaurant/core/permissions";
import { DEMO_ROLE } from "./constants";

const PROHIBITED_FOR_DEMO: RestaurantCapability[] = [
  "tenant.manage",
  "sales.void",
  "sales.discount",
  "sales.room_charge",
  "pricing.approve",
  "pricing.manage",
  "fiscal.manage",
  "mobile_money.manage",
  "adjustment.manage",
  "purchasing.approve",
  "import.manage",
  "menu.delete",
];

describe("demo role ('viewer') least privilege", () => {
  it("holds none of the sensitive/write capabilities a demo visitor must never reach", () => {
    for (const capability of PROHIBITED_FOR_DEMO) {
      expect(hasRestaurantCapability([DEMO_ROLE], capability, false)).toBe(false);
    }
  });

  it("holds NO capability at all — every single capability in the map excludes 'viewer'", () => {
    for (const capability of RESTAURANT_CAPABILITIES) {
      expect(hasRestaurantCapability([DEMO_ROLE], capability, false)).toBe(false);
    }
  });

  it("platformAdmin=true would still bypass this — confirming the demo grant must never set it (it never does; see migration 0082, which never touches restaurant_is_platform_admin)", () => {
    expect(hasRestaurantCapability([DEMO_ROLE], "tenant.manage", true)).toBe(true);
  });
});
