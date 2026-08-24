/**
 * HTTP-contract tests for the Vercel Function itself: query parsing, the
 * exact response envelope Pesapal's IPN caller expects, and that a real
 * processing failure (vs. a validly-processed non-paid outcome) is the
 * only thing that produces a retry-worthy status. The underlying
 * verification/idempotency/amount-reconciliation logic this endpoint calls
 * (confirmPesapalCallback) is already covered end-to-end in
 * src/modules/restaurant/selforder/selfpay.server.test.ts — this file
 * proves the endpoint wraps it correctly, not that logic again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const confirmPesapalCallback = vi.fn();

vi.mock("../src/integrations/supabase/client.server", () => ({
  supabaseAdmin: {},
}));
vi.mock("../src/modules/restaurant/selforder/selfpay.server", () => ({
  confirmPesapalCallback: (...args: unknown[]) => confirmPesapalCallback(...args),
}));

async function callHandler(query: string) {
  const { default: handler } = await import("./pesapal-ipn");
  const request = new Request(`https://example.test/api/pesapal-ipn${query}`);
  const response = await handler(request);
  const body = await response.json();
  return { httpStatus: response.status, body };
}

describe("POST/GET /api/pesapal-ipn", () => {
  afterEach(() => {
    confirmPesapalCallback.mockReset();
  });

  it("a valid IPN calls confirmPesapalCallback with the reference/order id it carries, and acknowledges success", async () => {
    confirmPesapalCallback.mockResolvedValue({ ok: true, status: "paid" });
    const { httpStatus, body } = await callHandler(
      "?OrderTrackingId=track-1&OrderMerchantReference=order-1&OrderNotificationType=IPNCHANGE",
    );
    expect(confirmPesapalCallback).toHaveBeenCalledWith(
      {},
      { orderId: "order-1", providerReference: "track-1" },
    );
    expect(httpStatus).toBe(200);
    expect(body).toEqual({
      orderNotificationType: "IPNCHANGE",
      orderTrackingId: "track-1",
      orderMerchantReference: "order-1",
      status: 200,
    });
  });

  it("a duplicate IPN for the same reference is harmless — confirmPesapalCallback's own idempotency handles it, the endpoint just acknowledges again", async () => {
    confirmPesapalCallback.mockResolvedValue({ ok: false, reason: "already_paid" });
    const { httpStatus, body } = await callHandler(
      "?OrderTrackingId=track-1&OrderMerchantReference=order-1",
    );
    expect(httpStatus).toBe(200);
    expect(body.status).toBe(200);
  });

  it("an unknown tracking id / merchant reference is acknowledged, not treated as a server error", async () => {
    confirmPesapalCallback.mockResolvedValue({ ok: false, reason: "order_not_found" });
    const { httpStatus, body } = await callHandler(
      "?OrderTrackingId=unknown-track&OrderMerchantReference=unknown-order",
    );
    expect(httpStatus).toBe(200);
    expect(body.status).toBe(200);
  });

  it("Failed / Pending / Expired outcomes are all acknowledged, not retried — none of them are a delivery failure", async () => {
    for (const result of [
      { ok: false, reason: "declined" },
      { ok: true, status: "pending" },
      { ok: false, reason: "expired" },
      { ok: false, reason: "amount_mismatch" },
    ]) {
      confirmPesapalCallback.mockResolvedValue(result);
      const { httpStatus, body } = await callHandler(
        "?OrderTrackingId=track-1&OrderMerchantReference=order-1",
      );
      expect(httpStatus).toBe(200);
      expect(body.status).toBe(200);
    }
  });

  it("a malformed IPN (missing required params) is acknowledged without ever calling confirmPesapalCallback", async () => {
    const { httpStatus, body } = await callHandler("?OrderNotificationType=IPNCHANGE");
    expect(confirmPesapalCallback).not.toHaveBeenCalled();
    expect(httpStatus).toBe(200);
    expect(body.status).toBe(200);
    expect(body.orderTrackingId).toBe("");
    expect(body.orderMerchantReference).toBe("");
  });

  it("a real processing failure reports status 500 in the envelope so Pesapal retries, without leaking the underlying error", async () => {
    confirmPesapalCallback.mockRejectedValue(new Error("Pesapal unreachable: ECONNRESET"));
    const { httpStatus, body } = await callHandler(
      "?OrderTrackingId=track-1&OrderMerchantReference=order-1",
    );
    expect(httpStatus).toBe(200); // Pesapal's contract signals failure via the body, not the HTTP status
    expect(body.status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/ECONNRESET|Pesapal unreachable/);
  });
});
