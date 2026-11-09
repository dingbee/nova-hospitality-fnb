import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLb01HandoffCode,
  decryptLb01PeerCredential,
  encryptLb01PeerCredential,
  hashLb01HandoffCode,
  validateLb01PeerBaseUrl,
} from "./lb01.handoff.server";

const token = "lb01_v1_0123456789abcdef01234567_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789abcdefghi";

describe("LB-01 encrypted peer credential handoff", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("encrypts and decrypts a credential with connection-bound AES-GCM AAD", () => {
    vi.stubEnv("LB01_PEER_CREDENTIAL_ENCRYPTION_KEY", "a".repeat(64));
    const encrypted = encryptLb01PeerCredential(token, "10000000-0000-4000-8000-000000000001", "lexibite");
    expect(encrypted.prefix).toBe("0123456789abcdef01234567");
    expect(decryptLb01PeerCredential({
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      connectionId: "10000000-0000-4000-8000-000000000001",
      peerProduct: "lexibite",
    })).toBe(token);
  });

  it("rejects credential ciphertext moved to another connection or peer", () => {
    vi.stubEnv("LB01_PEER_CREDENTIAL_ENCRYPTION_KEY", "a".repeat(64));
    const encrypted = encryptLb01PeerCredential(token, "10000000-0000-4000-8000-000000000001", "lexibite");
    expect(() => decryptLb01PeerCredential({
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      connectionId: "20000000-0000-4000-8000-000000000002",
      peerProduct: "lexibite",
    })).toThrow();
  });

  it("requires a 256-bit encryption key and a valid credential token", () => {
    vi.stubEnv("LB01_PEER_CREDENTIAL_ENCRYPTION_KEY", "short");
    expect(() => encryptLb01PeerCredential(token, "10000000-0000-4000-8000-000000000001", "lexibite")).toThrow();
    vi.stubEnv("LB01_PEER_CREDENTIAL_ENCRYPTION_KEY", "a".repeat(64));
    expect(() => encryptLb01PeerCredential("invalid", "10000000-0000-4000-8000-000000000001", "lexibite")).toThrow();
  });

  it("generates a high-entropy, hashable handoff code", () => {
    const code = createLb01HandoffCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashLb01HandoffCode(code)).toMatch(/^\\x[a-f0-9]{64}$/);
    expect(() => hashLb01HandoffCode("short")).toThrow();
  });

  it("accepts only a trusted HTTPS peer origin", () => {
    vi.stubEnv("LB01_PEER_BASE_URL", "https://lexibite.example");
    expect(validateLb01PeerBaseUrl().origin).toBe("https://lexibite.example");
    vi.stubEnv("LB01_PEER_BASE_URL", "http://localhost:3000");
    expect(() => validateLb01PeerBaseUrl()).toThrow();
  });
});
