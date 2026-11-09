import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signLb01Request, verifyLb01Request } from "./lb01.service-auth";

describe("LB-01 signed service request protocol", () => {
  const secret = randomBytes(32).toString("base64url");
  const request = {
    method: "POST",
    pathname: "/api/v1/integrations/lb01/approval",
    rawBody: '{"integrationPropertyId":"00000000-0000-4000-8000-000000000001"}',
    timestamp: "1794153600",
    nonce: "0123456789abcdef0123456789abcdef",
  };
  const signed = { ...request, signature: signLb01Request(secret, request) };

  it("accepts an authentic request within the clock-skew window", () => {
    expect(verifyLb01Request(secret, signed, 1794153600)).toBe(true);
  });

  it("rejects a modified body, method, path, timestamp or nonce", () => {
    expect(verifyLb01Request(secret, { ...signed, rawBody: "{}" }, 1794153600)).toBe(false);
    expect(verifyLb01Request(secret, { ...signed, method: "GET" }, 1794153600)).toBe(false);
    expect(verifyLb01Request(secret, { ...signed, pathname: "/other" }, 1794153600)).toBe(false);
    expect(verifyLb01Request(secret, { ...signed, timestamp: "1794153200" }, 1794153600)).toBe(false);
    expect(verifyLb01Request(secret, { ...signed, nonce: "short" }, 1794153600)).toBe(false);
  });

  it("rejects stale/future timestamps, malformed signatures and invalid secrets", () => {
    expect(verifyLb01Request(secret, signed, 1794154001)).toBe(false);
    expect(verifyLb01Request(secret, signed, 1794153199)).toBe(false);
    expect(verifyLb01Request(secret, { ...signed, signature: "v1=bad" }, 1794153600)).toBe(false);
    expect(verifyLb01Request("not-a-secret", signed, 1794153600)).toBe(false);
  });

  it("does not treat signature verification as replay prevention", () => {
    // Repeated authentic requests intentionally verify identically. The HTTP
    // adapter must claim each nonce in the durable unique-key nonce ledger.
    expect(verifyLb01Request(secret, signed, 1794153600)).toBe(true);
    expect(verifyLb01Request(secret, signed, 1794153600)).toBe(true);
  });
});
