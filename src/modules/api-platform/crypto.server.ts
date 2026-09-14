/**
 * P08 — API Access + Integration Platform: secret handling primitives.
 *
 * Two distinct shapes, deliberately not interchangeable (see
 * standalone/db/migrations/0058_p08_api_integration_platform.sql's header
 * comment, decision #4):
 *
 *  - API credential secrets (issued BY this platform, presented back to it
 *    on every request) are only ever verified, never reconstructed — a
 *    one-way SHA-256 hash is all that is stored.
 *  - Integration/webhook secrets (this platform's own credential to call OUT
 *    to a third party, or a webhook signing secret this platform must sign
 *    outgoing payloads with) must be reversible — AES-256-GCM, encrypted and
 *    decrypted with a server-held key that is never persisted in the
 *    database.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ENCRYPTION_KEY_ENV = "NOVA_API_PLATFORM_ENCRYPTION_KEY";

/** sha256 hex digest — used for API credential secrets (one-way). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time equality for two hex digests of equal expected length. */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export interface GeneratedApiKey {
  /** Stored verbatim, used to find the credential row before hashing. Never secret on its own. */
  prefix: string;
  /** Returned to the caller exactly once. Never stored. */
  secret: string;
  /** The full bearer value the caller presents on every request: `nova_v1_<prefix>_<secret>`. */
  token: string;
  /** sha256 of `secret` — this is what gets persisted. */
  hash: string;
}

/** Generates a new external API credential. 256 bits of entropy in the secret half. */
export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(6).toString("hex"); // 12 hex chars, safe to store/display/index on
  const secret = randomBytes(32).toString("base64url"); // ~256 bits
  const token = `nova_v1_${prefix}_${secret}`;
  return { prefix, secret, token, hash: sha256Hex(secret) };
}

/** Splits a presented bearer token back into its prefix (for the row lookup) and secret (for hash verification). */
export function parseApiKeyToken(token: string): { prefix: string; secret: string } | null {
  const match = /^nova_v1_([0-9a-f]{12})_([A-Za-z0-9_-]{20,80})$/.exec(token.trim());
  if (!match) return null;
  return { prefix: match[1], secret: match[2] };
}

function loadEncryptionKey(): Buffer {
  const raw = process.env[ENCRYPTION_KEY_ENV];
  if (!raw) {
    throw new Error(
      `Missing ${ENCRYPTION_KEY_ENV}. Integration/webhook secrets cannot be stored or read without ` +
        `it configured (32 bytes, base64) — refusing to fall back to plaintext or a derived/default key.`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`${ENCRYPTION_KEY_ENV} must decode to exactly 32 bytes (got ${key.length}).`);
  }
  return key;
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** AES-256-GCM encrypt. Throws (fails closed) if NOVA_API_PLATFORM_ENCRYPTION_KEY is not configured. */
export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = loadEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/** AES-256-GCM decrypt. Throws on a tampered ciphertext (auth tag mismatch) or missing key. */
export function decryptSecret(encrypted: EncryptedSecret): string {
  const key = loadEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** A short, safe-to-display prefix of a secret (e.g. for "whsec_ab12••••" style UI), never the full value. */
export function secretDisplayPrefix(secret: string): string {
  return secret.slice(0, 6);
}
