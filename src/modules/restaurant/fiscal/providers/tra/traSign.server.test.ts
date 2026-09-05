/**
 * Certificate / signing — category A (signature generation, cert serial)
 * plus category H (no secret material anywhere near a thrown error).
 */
import { createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_TRA_CERTIFICATE_PEM, TEST_TRA_PRIVATE_KEY_PEM } from "./__fixtures__/testCert";
import { certificateSerialBase64, signSha1Rsa } from "./traSign.server";

describe("certificateSerialBase64", () => {
  it("extracts the certificate's serial number and base64-encodes it", () => {
    const serial = certificateSerialBase64(TEST_TRA_CERTIFICATE_PEM);
    expect(typeof serial).toBe("string");
    expect(serial.length).toBeGreaterThan(0);
    // A base64 round-trip should decode back to raw bytes without throwing.
    expect(() => Buffer.from(serial, "base64")).not.toThrow();
  });

  it("throws TRA_CERTIFICATE_INVALID for garbage input, never fabricates a serial", () => {
    expect(() => certificateSerialBase64("not a certificate")).toThrow(/certificate/i);
  });
});

describe("signSha1Rsa", () => {
  it("produces a signature the matching public certificate can verify", () => {
    const payload = "<TIN>123-456-789</TIN><CERTKEY>ABC</CERTKEY>";
    const signatureBase64 = signSha1Rsa(payload, TEST_TRA_PRIVATE_KEY_PEM);

    const verifier = createVerify("RSA-SHA1");
    verifier.update(payload, "utf8");
    verifier.end();
    const ok = verifier.verify(TEST_TRA_CERTIFICATE_PEM, Buffer.from(signatureBase64, "base64"));
    expect(ok).toBe(true);
  });

  it("signing the same content twice is deterministic-enough to verify each time (not a fixed stub)", () => {
    const payload = "same content";
    const sigA = signSha1Rsa(payload, TEST_TRA_PRIVATE_KEY_PEM);
    const sigB = signSha1Rsa(payload, TEST_TRA_PRIVATE_KEY_PEM);
    // RSA PKCS1v15 signing is deterministic for a fixed key+message.
    expect(sigA).toBe(sigB);
  });

  it("a different payload produces a signature that fails verification against the first payload", () => {
    const sig = signSha1Rsa("payload A", TEST_TRA_PRIVATE_KEY_PEM);
    const verifier = createVerify("RSA-SHA1");
    verifier.update("payload B (tampered)", "utf8");
    verifier.end();
    expect(verifier.verify(TEST_TRA_CERTIFICATE_PEM, Buffer.from(sig, "base64"))).toBe(false);
  });

  it("a malformed private key throws TRA_SIGNATURE_FAILED, never returns a fabricated signature", () => {
    expect(() => signSha1Rsa("data", "not a key")).toThrow(/sign/i);
  });
});
