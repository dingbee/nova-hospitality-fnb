import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ingestMetaWhatsAppWebhook, MetaWebhookSignatureError } from "./webhooks.server";

const appSecret = "test-meta-app-secret";
const binding = {
  id: "binding-1",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  property_id: "22222222-2222-4222-8222-222222222222",
  location_id: "33333333-3333-4333-8333-333333333333",
  integration_id: "44444444-4444-4444-8444-444444444444",
  waba_id: "123456789",
  phone_number_id: "987654321",
  status: "active",
};

function signedBody(body: string) {
  return `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
}

function makeAdmin(
  options: {
    binding?: typeof binding | null;
    integrationStatus?: string;
    insertError?: { code: string } | null;
  } = {},
) {
  const insert = vi.fn().mockResolvedValue({ error: options.insertError ?? null });
  const from = vi.fn((table: string) => {
    if (table === "wa_webhook_events") return { insert };
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue(
        table === "wa_phone_number_bindings"
          ? { data: options.binding === undefined ? binding : options.binding, error: null }
          : {
              data: {
                id: binding.integration_id,
                status: options.integrationStatus ?? "active",
                provider: "meta-whatsapp",
                channel_key: "whatsapp",
                integration_type: "channel",
              },
              error: null,
            },
      ),
    };
    return query;
  });
  return { admin: { from }, insert };
}

const body = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{
      id: binding.waba_id,
      changes: [
        {
      field: "messages",
      value: {
            metadata: { phone_number_id: binding.phone_number_id },
            messages: [
              {
                id: "wamid.1",
                from: "255700000000",
                timestamp: "1794850000",
                type: "text",
                text: { body: "Hello" },
              },
            ],
          },
        },
      ],
    },
  ],
});

describe("Meta WhatsApp webhook durable ingress", () => {
  beforeEach(() => vi.clearAllMocks());

  it("verifies the signature and persists a tenant-resolved inbox event", async () => {
    const { admin, insert } = makeAdmin();
    const result = await ingestMetaWhatsAppWebhook(admin, body, signedBody(body), appSecret);

    expect(result).toEqual({ accepted: 1, duplicates: 0, rejected: 0, ignored: 0 });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        binding_id: binding.id,
        tenant_id: binding.tenant_id,
        property_id: binding.property_id,
        location_id: binding.location_id,
        phone_number_id: binding.phone_number_id,
        status: "pending",
        signature_verified: true,
      }),
    );
  });

  it("quarantines an unmapped receiving number without trusting tenant identifiers", async () => {
    const { admin, insert } = makeAdmin({ binding: null });
    const result = await ingestMetaWhatsAppWebhook(admin, body, signedBody(body), appSecret);

    expect(result).toMatchObject({ accepted: 0, rejected: 1 });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        binding_id: null,
        tenant_id: null,
        property_id: null,
        location_id: null,
        status: "rejected",
      }),
    );
  });

  it("treats an exact provider replay as an idempotent duplicate", async () => {
    const { admin } = makeAdmin({ insertError: { code: "23505" } });
    const result = await ingestMetaWhatsAppWebhook(admin, body, signedBody(body), appSecret);
    expect(result.duplicates).toBe(1);
    expect(result.accepted).toBe(0);
  });

  it("rejects invalid signatures before database access", async () => {
    const { admin, insert } = makeAdmin();
    await expect(
      ingestMetaWhatsAppWebhook(admin, body, "sha256=invalid", appSecret),
    ).rejects.toBeInstanceOf(MetaWebhookSignatureError);
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not resolve a phone number when the integration is disabled", async () => {
    const { admin, insert } = makeAdmin({ integrationStatus: "disabled" });
    const result = await ingestMetaWhatsAppWebhook(admin, body, signedBody(body), appSecret);
    expect(result.rejected).toBe(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ binding_id: null, status: "rejected" }),
    );
  });
});
