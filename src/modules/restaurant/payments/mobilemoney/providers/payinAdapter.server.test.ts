import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPayInAdapter } from "./payinAdapter.server";

const credentials = {
  apiKey: "pk_test_example",
  apiSecret: "sk_test_example",
  webhookSecret: "whsec_example",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PayIn adapter", () => {
  it("creates a collection with provider idempotency and Tanzania operator mapping", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          request_ref: "PAY123",
          status: "processing",
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createPayInAdapter("test", credentials);
    const result = await adapter.createCollection({
      environment: "test",
      idempotencyKey: "mm-idem-123",
      network: "mixx_yas",
      merchantNumber: "ignored",
      customerPhone: "0712345678",
      amount: 5000,
      currency: "TZS",
      reference: "mm:collection-1",
    });

    expect(result).toEqual({ outcome: "accepted", providerReference: "PAY123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, request] = fetchMock.mock.calls[0];
    expect(request?.headers).toMatchObject({
      "X-API-Key": credentials.apiKey,
      "X-API-Secret": credentials.apiSecret,
      "X-Idempotency-Key": "mm-idem-123",
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      phone: "255712345678",
      amount: 5000,
      currency: "TZS",
      operator: "tigopesa",
      reference: "mm:collection-1",
    });
  });

  it("rejects a connected request without a customer phone", async () => {
    const adapter = createPayInAdapter("test", credentials);
    await expect(
      adapter.createCollection({
        environment: "test",
        idempotencyKey: "mm-idem-124",
        network: "mpesa",
        merchantNumber: "ignored",
        customerPhone: null,
        amount: 5000,
        currency: "TZS",
        reference: "mm:collection-2",
      }),
    ).resolves.toMatchObject({
      outcome: "rejected",
      errorClass: "validation",
    });
  });

  it("maps completed provider status to paid without trusting webhook state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            request_ref: "PAY123",
            amount: 5000,
            currency: "TZS",
            status: "completed",
            updated_at: "2026-10-04T20:00:00Z",
          }),
          { status: 200 },
        ),
      ),
    );

    const adapter = createPayInAdapter("test", credentials);
    await expect(adapter.verifyTransaction("PAY123")).resolves.toMatchObject({
      outcome: "paid",
      providerReference: "PAY123",
      confirmedAmount: 5000,
      confirmedCurrency: "TZS",
    });
  });

  it("verifies the signed webhook with timestamp-bound HMAC", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      event: "payin.completed",
      request_ref: "PAY123",
      gross_amount: 5000,
      currency: "TZS",
      status: "completed",
      timestamp: new Date().toISOString(),
    });
    const signature = createHmac("sha256", credentials.webhookSecret)
      .update(timestamp + "." + body)
      .digest("hex");

    const adapter = createPayInAdapter("test", credentials);
    await expect(
      adapter.handleWebhook({
        rawBody: body,
        headers: {
          "x-payin-signature": signature,
          "x-payin-timestamp": timestamp,
        },
      }),
    ).resolves.toMatchObject({
      outcome: "event",
      signatureValid: true,
      providerReference: "PAY123",
      status: "paid",
      confirmedAmount: 5000,
      confirmedCurrency: "TZS",
    });
  });

  it("rejects a stale webhook signature", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 301);
    const body = JSON.stringify({
      event: "payin.completed",
      request_ref: "PAY123",
      gross_amount: 5000,
      currency: "TZS",
      status: "completed",
    });
    const signature = createHmac("sha256", credentials.webhookSecret)
      .update(timestamp + "." + body)
      .digest("hex");

    const adapter = createPayInAdapter("test", credentials);
    await expect(
      adapter.handleWebhook({
        rawBody: body,
        headers: {
          "x-payin-signature": signature,
          "x-payin-timestamp": timestamp,
        },
      }),
    ).resolves.toMatchObject({
      outcome: "event",
      signatureValid: false,
    });
  });
});
