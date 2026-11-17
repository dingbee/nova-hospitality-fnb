import { describe, expect, it, beforeEach } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateApiKey,
  hashesEqual,
  parseApiKeyToken,
  secretDisplayPrefix,
  sha256Hex,
} from "./crypto.server";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("crypto.server — API credential hashing", () => {
  it("generates a token whose secret half hashes to the returned hash", () => {
    const generated = generateApiKey();
    expect(sha256Hex(generated.secret)).toBe(generated.hash);
  });

  it("round-trips through parseApiKeyToken", () => {
    const generated = generateApiKey();
    const parsed = parseApiKeyToken(generated.token);
    expect(parsed).toEqual({ prefix: generated.prefix, secret: generated.secret });
  });

  it("rejects a malformed token instead of throwing", () => {
    expect(parseApiKeyToken("not-a-real-token")).toBeNull();
    expect(parseApiKeyToken("nova_v1_short")).toBeNull();
    expect(parseApiKeyToken("")).toBeNull();
  });

  it("two generated keys never collide", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.token).not.toBe(b.token);
    expect(a.prefix).not.toBe(b.prefix);
    expect(a.hash).not.toBe(b.hash);
  });

  it("hashesEqual is true only for the exact same secret's hash", () => {
    const generated = generateApiKey();
    expect(hashesEqual(sha256Hex(generated.secret), generated.hash)).toBe(true);
    expect(hashesEqual(sha256Hex("wrong-secret"), generated.hash)).toBe(false);
  });

  it("hashesEqual never throws on malformed input (e.g. a forged non-hex string)", () => {
    expect(hashesEqual("not-hex-at-all!!", sha256Hex("x"))).toBe(false);
    expect(hashesEqual("", "")).toBe(true);
  });
});

describe("crypto.server — integration/webhook secret encryption", () => {
  beforeEach(() => {
    process.env.NOVA_API_PLATFORM_ENCRYPTION_KEY = TEST_KEY;
  });

  it("round-trips a secret through encrypt/decrypt", () => {
    const enc = encryptSecret("super-secret-provider-token");
    expect(enc.ciphertext).not.toContain("super-secret-provider-token");
    expect(decryptSecret(enc)).toBe("super-secret-provider-token");
  });

  it("produces different ciphertext for the same plaintext each time (random IV)", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("rejects a tampered ciphertext (auth tag mismatch) instead of returning garbage", () => {
    const enc = encryptSecret("real-secret");
    const tampered = { ...enc, ciphertext: Buffer.from("tampered-bytes-here!").toString("base64") };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("fails closed when the encryption key is not configured", () => {
    delete process.env.NOVA_API_PLATFORM_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/NOVA_API_PLATFORM_ENCRYPTION_KEY/);
  });

  it("fails closed when the encryption key is the wrong length", () => {
    process.env.NOVA_API_PLATFORM_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });

  it("secretDisplayPrefix never returns the full secret", () => {
    const secret = "a-very-long-secret-value-nobody-should-see-in-full";
    const prefix = secretDisplayPrefix(secret);
    expect(prefix.length).toBeLessThan(secret.length);
    expect(secret.startsWith(prefix)).toBe(true);
  });
});
