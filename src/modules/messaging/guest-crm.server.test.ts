import { describe, expect, it } from "vitest";
import {
  detectGuestLanguage,
  normalizeWhatsAppPhone,
  parseWhatsAppConsentCommand,
} from "./guest-crm.server";

describe("WhatsApp guest CRM identity and consent language", () => {
  it("normalizes a provider sender ID to E.164 without trusting formatted input", () => {
    expect(normalizeWhatsAppPhone("255 712-345-678")).toEqual({
      phoneE164: "+255712345678",
      whatsappUserId: "255712345678",
    });
    expect(() => normalizeWhatsAppPhone("abc")).toThrow();
  });

  it("detects Swahili and defaults safely to English", () => {
    expect(detectGuestLanguage("Habari, naomba menu tafadhali")).toBe("sw");
    expect(detectGuestLanguage("Please show me the menu")).toBe("en");
  });

  it("requires an explicit consent keyword and distinguishes opt-in from opt-out", () => {
    expect(parseWhatsAppConsentCommand("JOIN")).toBe("subscribe");
    expect(parseWhatsAppConsentCommand("START")).toBe("subscribe");
    expect(parseWhatsAppConsentCommand("STOP")).toBe("unsubscribe");
    expect(parseWhatsAppConsentCommand("I like your food")).toBeNull();
  });
});
