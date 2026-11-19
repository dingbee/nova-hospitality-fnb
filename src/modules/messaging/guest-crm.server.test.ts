/* eslint-disable @typescript-eslint/no-explicit-any -- mocked Supabase rows are intentionally untyped in service-boundary tests. */
import { describe, expect, it, vi } from "vitest";
import {
  detectGuestLanguage,
  normalizeWhatsAppPhone,
  parseWhatsAppConsentCommand,
  hasWhatsAppGuestMarketingConsent,
  awardGuestLoyaltyForCompletedOrder,
} from "./guest-crm.server";

describe("WhatsApp guest CRM identity and consent language", () => {
  it("normalizes a provider sender ID to E.164 without trusting formatted input", () => {
    expect(normalizeWhatsAppPhone("255 712-345-678")).toEqual({
      phoneE164: "+255712345678",
      whatsappUserId: "255712345678",
    });
    expect(() => normalizeWhatsAppPhone("abc")).toThrow();
  });

  it("detects Swahili and defaults safely to English", () => {
    expect(detectGuestLanguage("Habari, naomba menu tafadhali")).toBe("sw");
    expect(detectGuestLanguage("Please show me the menu")).toBe("en");
  });

  it("requires an explicit consent keyword and distinguishes opt-in from opt-out", () => {
    expect(parseWhatsAppConsentCommand("JOIN")).toBe("subscribe");
    expect(parseWhatsAppConsentCommand("START")).toBe("subscribe");
    expect(parseWhatsAppConsentCommand("STOP")).toBe("unsubscribe");
    expect(parseWhatsAppConsentCommand("I like your food")).toBeNull();
  });
});

function loyaltyDb(program: Record<string, unknown>, ledgerError: { code?: string } | null = null) {
  const inserts: Array<Record<string, unknown>> = [];
  const from = vi.fn((table: string) => {
    let inserted = false;
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () =>
        table === "restaurant_orders"
          ? {
              data: {
                id: "order-1",
                tenant_id: "tenant-1",
                property_id: "property-1",
                guest_customer_id: "guest-1",
                status: "closed",
                total: 5000,
                currency: "TZS",
              },
              error: null,
            }
          : { data: program, error: null },
      insert: (payload: Record<string, unknown>) => {
        inserted = true;
        inserts.push(payload);
        return builder;
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: inserted && !ledgerError ? [{ id: "ledger-1" }] : null,
          error: inserted ? ledgerError : null,
        }).then(resolve),
    };
    return builder;
  });
  return { admin: { from }, inserts };
}

describe("Guest loyalty accrual", () => {
  it("awards points from a completed guest order using the configured property/currency rate", async () => {
    const { admin, inserts } = loyaltyDb({
      enabled: true,
      points_per_1000_units: 2,
      minimum_order_total: 1000,
    });
    const result = await awardGuestLoyaltyForCompletedOrder(admin, "tenant-1", "order-1");
    expect(result).toEqual({ awarded: 10, reason: "awarded" });
    expect(inserts[0]).toMatchObject({
      tenant_id: "tenant-1",
      guest_customer_id: "guest-1",
      entry_type: "earn",
      points_delta: 10,
      idempotency_key: "order:order-1:earn",
    });
  });

  it("does not award points when the property programme is disabled", async () => {
    const { admin, inserts } = loyaltyDb({
      enabled: false,
      points_per_1000_units: 2,
      minimum_order_total: 0,
    });
    const result = await awardGuestLoyaltyForCompletedOrder(admin, "tenant-1", "order-1");
    expect(result.awarded).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("treats a repeated completion event as an idempotent no-op", async () => {
    const { admin } = loyaltyDb(
      { enabled: true, points_per_1000_units: 2, minimum_order_total: 0 },
      { code: "23505" },
    );
    const result = await awardGuestLoyaltyForCompletedOrder(admin, "tenant-1", "order-1");
    expect(result).toEqual({ awarded: 0, reason: "already_awarded" });
  });
});


describe("WhatsApp marketing consent verification", () => {
  it.each(["granted", "revoked", null])("uses the latest WhatsApp marketing consent state: %s", async (state) => {
    const calls: Array<[string, unknown]> = [];
    const builder: any = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        calls.push([column, value]);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({
        data: state ? { state } : null,
        error: null,
      }),
    };
    const admin = { from: vi.fn(() => builder) };
    const result = await hasWhatsAppGuestMarketingConsent(admin, "tenant-1", "guest-1");
    expect(result).toBe(state === "granted");
    expect(calls).toContainEqual(["tenant_id", "tenant-1"]);
    expect(calls).toContainEqual(["guest_customer_id", "guest-1"]);
    expect(calls).toContainEqual(["channel", "whatsapp"]);
    expect(calls).toContainEqual(["purpose", "marketing"]);
  });
});
