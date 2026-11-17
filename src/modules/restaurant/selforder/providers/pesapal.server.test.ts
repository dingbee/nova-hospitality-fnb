import { afterEach, describe, expect, it, vi } from "vitest";
import { createPesapalAdapter, type PesapalAdapterConfig } from "./pesapal.server";

function config(overrides: Partial<PesapalAdapterConfig> = {}): PesapalAdapterConfig {
  return {
    consumerKey: "tenant-consumer-key",
    consumerSecret: "tenant-consumer-secret",
    environment: "sandbox",
    ipnId: "tenant-ipn-1",
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe("createPesapalAdapter — property-configured credentials", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns null when credentials or the property IPN binding are absent", () => {
    expect(createPesapalAdapter(null)).toBeNull();
    expect(createPesapalAdapter(undefined)).toBeNull();
    expect(createPesapalAdapter(config({ consumerKey: "" }))).toBeNull();
    expect(createPesapalAdapter(config({ ipnId: undefined }))).toBeNull();
  });

  it("returns a provider only for a complete property integration", () => {
    const adapter = createPesapalAdapter(config());
    expect(adapter).not.toBeNull();
    expect(adapter!.name).toBe("pesapal");
  });

  it("authenticates with this integration's credentials and submits the server-derived order", async () => {
    const calls: { url: string; body: Record<string, unknown> | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.includes("/Auth/RequestToken")) {
          return jsonResponse({
            token: "tenant-token",
            expiryDate: new Date(Date.now() + 300_000).toISOString(),
          });
        }
        if (url.includes("/Transactions/SubmitOrderRequest")) {
          return jsonResponse({
            order_tracking_id: "track-1",
            redirect_url: "https://cybqa.pesapal.com/checkout/track-1",
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const adapter = createPesapalAdapter(config())!;
    const result = await adapter.initiate({
      amount: 11000,
      currency: "TZS",
      merchantReference: "order-1",
      description: "Order ORD-1",
      returnUrl: "https://example.test/order/order-1?pay=return",
    });

    expect(result).toEqual({
      providerReference: "track-1",
      redirectUrl: "https://cybqa.pesapal.com/checkout/track-1",
    });
    const auth = calls.find((call) => call.url.includes("/Auth/RequestToken"))!;
    expect(auth.body).toEqual({
      consumer_key: "tenant-consumer-key",
      consumer_secret: "tenant-consumer-secret",
    });
    const submit = calls.find((call) => call.url.includes("SubmitOrderRequest"))!;
    expect(submit.body).toMatchObject({
      id: "order-1",
      currency: "TZS",
      amount: 11000,
      callback_url: "https://example.test/order/order-1?pay=return",
      notification_id: "tenant-ipn-1",
    });
  });

  it("registers the IPN once and persists its provider-issued id through the integration callback", async () => {
    const calls: string[] = [];
    const persist = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("/Auth/RequestToken")) return jsonResponse({ token: "tenant-token" });
        if (url.includes("/URLSetup/RegisterIPN")) return jsonResponse({ ipn_id: "registered-ipn" });
        if (url.includes("/Transactions/SubmitOrderRequest")) {
          return jsonResponse({
            order_tracking_id: "track-2",
            redirect_url: "https://cybqa.pesapal.com/checkout/track-2",
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const adapter = createPesapalAdapter(
      config({ ipnId: undefined, ipnUrl: "https://lexibite.example/api/pesapal-ipn", onIpnRegistered: persist }),
    )!;
    await adapter.initiate({
      amount: 1000,
      currency: "TZS",
      merchantReference: "order-2",
      description: "Order",
      returnUrl: "https://lexibite.example/guest/session/payment",
    });
    expect(calls.filter((url) => url.includes("/URLSetup/RegisterIPN"))).toHaveLength(1);
    expect(persist).toHaveBeenCalledWith("registered-ipn");
  });

  it("logs a rejected order-submission call server-side without changing the thrown message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/Auth/RequestToken")) return jsonResponse({ token: "tok-x" });
        if (url.includes("/Transactions/SubmitOrderRequest")) {
          return jsonResponse({ error: { message: "invalid consumer key" } }, false, 401);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const adapter = createPesapalAdapter(config())!;
    await expect(
      adapter.initiate({
        amount: 1000,
        currency: "TZS",
        merchantReference: "order-2",
        description: "Order",
        returnUrl: "https://example.test/return",
      }),
    ).rejects.toThrow("invalid consumer key");

    const submissionLog = errorSpy.mock.calls.find(
      (call) => JSON.parse(call[1] as string).status === 401,
    );
    expect(submissionLog).toBeDefined();
    expect(submissionLog![0]).toBe("[integration:pesapal]");
  });

  it("logs network failures without changing the thrown error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/Auth/RequestToken")) return jsonResponse({ token: "tok-y" });
        if (url.includes("/Transactions/SubmitOrderRequest")) throw new TypeError("fetch failed");
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const adapter = createPesapalAdapter(config())!;
    await expect(
      adapter.initiate({
        amount: 1000,
        currency: "TZS",
        merchantReference: "order-3",
        description: "Order",
        returnUrl: "https://example.test/return",
      }),
    ).rejects.toThrow("fetch failed");

    const networkLog = errorSpy.mock.calls.find(
      (call) => JSON.parse(call[1] as string).reason === "network",
    );
    expect(networkLog).toBeDefined();
    expect(networkLog![0]).toBe("[integration:pesapal]");
  });

  it("verify maps a completed transaction to paid with the provider-confirmed amount and currency", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/Auth/RequestToken")) return jsonResponse({ token: "tok-1" });
        if (url.includes("/GetTransactionStatus")) {
          return jsonResponse({
            status_code: 1,
            payment_status_description: "Completed",
            amount: 11000,
            currency: "TZS",
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const result = await createPesapalAdapter(config())!.verify({ providerReference: "track-1" });
    expect(result).toMatchObject({ status: "paid", amount: 11000, currency: "TZS" });
  });

  it("verify has a hard timeout for a hanging status request", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          if (url.includes("/Auth/RequestToken")) return Promise.resolve(jsonResponse({ token: "tok-1" }));
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }),
      );
      const verifyPromise = createPesapalAdapter(config())!.verify({ providerReference: "track-1" });
      let settled = false;
      verifyPromise.catch(() => {});
      verifyPromise.then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(19_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [{ status_code: 2, payment_status_description: "Failed" }, "failed"],
    [{ status_code: 0, payment_status_description: "Expired" }, "expired"],
    [{ status_code: 0, payment_status_description: "Pending" }, "pending"],
  ])("maps non-paid provider states safely", async (body, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/Auth/RequestToken")) return jsonResponse({ token: "tok-1" });
        if (url.includes("/GetTransactionStatus")) return jsonResponse(body);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const result = await createPesapalAdapter(config())!.verify({ providerReference: "track-1" });
    expect(result.status).toBe(expected);
  });

  it("uses the integration-selected environment, never a process-wide default", async () => {
    const hosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        hosts.push(new URL(url).host);
        if (url.includes("/Auth/RequestToken")) return jsonResponse({ token: "tok-1" });
        return jsonResponse({ status_code: 0, payment_status_description: "Pending" });
      }),
    );
    await createPesapalAdapter(config({ environment: "sandbox" }))!.verify({ providerReference: "track-1" });
    expect(hosts.every((host) => host === "cybqa.pesapal.com")).toBe(true);

    hosts.length = 0;
    await createPesapalAdapter(config({ environment: "production" }))!.verify({ providerReference: "track-2" });
    expect(hosts.every((host) => host === "pay.pesapal.com")).toBe(true);
  });
});
