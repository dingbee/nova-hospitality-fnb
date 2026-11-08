/**
 * LB-01.03 — signed server-to-server request authentication primitives.
 *
 * Pure protocol code: no database access, secret retrieval, logging or HTTP
 * routing. Callers must load a connection-bound secret server-side and must
 * atomically claim the nonce in durable storage before processing the request.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const LB01_MAX_CLOCK_SKEW_SECONDS = 300;
export const LB01_SIGNATURE_HEADER = "x-lb01-signature";
export const LB01_TIMESTAMP_HEADER = "x-lb01-timestamp";
export const LB01_NONCE_HEADER = "x-lb01-nonce";

export interface Lb01SignedRequest {
  method: string;
  pathname: string;
  rawBody: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

function decodeSecret(secretBase64Url: string): Buffer | null {
  try {
    const secret = Buffer.from(secretBase64Url, "base64url");
    return secret.length === 32 ? secret : null;
  } catch {
    return null;
  }
}

function canonicalRequest(input: Pick<Lb01SignedRequest, "method" | "pathname" | "rawBody" | "timestamp" | "nonce">): string {
  const bodyDigest = createHash("sha256").update(input.rawBody, "utf8").digest("hex");
  return ["LB01-HMAC-SHA256-V1", input.timestamp, input.nonce, input.method.toUpperCase(), input.pathname, bodyDigest].join("\\n");
}

export function signLb01Request(
  secretBase64Url: string,
  input: Omit<Lb01SignedRequest, "signature">,
): string {
  const secret = decodeSecret(secretBase64Url);
  if (!secret) throw new Error("LB-01 service secret must decode to exactly 32 bytes.");
  return `v1=${createHmac("sha256", secret).update(canonicalRequest(input), "utf8").digest("hex")}`;
}

/**
 * Verifies authenticity and freshness only. A successful result is NOT
 * replay-safe until the caller atomically inserts (credential_id, nonce)
 * into its durable nonce ledger under a unique constraint.
 */
export function verifyLb01Request(
  secretBase64Url: string,
  input: Lb01SignedRequest,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const secret = decodeSecret(secretBase64Url);
  if (!secret || !Number.isSafeInteger(nowSeconds)) return false;
  if (!/^[0-9]{10}$/.test(input.timestamp)) return false;
  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > LB01_MAX_CLOCK_SKEW_SECONDS) return false;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.nonce)) return false;
  if (!/^[A-Z]{3,10}$/.test(input.method.toUpperCase())) return false;
  if (!input.pathname.startsWith("/") || input.pathname.includes("\\n")) return false;
  const match = /^v1=([a-f0-9]{64})$/.exec(input.signature);
  if (!match) return false;

  const expected = createHmac("sha256", secret).update(canonicalRequest(input), "utf8").digest();
  const presented = Buffer.from(match[1], "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
