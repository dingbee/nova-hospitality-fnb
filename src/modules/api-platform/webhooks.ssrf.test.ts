import { describe, expect, it } from "vitest";
import { assertPublicHttpsUrl } from "./webhooks.server";
import { ApiError } from "./errors";

describe("webhooks.server — SSRF guard (assertPublicHttpsUrl)", () => {
  it("accepts a plausible public https URL", () => {
    expect(() => assertPublicHttpsUrl("https://example.com/webhooks/nova")).not.toThrow();
    expect(() =>
      assertPublicHttpsUrl("https://api.partner-provider.io/hooks/abc123"),
    ).not.toThrow();
  });

  it("rejects plain http (no TLS)", () => {
    expect(() => assertPublicHttpsUrl("http://example.com/hook")).toThrow(ApiError);
  });

  it("rejects an invalid URL instead of throwing an unhandled parse error", () => {
    expect(() => assertPublicHttpsUrl("not a url")).toThrow(ApiError);
  });

  it("rejects credentials embedded in the URL", () => {
    expect(() => assertPublicHttpsUrl("https://user:pass@example.com/hook")).toThrow(ApiError);
  });

  it.each([
    "https://localhost/hook",
    "https://LOCALHOST/hook",
    "https://127.0.0.1/hook",
    "https://127.0.0.5/hook",
    "https://0.0.0.0/hook",
    "https://10.0.0.5/hook",
    "https://10.255.255.255/hook",
    "https://192.168.1.1/hook",
    "https://169.254.169.254/hook", // cloud metadata endpoint
    "https://172.16.0.1/hook",
    "https://172.31.255.255/hook",
    "https://internal-service.local/hook",
    "https://box.internal/hook",
    "https://[::1]/hook",
  ])("rejects private/internal address %s", (url) => {
    expect(() => assertPublicHttpsUrl(url)).toThrow(ApiError);
  });

  it("does not false-positive on a public address that merely starts similarly to a private range", () => {
    // 172.32.x.x is OUTSIDE the private 172.16.0.0/12 block (172.16-172.31) — must not be blocked.
    expect(() => assertPublicHttpsUrl("https://172.32.0.1/hook")).not.toThrow();
    // 10999.example.com is a public hostname, not the 10.x private range.
    expect(() => assertPublicHttpsUrl("https://10999.example.com/hook")).not.toThrow();
  });
});
