/**
 * ME-13: neither sendEmail nor sendWhatsApp had a timeout or regression
 * coverage of any kind before this pass — a hanging provider held the
 * calling "send receipt" request (delivery.server.ts) open indefinitely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail, sendWhatsApp } from "./adapters.server";

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

describe("notification adapters", () => {
  beforeEach(() => {
    setEnv(ORIGINAL_ENV);
  });
  afterEach(() => {
    setEnv(ORIGINAL_ENV);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("sendEmail", () => {
    it("delivers successfully when the webhook responds", async () => {
      setEnv({ NOVA_EMAIL_WEBHOOK_URL: "https://relay.example/send" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ id: "msg-1" })),
      );
      const result = await sendEmail({ to: "a@b.com", subject: "hi", html: "<p>hi</p>" });
      expect(result).toEqual({ ok: true, provider: "email", reference: "msg-1" });
    });

    it("ME-13: aborts instead of hanging forever when the webhook never responds", async () => {
      setEnv({ NOVA_EMAIL_WEBHOOK_URL: "https://relay.example/send" });
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        ),
      );
      const promise = sendEmail({ to: "a@b.com", subject: "hi", html: "<p>hi</p>" });
      let settled = false;
      promise.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(14_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(true);
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ provider: "email", reason: "network" });
    });
  });

  describe("sendWhatsApp", () => {
    it("delivers successfully when Twilio responds", async () => {
      setEnv({ TWILIO_ACCOUNT_SID: "sid", TWILIO_AUTH_TOKEN: "tok", WHATSAPP_FROM: "+1555" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ sid: "SM1" })),
      );
      const result = await sendWhatsApp("+1666", "hi");
      expect(result).toEqual({ ok: true, provider: "twilio_whatsapp", reference: "SM1" });
    });

    it("ME-13: aborts instead of hanging forever when Twilio never responds", async () => {
      setEnv({ TWILIO_ACCOUNT_SID: "sid", TWILIO_AUTH_TOKEN: "tok", WHATSAPP_FROM: "+1555" });
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        ),
      );
      const promise = sendWhatsApp("+1666", "hi");
      let settled = false;
      promise.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(14_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(true);
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ provider: "twilio_whatsapp", reason: "network" });
    });
  });

  describe("ME-16 remediation: operator-side diagnostic logging", () => {
    it("logs a rejected email send without changing the returned AdapterResult", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      setEnv({ NOVA_EMAIL_WEBHOOK_URL: "https://relay.example/send" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ message: "invalid recipient" }, false, 422)),
      );
      const result = await sendEmail({ to: "bad", subject: "hi", html: "<p>hi</p>" });
      expect(result).toEqual({
        ok: false,
        provider: "email",
        reason: "rejected",
        error: "invalid recipient",
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [tag] = errorSpy.mock.calls[0]!;
      expect(tag).toBe("[integration:email]");
    });

    it("logs a network failure for WhatsApp without changing the returned AdapterResult", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      setEnv({ TWILIO_ACCOUNT_SID: "sid", TWILIO_AUTH_TOKEN: "tok", WHATSAPP_FROM: "+1555" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("getaddrinfo ENOTFOUND api.twilio.com");
        }),
      );
      const result = await sendWhatsApp("+1666", "hi");
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ provider: "twilio_whatsapp", reason: "network" });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [tag] = errorSpy.mock.calls[0]!;
      expect(tag).toBe("[integration:twilio_whatsapp]");
    });

    it("does NOT log the 'not configured' state — that is a supported deployment state, not a failure", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      setEnv({ NOVA_EMAIL_WEBHOOK_URL: undefined });
      const result = await sendEmail({ to: "a@b.com", subject: "hi", html: "<p>hi</p>" });
      expect(result).toEqual({ ok: false, provider: "email", reason: "not_configured" });
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
