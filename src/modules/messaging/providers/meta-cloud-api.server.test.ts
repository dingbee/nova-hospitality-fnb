import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetaGraphError,
  assertRequiredWhatsAppPermissions,
  checkPhoneNumberHealth,
  exchangeEmbeddedSignupCode,
  getWabaDetails,
  inspectAccessToken,
  listWabaPhoneNumbers,
  registerVerifiedPhoneNumber,
  sendTextMessage,
  subscribeWabaToApp,
  verifyWebhookChallenge,
  verifyWebhookSignature,
} from "./meta-cloud-api.server";

const credentials = { accessToken: "tenant-access-token", wabaId: "waba-123", phoneNumberId: "phone-456" };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.META_GRAPH_API_VERSION;
});

describe("Meta WhatsApp Cloud API foundation", () => {
  it("uses the configured Graph API version and bearer token for WABA reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "waba-123", name: "Test WABA" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getWabaDetails(credentials, { graphApiVersion: "v27.0" })).resolves.toMatchObject({ id: "waba-123" });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/v27.0/waba-123");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tenant-access-token");
  });

  it("rejects invalid Graph API version strings", async () => {
    await expect(getWabaDetails(credentials, { graphApiVersion: "latest" })).rejects.toThrow(/META_GRAPH_API_VERSION/);
  });

  it("exchanges Embedded Signup authorization codes server-side", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "exchanged-token", token_type: "bearer", expires_in: 3600 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(exchangeEmbeddedSignupCode("signup-code", { appId: "app-1", appSecret: "app-secret", graphApiVersion: "v27.0" }))
      .resolves.toEqual({ accessToken: "exchanged-token", tokenType: "bearer", expiresIn: 3600 });
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(String(url)).toContain("/v27.0/oauth/access_token");
    expect(url.searchParams.get("client_secret")).toBe("app-secret");
    expect(url.searchParams.get("code")).toBe("signup-code");
  });


  it("inspects token validity and enforces the two required WhatsApp scopes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { is_valid: true, app_id: "app-1", expires_at: 1900000000, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"] },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const inspected = await inspectAccessToken("tenant-token", { appId: "app-1", appSecret: "app-secret", graphApiVersion: "v27.0" });
    expect(inspected.is_valid).toBe(true);
    expect(() => assertRequiredWhatsAppPermissions(inspected)).not.toThrow();
    expect(() => assertRequiredWhatsAppPermissions({ is_valid: true, scopes: ["whatsapp_business_management"] }))
      .toThrow(/whatsapp_business_messaging/);
    expect(() => assertRequiredWhatsAppPermissions({ is_valid: false, scopes: [] })).toThrow(/invalid or expired/);
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(String(url)).toContain("/v27.0/debug_token");
  });

  it("lists phone numbers and checks phone-number health", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "phone-456", quality_rating: "GREEN" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "phone-456", display_phone_number: "+255700000000" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listWabaPhoneNumbers(credentials)).resolves.toHaveLength(1);
    await expect(checkPhoneNumberHealth(credentials)).resolves.toMatchObject({ id: "phone-456" });
  });

  it("registers a verified number only with a six-digit PIN", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(registerVerifiedPhoneNumber(credentials, "123456")).resolves.toEqual({ success: true });
    await expect(registerVerifiedPhoneNumber(credentials, "12345")).rejects.toThrow(/six digits/);
  });

  it("subscribes the WABA to the Meta app", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(subscribeWabaToApp(credentials)).resolves.toEqual({ success: true });
    expect(String((fetchMock.mock.calls[0] as [URL])[0])).toContain("/waba-123/subscribed_apps");
  });

  it("sends a text message using the tenant phone-number ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.1" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendTextMessage(credentials, "+255 700 000 000", "Hello")).resolves.toMatchObject({ messages: [{ id: "wamid.1" }] });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/phone-456/messages");
    expect(JSON.parse(String(init.body))).toMatchObject({ messaging_product: "whatsapp", to: "255700000000" });
  });

  it("rejects malformed recipients and empty message bodies", async () => {
    await expect(sendTextMessage(credentials, "123", "Hello")).rejects.toThrow(/E.164/);
    await expect(sendTextMessage(credentials, "+255700000000", "  ")).rejects.toThrow(/1–4096/);
  });

  it("maps Graph API errors without exposing authorization headers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } }), { status: 401 })));
    await expect(getWabaDetails(credentials)).rejects.toMatchObject({ name: "MetaGraphError", status: 401, code: 190 });
  });

  it("validates Embedded Signup webhook challenge with constant-time token comparison", () => {
    const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "expected", "hub.challenge": "challenge-123" });
    expect(verifyWebhookChallenge(params, "expected")).toBe("challenge-123");
    expect(verifyWebhookChallenge(params, "wrong")).toBeNull();
    expect(verifyWebhookChallenge(new URLSearchParams(), "expected")).toBeNull();
  });

  it("verifies Meta webhook signatures over exact raw request bytes", () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account"}');
    const signature = "sha256=" + createHmac("sha256", "app-secret").update(raw).digest("hex");
    expect(verifyWebhookSignature(raw, signature, "app-secret")).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(raw.toString() + " "), signature, "app-secret")).toBe(false);
    expect(verifyWebhookSignature(raw, "sha256=invalid", "app-secret")).toBe(false);
  });
});
