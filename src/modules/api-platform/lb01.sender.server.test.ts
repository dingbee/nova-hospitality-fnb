import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLb01Request } from "./lb01.service-auth";
import { sendLb01Approval } from "./lb01.sender.server";

function peerToken() {
  return `lb01_v1_${randomBytes(12).toString("hex")}_${randomBytes(32).toString("base64url")}`;
}

describe("LB-01 outbound approval transport", () => {
  it("sends a signed request to the fixed approval route and validates the peer response", async () => {
    const token = peerToken();
    const secret = token.split("_").at(-1)!;
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const correlationId = "lb01-correlation-001";
    const result = await sendLb01Approval(
      { endpointUrl: "https://staynas.example/api/integrations/lb01/approval", credentialToken: token },
      correlationId,
      async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({ accepted: true, status: "active", correlationId });
      },
    );
    expect(result).toEqual({ accepted: true, status: "active", correlationId });
    expect(capturedUrl).toBe("https://staynas.example/api/integrations/lb01/approval");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.redirect).toBe("manual");
    const headers = new Headers(capturedInit?.headers);
    const body = String(capturedInit?.body);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(verifyLb01Request(secret, {
      method: "POST",
      pathname: "/api/integrations/lb01/approval",
      rawBody: body,
      timestamp: headers.get("x-lb01-timestamp") ?? "",
      nonce: headers.get("x-lb01-nonce") ?? "",
      signature: headers.get("x-lb01-signature") ?? "",
    })).toBe(true);
    expect(JSON.parse(body)).toEqual({ correlationId });
  });

  it("adds the peer deployment protection bypass from the server-only environment", async () => {
    const previous = process.env.LB01_PEER_VERCEL_BYPASS_SECRET;
    process.env.LB01_PEER_VERCEL_BYPASS_SECRET = "test-peer-bypass-secret";
    let capturedHeaders: Headers | undefined;
    try {
      await sendLb01Approval(
        { endpointUrl: "https://staynas.example/api/integrations/lb01/approval", credentialToken: peerToken() },
        "lb01-correlation-001",
        async (_input, init) => {
          capturedHeaders = new Headers(init?.headers);
          return Response.json({ accepted: true, status: "pending", correlationId: "lb01-correlation-001" });
        },
      );
      expect(capturedHeaders?.get("x-vercel-protection-bypass")).toBe("test-peer-bypass-secret");
    } finally {
      if (previous === undefined) delete process.env.LB01_PEER_VERCEL_BYPASS_SECRET;
      else process.env.LB01_PEER_VERCEL_BYPASS_SECRET = previous;
    }
  });

  it("rejects insecure endpoints, invalid credentials and unconfirmed responses", async () => {
    const token = peerToken();
    await expect(sendLb01Approval(
      { endpointUrl: "http://staynas.example/api/integrations/lb01/approval", credentialToken: token },
      "lb01-correlation-001",
    )).rejects.toThrow("trusted HTTPS");
    await expect(sendLb01Approval(
      { endpointUrl: "https://staynas.example/api/integrations/lb01/approval", credentialToken: "bad" },
      "lb01-correlation-001",
    )).rejects.toThrow("Invalid LB-01 peer credential");
    await expect(sendLb01Approval(
      { endpointUrl: "https://staynas.example/api/integrations/lb01/approval", credentialToken: token },
      "lb01-correlation-001",
      async () => Response.json({ accepted: false, status: "pending", correlationId: "wrong" }),
    )).rejects.toThrow("did not confirm");
  });

  it("does not treat a failed HTTP response as an accepted approval", async () => {
    await expect(sendLb01Approval(
      { endpointUrl: "https://staynas.example/api/integrations/lb01/approval", credentialToken: peerToken() },
      "lb01-correlation-001",
      async () => new Response(null, { status: 503 }),
    )).rejects.toThrow("HTTP 503");
  });
});
