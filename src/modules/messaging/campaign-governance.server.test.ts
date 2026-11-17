/* eslint-disable @typescript-eslint/no-explicit-any -- mocked Supabase builder is intentionally untyped. */
import { describe, expect, it, vi } from "vitest";
import { recordWhatsAppCampaignUsage, resolveEffectiveMetaMessageRate } from "./campaign-governance.server";

function usageDb(result: { data?: unknown; error?: { code?: string } | null }) {
  const inserted: Record<string, unknown>[] = [];
  const from = vi.fn(() => {
    const builder: any = {
      insert: (payload: Record<string, unknown>) => {
        inserted.push(payload);
        return builder;
      },
      select: () => builder,
      single: async () => result,
    };
    return builder;
  });
  return { admin: { from }, inserted };
}

describe("WCE-06 campaign usage evidence", () => {
  it("persists a reproducible cost snapshot with independent cost attribution", async () => {
    const { admin, inserted } = usageDb({
      data: { id: "usage-1", amount: 0.125, currency: "USD" },
      error: null,
    });
    const result = await recordWhatsAppCampaignUsage(admin, {
      tenantId: "tenant-1",
      propertyId: "property-1",
      usageComponent: "meta_provider",
      usageEvent: "template_message",
      marketCode: "TZ",
      templateCategory: "marketing",
      quantity: 5,
      unitPrice: 0.025,
      currency: "USD",
      idempotencyKey: "provider:msg-batch-1",
      rateId: "rate-1",
    });
    expect(result).toEqual({
      duplicate: false,
      usageId: "usage-1",
      amount: 0.125,
      currency: "USD",
    });
    expect(inserted[0]).toMatchObject({
      usage_component: "meta_provider",
      quantity: 5,
      unit_price: 0.025,
      amount: 0.125,
      rate_snapshot: { rateId: "rate-1", marketCode: "TZ", templateCategory: "marketing" },
    });
  });

  it("treats a repeated idempotency key as a no-op", async () => {
    const { admin } = usageDb({ data: null, error: { code: "23505" } });
    const result = await recordWhatsAppCampaignUsage(admin, {
      tenantId: "tenant-1",
      propertyId: "property-1",
      usageComponent: "ai",
      usageEvent: "concierge_response",
      quantity: 1,
      unitPrice: 0.01,
      currency: "USD",
      idempotencyKey: "ai:event-1",
    });
    expect(result).toEqual({ duplicate: true, amount: 0 });
  });

  it("rejects malformed cost data before writing", async () => {
    const { admin, inserted } = usageDb({ data: null, error: null });
    await expect(
      recordWhatsAppCampaignUsage(admin, {
      tenantId: "tenant-1",
      propertyId: "property-1",
      usageComponent: "lexibite_commercial",
      usageEvent: "campaign_fee",
      quantity: 0,
      unitPrice: 10,
      currency: "USD",
        idempotencyKey: "campaign:fee-1",
      }),
    ).rejects.toThrow("usage_input_invalid");
    expect(inserted).toHaveLength(0);
  });
});

describe("WCE-06 effective Meta rate resolution", () => {
  it("selects the latest effective market/category rate", async () => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      lte: () => builder,
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({
        data: {
          id: "rate-1",
          market_code: "TZ",
          category: "marketing",
          currency: "USD",
          unit_price: "0.025",
          effective_from: "2026-11-01T00:00:00.000Z",
          effective_until: null,
        },
        error: null,
      }),
    };
    const admin = { from: vi.fn(() => builder) };
    const rate = await resolveEffectiveMetaMessageRate(
      admin,
      "TZ",
      "marketing",
      new Date("2026-11-17T00:00:00.000Z"),
    );
    expect(rate).toMatchObject({
      id: "rate-1",
      marketCode: "TZ",
      category: "marketing",
      currency: "USD",
      unitPrice: 0.025,
    });
  });
});
