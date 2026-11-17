/**
 * At-rest encryption for TRA-issued credentials (username/password, access
 * token) persisted in restaurant_fiscal_credentials. Server-only; the key
 * lives in an env var and is never sent to the client, logged, or returned
 * from any server function (spec sections 4/15/21).
 *
 * AES-256-GCM via Node's built-in crypto — no new dependency. The key is
 * FISCAL_CREDENTIAL_ENCRYPTION_KEY, 32 bytes, base64-encoded.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TraProtocolError } from "./traTypes";

function loadKey(): Buffer {
  const raw = process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new TraProtocolError(
      "TRA_CONFIGURATION_REQUIRED",
      "FISCAL_CREDENTIAL_ENCRYPTION_KEY is not configured — TRA credentials cannot be stored safely.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new TraProtocolError(
      "TRA_CONFIGURATION_REQUIRED",
      "FISCAL_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).",
    );
  }
  return key;
}

/** Returns base64(iv[12] || authTag[16] || ciphertext). */
export function encryptFiscalSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptFiscalSecret(encoded: string): string {
  const key = loadKey();
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** True only when the encryption key itself is configured — never checks DB state. */
export function isCredentialStoreConfigured(): boolean {
  const raw = process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) return false;
  try {
    return Buffer.from(raw, "base64").length === 32;
  } catch {
    return false;
  }
}
