/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * Regression coverage for the LexiBite Branding Sprint fix: documentHeader()
 * used to resolve a document's business identity from the raw, immutable
 * restaurant_tenants.name record (and dead top-level settings.address /
 * settings.contact keys nothing ever writes) instead of the Business
 * Profile's settings.business.{tradingName,legalName,...} — the same field
 * every other branded surface (Guest Portal, POS TopBar, QR prints) already
 * reads. That is why a real Purchase Order rendered "UAT Tenant A (UAT)"
 * instead of the configured trading identity.
 */
import { describe, expect, it } from "vitest";
import { documentHeader } from "./context.server";

function fakeDb(rows: { tenant?: any; property?: any; location?: any }) {
  return {
    from(table: string) {
      const api: any = {
        select() {
          return api;
        },
        eq() {
          return api;
        },
        maybeSingle: async () => {
          if (table === "restaurant_tenants") return { data: rows.tenant ?? null };
          if (table === "restaurant_properties") return { data: rows.property ?? null };
          if (table === "restaurant_locations") return { data: rows.location ?? null };
          return { data: null };
        },
      };
      return api;
    },
  };
}

describe("documentHeader — business identity resolution", () => {
  it("prefers the configured trading name over the raw tenant record name", async () => {
    const sb = fakeDb({
      tenant: {
        name: "UAT Tenant A (UAT)",
        settings: {
          business: { tradingName: "Kilimanjaro Grill", legalName: "Kilimanjaro Grill Ltd" },
        },
      },
    });
    const header = await documentHeader(sb, "tenant-1");
    expect(header.business).toBe("Kilimanjaro Grill");
    // The legal name is shown as a secondary line only when it differs from
    // the trading name — never dropped, never duplicated.
    expect(header.legalName).toBe("Kilimanjaro Grill Ltd");
  });

  it("falls back to the legal name, never the raw tenant record, when no trading name is configured", async () => {
    const sb = fakeDb({
      tenant: { name: "tnt_8f21", settings: { business: { legalName: "Kilimanjaro Grill Ltd" } } },
    });
    const header = await documentHeader(sb, "tenant-1");
    expect(header.business).toBe("Kilimanjaro Grill Ltd");
    expect(header.legalName).toBeNull();
  });

  it("only falls back to the raw tenant record when Business Profile has genuinely nothing configured — never a hardcoded test name", async () => {
    const sb = fakeDb({ tenant: { name: "Riverbend Hospitality Group", settings: {} } });
    const header = await documentHeader(sb, "tenant-1");
    expect(header.business).toBe("Riverbend Hospitality Group");
  });

  it("resolves address and contact from the nested settings.business fields, never the dead flat settings.address/settings.contact keys", async () => {
    const sb = fakeDb({
      tenant: {
        name: "Riverbend",
        settings: {
          // Flat keys nothing in the app ever writes — must never be read.
          address: "WRONG-FLAT-ADDRESS",
          contact: "WRONG-FLAT-CONTACT",
          business: {
            tradingName: "Riverbend Lodge",
            address: "Plot 12, Arusha",
            phone: "+255700000000",
            email: "hello@riverbend.co.tz",
          },
        },
      },
    });
    const header = await documentHeader(sb, "tenant-1");
    expect(header.address).toBe("Plot 12, Arusha");
    expect(header.contact).toBe("+255700000000 · hello@riverbend.co.tz");
  });

  it("resolves website, taxId and logoUrl when configured", async () => {
    const sb = fakeDb({
      tenant: {
        name: "Riverbend",
        settings: {
          business: {
            tradingName: "Riverbend Lodge",
            website: "https://riverbend.co.tz",
            taxId: "TIN-123456789",
            logoUrl:
              "https://cdn.example-lexibite-assets.test/restaurant-tenant-logos/tenant-1/logo.jpg",
          },
        },
      },
    });
    const header = await documentHeader(sb, "tenant-1");
    expect(header.website).toBe("https://riverbend.co.tz");
    expect(header.taxId).toBe("TIN-123456789");
    expect(header.logoUrl).toContain("restaurant-tenant-logos");
  });

  it("omits optional identity fields gracefully when unconfigured, never substituting a fallback/test value", async () => {
    const sb = fakeDb({
      tenant: { name: "Riverbend", settings: { business: { tradingName: "Riverbend Lodge" } } },
    });
    const header = await documentHeader(sb, "tenant-1");
    expect(header.website).toBeNull();
    expect(header.taxId).toBeNull();
    expect(header.logoUrl).toBeNull();
    expect(header.address).toBeNull();
    expect(header.contact).toBeNull();
  });

  it("resolves property and outlet names by id, independent of the tenant business identity", async () => {
    const sb = fakeDb({
      tenant: { name: "Riverbend", settings: { business: { tradingName: "Riverbend Lodge" } } },
      property: { name: "Riverbend Lodge" },
      location: { name: "Main Bar" },
    });
    const header = await documentHeader(sb, "tenant-1", "prop-1", "loc-1");
    expect(header.property).toBe("Riverbend Lodge");
    expect(header.outlet).toBe("Main Bar");
  });
});
