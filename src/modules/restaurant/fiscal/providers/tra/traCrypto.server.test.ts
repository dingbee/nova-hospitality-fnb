/**
 * At-rest credential encryption — category H (client/log secret safety at
 * the storage layer): a stored value is never plaintext, and the key must
 * be configured before any secret can be written at all.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptFiscalSecret,
  encryptFiscalSecret,
  isCredentialStoreConfigured,
} from "./traCrypto.server";

const ORIGINAL_KEY = process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY;

function setKey() {
  process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
}

describe("traCrypto", () => {
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  describe("without a configured key", () => {
    beforeEach(() => {
      delete process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY;
    });

    it("isCredentialStoreConfigured is false", () => {
      expect(isCredentialStoreConfigured()).toBe(false);
    });

    it("never stores a secret without a key — throws instead of falling back to plaintext", () => {
      expect(() => encryptFiscalSecret("super-secret-password")).toThrow(
        /FISCAL_CREDENTIAL_ENCRYPTION_KEY/,
      );
    });
  });

  describe("with a configured key", () => {
    beforeEach(setKey);

    it("isCredentialStoreConfigured is true", () => {
      expect(isCredentialStoreConfigured()).toBe(true);
    });

    it("round-trips a secret exactly", () => {
      const secret = "tra-password-Aa1!2345";
      const encrypted = encryptFiscalSecret(secret);
      expect(decryptFiscalSecret(encrypted)).toBe(secret);
    });

    it("the encrypted form never contains the plaintext substring", () => {
      const secret = "MyVeryUniqueMarkerString12345";
      const encrypted = encryptFiscalSecret(secret);
      expect(encrypted).not.toContain(secret);
    });

    it("two encryptions of the same secret produce different ciphertext (random IV) — never a fixed, guessable blob", () => {
      const a = encryptFiscalSecret("same-secret");
      const b = encryptFiscalSecret("same-secret");
      expect(a).not.toBe(b);
      expect(decryptFiscalSecret(a)).toBe("same-secret");
      expect(decryptFiscalSecret(b)).toBe("same-secret");
    });

    it("tampering with the ciphertext fails decryption (GCM auth tag) rather than silently returning garbage", () => {
      const encrypted = encryptFiscalSecret("integrity-check");
      const buf = Buffer.from(encrypted, "base64");
      buf[buf.length - 1] ^= 0xff; // flip a byte in the ciphertext
      expect(() => decryptFiscalSecret(buf.toString("base64"))).toThrow();
    });
  });

  it("a key that isn't exactly 32 bytes is rejected, never silently truncated/padded", () => {
    process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
    expect(() => encryptFiscalSecret("x")).toThrow(/32 bytes/);
  });
});
