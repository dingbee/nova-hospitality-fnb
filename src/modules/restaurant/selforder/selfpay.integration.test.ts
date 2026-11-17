import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "@/modules/api-platform/crypto.server";
import { getConfiguredProvider } from "./selfpay.server";

const TENANT = "tenant-a";
const PROPERTY = "property-a";

function integrationRow(overrides: Record<string, unknown> = {}) {
  const encrypted = encryptSecret(
    JSON.stringify({ consumerKey: "property-key", consumerSecret: "property-secret" }),
  );
  return {
    id: "integration-a",
    tenant_id: TENANT,
    property_id: PROPERTY,
    provider: "pesapal",
    integration_type: "payment",
    status: "active",
    config: { environment: "sandbox" },
    secret_ciphertext: encrypted.ciphertext,
    secret_iv: encrypted.iv,
    secret_tag: encrypted.tag,
    ...overrides,
  };
}

function integrationDb(row: Record<string, any> | null) {
  return {
    from(table: string) {
      let filtered = table === "api_integrations" && row ? [row] : [];
      let patch: Record<string, unknown> | null = null;
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filtered = filtered.filter((item) => item[column] === value);
          return builder;
        },
        maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
        update: (value: Record<string, unknown>) => {
          patch = value;
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (patch) for (const item of filtered) Object.assign(item, patch);
          return Promise.resolve({ data: filtered, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

describe("getConfiguredProvider — tenant/property integration resolution", () => {
  const originalKey = process.env.NOVA_API_PLATFORM_ENCRYPTION_KEY;
  const originalBase = process.env.APP_BASE_URL;

  beforeEach(() => {
    process.env.NOVA_API_PLATFORM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.APP_BASE_URL = "https://lexibite.example";
    delete process.env.PESAPAL_CONSUMER_KEY;
    delete process.env.PESAPAL_CONSUMER_SECRET;
    delete process.env.PESAPAL_ENV;
    delete process.env.PESAPAL_IPN_ID;
    delete process.env.PESAPAL_IPN_URL;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOVA_API_PLATFORM_ENCRYPTION_KEY;
    else process.env.NOVA_API_PLATFORM_ENCRYPTION_KEY = originalKey;
    if (originalBase === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = originalBase;
    vi.restoreAllMocks();
  });

  it("resolves only the active Pesapal payment integration for the exact property", async () => {
    const db = integrationDb(integrationRow());
    const provider = await getConfiguredProvider(db as any, TENANT, PROPERTY);
    expect(provider?.name).toBe("pesapal");
    await expect(getConfiguredProvider(db as any, TENANT, "another-property")).resolves.toBeNull();
    await expect(getConfiguredProvider(db as any, "another-tenant", PROPERTY)).resolves.toBeNull();
    await expect(getConfiguredProvider(db as any, TENANT, null)).resolves.toBeNull();
  });

  it("does not fall back to process-wide Pesapal credentials when no property integration exists", async () => {
    process.env.PESAPAL_CONSUMER_KEY = "global-key";
    process.env.PESAPAL_CONSUMER_SECRET = "global-secret";
    await expect(getConfiguredProvider(integrationDb(null) as any, TENANT, PROPERTY)).resolves.toBeNull();
  });

  it("persists a newly registered Pesapal IPN id into the same property integration", async () => {
    const row = integrationRow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/Auth/RequestToken")) return { ok: true, status: 200, json: async () => ({ token: "token-a" }) };
        if (url.includes("/URLSetup/RegisterIPN")) {
          const request = JSON.parse(String((vi.mocked(fetch).mock.calls.at(-1)?.[1] as RequestInit)?.body));
          expect(request.url).toBe("https://lexibite.example/api/pesapal-ipn");
          return { ok: true, status: 200, json: async () => ({ ipn_id: "ipn-property-a" }) };
        }
        if (url.includes("/Transactions/SubmitOrderRequest")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              order_tracking_id: "tracking-a",
              redirect_url: "https://cybqa.pesapal.com/checkout/tracking-a",
            }),
          };
        }
        throw new Error("Unexpected Pesapal endpoint");
      }),
    );
    const provider = await getConfiguredProvider(integrationDb(row) as any, TENANT, PROPERTY);
    const result = await provider!.initiate({
      amount: 1000,
      currency: "TZS",
      merchantReference: "order-a",
      description: "Order A",
      returnUrl: "https://lexibite.example/guest/session/payment",
    });
    expect(result.providerReference).toBe("tracking-a");
    expect(row.config).toMatchObject({ environment: "sandbox", ipnId: "ipn-property-a" });
  });
});
