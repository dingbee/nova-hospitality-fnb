/**
 * ME-16 remediation (ME16-06/07) — HTTP-contract tests for the mobile
 * money webhook Vercel Function, mirroring pesapal-ipn.test.ts's pattern.
 * Before this remediation, a genuine processing exception here produced
 * zero server-side evidence (`catch { return failed(); }`, no binding, no
 * logging) — this reproduces that exact failure and proves it is now
 * logged, without changing the safe response envelope the provider sees.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const handleMobileMoneyWebhookEvent = vi.fn();

vi.mock("../src/integrations/supabase/client.server", () => ({
  supabaseAdmin: {},
}));
vi.mock("../src/modules/restaurant/payments/mobilemoney/mobilemoney.server", () => ({
  handleMobileMoneyWebhookEvent: (...args: unknown[]) => handleMobileMoneyWebhookEvent(...args),
}));

async function callHandler(providerCode: string, rawBody = "{}") {
  const { default: handler } = await import("./mobile-money-webhook");
  const request = new Request(`https://example.test/api/mobile-money-webhook/${providerCode}`, {
    method: "POST",
    body: rawBody,
  });
  const response = await handler(request);
  const body = await response.json();
  return { httpStatus: response.status, body };
}

describe("POST /api/mobile-money-webhook/:providerCode", () => {
  afterEach(() => {
    handleMobileMoneyWebhookEvent.mockReset();
    vi.restoreAllMocks();
  });

  it("acknowledges success without ever leaking anything when processing succeeds", async () => {
    handleMobileMoneyWebhookEvent.mockResolvedValue({ ok: true });
    const { httpStatus, body } = await callHandler("tz_mm_aggregator");
    expect(httpStatus).toBe(200);
    expect(body).toEqual({ received: true });
  });

  it("reports status 500 without leaking the underlying error on a real processing failure", async () => {
    handleMobileMoneyWebhookEvent.mockRejectedValue(new Error("db_unreachable: ECONNRESET"));
    const { httpStatus, body } = await callHandler("tz_mm_aggregator");
    expect(httpStatus).toBe(500);
    expect(body).toEqual({ received: false });
    expect(JSON.stringify(body)).not.toMatch(/ECONNRESET/);
  });

  it("ME-16 remediation: the same failure is now logged server-side (previously: zero evidence)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalError = new Error("db_unreachable: ECONNRESET");
    handleMobileMoneyWebhookEvent.mockRejectedValue(originalError);

    await callHandler("tz_mm_aggregator");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [tag, payload, loggedError] = errorSpy.mock.calls[0]!;
    expect(tag).toBe("[webhook:mobile-money]");
    const parsed = JSON.parse(payload as string);
    expect(parsed.providerCode).toBe("tz_mm_aggregator");
    expect(typeof parsed.requestId).toBe("string");
    expect(loggedError).toBe(originalError);
  });
});
