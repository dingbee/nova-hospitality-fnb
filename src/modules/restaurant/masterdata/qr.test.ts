/**
 * GEP6 — qr.ts pure logic. See qr.decode.test.ts for the real
 * encode-then-decode round-trip proof (spec section 12 A-D, G-J); this
 * file covers the deterministic data-shaping the QR encoder is fed.
 */
import { describe, expect, it } from "vitest";
import {
  buildGuestOrderUrl,
  buildTableQrCard,
  buildTableQrCards,
  resolveQrRenderOptions,
  resolveTenantBranding,
  selectActiveTablesForPack,
} from "./qr";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const TABLE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TABLE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("buildGuestOrderUrl", () => {
  it("encodes exactly {origin}/order/{tableId} — the existing, unchanged guest route", () => {
    expect(buildGuestOrderUrl("https://nova-hospitality-fnb.vercel.app", TABLE_A)).toBe(
      `https://nova-hospitality-fnb.vercel.app/order/${TABLE_A}`,
    );
  });

  it("strips a trailing slash from origin rather than producing a double slash", () => {
    expect(buildGuestOrderUrl("https://example.com/", TABLE_A)).toBe(
      `https://example.com/order/${TABLE_A}`,
    );
  });

  it("A different table id produces a different URL", () => {
    const urlA = buildGuestOrderUrl("https://example.com", TABLE_A);
    const urlB = buildGuestOrderUrl("https://example.com", TABLE_B);
    expect(urlA).not.toBe(urlB);
  });

  it("works with a custom domain origin, not just the Vercel preview domain", () => {
    expect(buildGuestOrderUrl("https://order.kilimanjarogrill.co.tz", TABLE_A)).toBe(
      `https://order.kilimanjarogrill.co.tz/order/${TABLE_A}`,
    );
  });
});

describe("resolveTenantBranding", () => {
  it("prefers the configured trading name over the tenant's legal/record name", () => {
    const branding = resolveTenantBranding({
      name: "Kilimanjaro Hospitality Ltd",
      settings: { business: { tradingName: "Kilimanjaro Grill", logoUrl: "https://cdn/x.png" } },
    });
    expect(branding.businessName).toBe("Kilimanjaro Grill");
    expect(branding.businessLogoUrl).toBe("https://cdn/x.png");
  });

  it("falls back to the tenant name when no trading name is configured", () => {
    const branding = resolveTenantBranding({ name: "Kilimanjaro Hospitality Ltd", settings: null });
    expect(branding.businessName).toBe("Kilimanjaro Hospitality Ltd");
  });

  it("falls back to the tenant name when trading name is only whitespace", () => {
    const branding = resolveTenantBranding({
      name: "Kilimanjaro Hospitality Ltd",
      settings: { business: { tradingName: "   " } },
    });
    expect(branding.businessName).toBe("Kilimanjaro Hospitality Ltd");
  });

  it("gracefully returns null logo when none is configured — must never fail generation (spec section 10)", () => {
    const branding = resolveTenantBranding({ name: "X", settings: {} });
    expect(branding.businessLogoUrl).toBeNull();
  });

  it("gracefully handles a null tenant", () => {
    expect(resolveTenantBranding(null)).toEqual({ businessName: "", businessLogoUrl: null });
  });
});

describe("selectActiveTablesForPack — spec section 8/12F/12I/12J", () => {
  const tables = [
    { id: TABLE_B, code: "T02", name: "Table 02", active: true },
    { id: TABLE_A, code: "T01", name: "Table 01", active: true },
    { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", code: "T03", name: "Table 03", active: false },
  ];

  it("F: excludes inactive tables from the default pack", () => {
    const selected = selectActiveTablesForPack(tables);
    expect(selected.some((t) => t.code === "T03")).toBe(false);
  });

  it("I: includes every active table exactly once", () => {
    const selected = selectActiveTablesForPack(tables);
    expect(selected.map((t) => t.code)).toEqual(["T01", "T02"]);
  });

  it("J: de-duplicates by id even if the same table row appears twice in the input", () => {
    const duplicated = [...tables, tables[0]];
    const selected = selectActiveTablesForPack(duplicated);
    expect(selected.filter((t) => t.id === TABLE_B)).toHaveLength(1);
  });

  it("sorts numerically by code so Table 02 comes after Table 01 rather than lexical '10' < '2' surprises", () => {
    const withTen = [
      { id: "1", code: "T10", name: "Table 10", active: true },
      { id: "2", code: "T2", name: "Table 02", active: true },
    ];
    expect(selectActiveTablesForPack(withTen).map((t) => t.code)).toEqual(["T2", "T10"]);
  });
});

describe("buildTableQrCard / buildTableQrCards", () => {
  const tenant = {
    name: "Kilimanjaro Hospitality Ltd",
    settings: { business: { tradingName: "Kilimanjaro Grill", logoUrl: null } },
  };

  it("A: Table A's card encodes Table A's guest URL", () => {
    const card = buildTableQrCard(
      tenant,
      { id: TABLE_A, code: "T01", name: "Table 01" },
      "https://example.com",
    );
    expect(card.guestUrl).toBe(`https://example.com/order/${TABLE_A}`);
    expect(card.businessName).toBe("Kilimanjaro Grill");
  });

  it("B: Table B's card produces a different URL from Table A's", () => {
    const cardA = buildTableQrCard(
      tenant,
      { id: TABLE_A, code: "T01", name: "Table 01" },
      "https://example.com",
    );
    const cardB = buildTableQrCard(
      tenant,
      { id: TABLE_B, code: "T02", name: "Table 02" },
      "https://example.com",
    );
    expect(cardA.guestUrl).not.toBe(cardB.guestUrl);
  });

  it("C: renaming a table (name/code change only, same id) never changes the encoded URL", () => {
    const before = buildTableQrCard(
      tenant,
      { id: TABLE_A, code: "T01", name: "Table 01" },
      "https://example.com",
    );
    const after = buildTableQrCard(
      tenant,
      { id: TABLE_A, code: "PATIO-1", name: "Patio Table 1" },
      "https://example.com",
    );
    expect(after.guestUrl).toBe(before.guestUrl);
  });

  it("D: regenerating a card for the same table is deterministic — same destination every time", () => {
    const first = buildTableQrCard(
      tenant,
      { id: TABLE_A, code: "T01", name: "Table 01" },
      "https://example.com",
    );
    const second = buildTableQrCard(
      tenant,
      { id: TABLE_A, code: "T01", name: "Table 01" },
      "https://example.com",
    );
    expect(second.guestUrl).toBe(first.guestUrl);
  });

  it("G: missing logo never breaks card generation", () => {
    const card = buildTableQrCard(
      { name: "X", settings: null },
      { id: TABLE_A, code: "T01", name: "Table 01" },
      "https://example.com",
    );
    expect(card.businessLogoUrl).toBeNull();
    expect(card.guestUrl).toContain(TABLE_A);
  });

  it("H: the resolved brand name is reflected on the card", () => {
    const card = buildTableQrCard(
      tenant,
      { id: TABLE_A, code: "T01", name: "Table 01" },
      "https://example.com",
    );
    expect(card.businessName).toBe("Kilimanjaro Grill");
  });

  it("E: cards are built only from the tables array passed in — a second tenant's tables never appear unless explicitly included", () => {
    const tenantATables = [{ id: TABLE_A, code: "T01", name: "Table 01", active: true }];
    const tenantBTables = [{ id: TABLE_B, code: "T01", name: "Table 01", active: true }];
    const cardsA = buildTableQrCards(tenant, tenantATables, "https://example.com");
    const cardsB = buildTableQrCards(tenant, tenantBTables, "https://example.com");
    expect(cardsA.map((c) => c.tableId)).not.toContain(TABLE_B);
    expect(cardsB.map((c) => c.tableId)).not.toContain(TABLE_A);
  });

  it("bulk pack excludes an inactive table by default", () => {
    const tables = [
      { id: TABLE_A, code: "T01", name: "Table 01", active: true },
      { id: TABLE_B, code: "T02", name: "Table 02", active: false },
    ];
    const cards = buildTableQrCards(tenant, tables, "https://example.com");
    expect(cards.map((c) => c.tableId)).toEqual([TABLE_A]);
  });
});

describe("resolveQrRenderOptions", () => {
  it("uses the highest error-correction level when a logo will be composited — scan reliability over decoration", () => {
    expect(resolveQrRenderOptions(true).errorCorrectionLevel).toBe("H");
  });

  it("uses a comfortable level with no logo present", () => {
    expect(resolveQrRenderOptions(false).errorCorrectionLevel).toBe("M");
  });

  it("always generates at a real print-quality native width, never a tiny size meant to be upscaled", () => {
    expect(resolveQrRenderOptions(false).width).toBeGreaterThanOrEqual(600);
    expect(resolveQrRenderOptions(true).width).toBeGreaterThanOrEqual(600);
  });

  it("keeps a non-zero quiet zone so the code stays scannable printed edge-to-edge on a card", () => {
    expect(resolveQrRenderOptions(false).margin).toBeGreaterThan(0);
  });
});
