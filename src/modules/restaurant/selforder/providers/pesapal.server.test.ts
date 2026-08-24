import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPesapalAdapter } from "./pesapal.server";

const ORIGINAL_ENV = { ...process.env };

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe("createPesapalAdapter", () => {
  beforeEach(() => {
    setEnv(ORIGINAL_ENV);
    setEnv({
      PESAPAL_CONSUMER_KEY: undefined,
      PESAPAL_CONSUMER_SECRET: undefined,
      PESAPAL_ENV: undefined,
      PESAPAL_IPN_URL: undefined,
      PESAPAL_IPN_ID: undefined,
    });
  });
  afterEach(() => {
    setEnv(ORIGINAL_ENV);
    vi.restoreAllMocks();
  });

  it("returns null — never a fake provider — when no consumer key/secret is configured", () => {
    expect(createPesapalAdapter()).toBeNull();
  });

  it("returns a real adapter once credentials exist", () => {
    setEnv({
      PESAPAL_CONSUMER_KEY: "key",
      PESAPAL_CONSUMER_SECRET: "secret",
      PESAPAL_IPN_ID: "ipn-1",
    });
    const adapter = createPesapalAdapter();
    expect(adapter).not.toBeNull();
    expect(adapter!.name).toBe("pesapal");
  });

  describe("with credentials configured", () => {
    beforeEach(() => {
      setEnv({
        PESAPAL_CONSUMER_KEY: "key",
        PESAPAL_CONSUMER_SECRET: "secret",
        PESAPAL_IPN_ID: "ipn-1",
      });
    });

    it("initiate() authenticates, then submits the order with the server-derived amount/currency, never anything else", async () => {
      const calls: { url: string; body: Record<string, unknown> | null }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
          if (url.includes("/Auth/RequestToken")) {
            return jsonResponse({
              token: "tok-1",
              expiryDate: new Date(Date.now() + 300_000).toISOString(),
            });
          }
          if (url.includes("/Transactions/SubmitOrderRequest")) {
            return jsonResponse({
              order_tracking_id: "track-1",
              redirect_url: "https://cybqa.pesapal.com/checkout/track-1",
              merchant_reference: calls[calls.length - 1]?.body?.id,
              status: "200",
            });
          }
          throw new Error(`unexpected fetch: ${url}`);
        }),
      );

      const adapter = createPesapalAdapter()!;
      const result = await adapter.initiate({
        amount: 11000,
        currency: "TZS",
        merchantReference: "order-1",
        description: "Order ORD-1",
        returnUrl: "https://example.test/order/table-1?pay=return",
      });

      expect(result).toEqual({
        providerReference: "track-1",
        redirectUrl: "https://cybqa.pesapal.com/checkout/track-1",
      });
      const submit = calls.find((c) => c.url.includes("SubmitOrderRequest"))!;
      expect(submit.body).toMatchObject({
        id: "order-1",
        currency: "TZS",
        amount: 11000,
        callback_url: "https://example.test/order/table-1?pay=return",
        notification_id: "ipn-1",
      });
    });

    it("verify() maps a completed transaction to paid", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/Auth/RequestToken")) return jsonResponse({ token: "tok-1" });
          if (url.includes("/GetTransactionStatus")) {
            return jsonResponse({ status_code: 1, payment_status_description: "Completed" });
          }
          throw new Error(`unexpected fetch: ${url}`);
        }),
      );
      const adapter = createPesapalAdapter()!;
      const result = await adapter.verify({ providerReference: "track-1" });
      expect(result.status).toBe("paid");
    });

    it("verify() maps a failed transaction to failed, never paid", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/Auth/RequestToken")) return jsonResponse({ token: "tok-1" });
          if (url.includes("/GetTransactionStatus")) {
            return jsonResponse({ status_code: 2, payment_status_description: "Failed" });
          }
          throw new Error(`unexpected fetch: ${url}`);
        }),
      );
      const adapter = createPesapalAdapter()!;
      const result = await adapter.verify({ providerReference: "track-1" });
      expect(result.status).toBe("failed");
    });

    it("verify() maps an expired transaction to expired, never paid", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/Auth/RequestToken")) return jsonResponse({ token: "tok-1" });
          if (url.includes("/GetTransactionStatus")) {
            return jsonResponse({ status_code: 0, payment_status_description: "Expired" });
          }
          throw new Error(`unexpected fetch: ${url}`);
        }),
      );
      const adapter = createPesapalAdapter()!;
      const result = await adapter.verify({ providerReference: "track-1" });
      expect(result.status).toBe("expired");
    });

    it("verify() maps an in-progress transaction to pending, never paid", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/Auth/RequestToken")) return jsonResponse({ token: "tok-1" });
          if (url.includes("/GetTransactionStatus")) {
            return jsonResponse({ status_code: 0, payment_status_description: "Pending" });
          }
          throw new Error(`unexpected fetch: ${url}`);
        }),
      );
      const adapter = createPesapalAdapter()!;
      const result = await adapter.verify({ providerReference: "track-1" });
      expect(result.status).toBe("pending");
    });

    it("uses the sandbox host by default and the production host only when PESAPAL_ENV=production", async () => {
      const hosts: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          hosts.push(new URL(url).host);
          if (url.includes("/Auth/RequestToken")) return jsonResponse({ token: "tok-1" });
          return jsonResponse({ status_code: 0, payment_status_description: "Pending" });
        }),
      );
      const sandboxAdapter = createPesapalAdapter()!;
      await sandboxAdapter.verify({ providerReference: "track-1" });
      expect(hosts.every((h) => h === "cybqa.pesapal.com")).toBe(true);

      hosts.length = 0;
      setEnv({ PESAPAL_ENV: "production" });
      const prodAdapter = createPesapalAdapter()!;
      await prodAdapter.verify({ providerReference: "track-1" });
      expect(hosts.every((h) => h === "pay.pesapal.com")).toBe(true);
    });
  });
});
