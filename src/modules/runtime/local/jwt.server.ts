/**
 * Local authentication — ES256 JWT issuance & verification
 * (PRODUCTIZATION-3, Phase 4).
 *
 * ES256 (not HS256) is deliberate: PostgREST verifies tokens against a public
 * JWKS, so the signing key never leaves the local auth issuer. Browser
 * terminals and the application runtime can verify without holding a secret.
 *
 * The claim shape is deliberately identical to the hosted deployment so the
 * existing middleware contract, RLS policies and auth.uid() shim are unchanged.
 */
import { createPrivateKey, createPublicKey, createSign, createVerify, randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";

export interface NovaClaims {
  sub: string;
  email?: string;
  role: "authenticated" | "anon" | "service_role";
  /** Tenant the session is scoped to (property/tenant isolation). */
  tenant_id?: string;
  session_id?: string;
  aud: string;
  iss: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export const NOVA_JWT_ISSUER = "nova-local-auth";
export const NOVA_JWT_AUDIENCE = "nova-local";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** DER (ASN.1) ECDSA signature -> raw r||s of 64 bytes (JOSE format). */
function derToJose(der: Buffer): Buffer {
  let offset = 2;
  if (der[1]! & 0x80) offset += der[1]! & 0x7f;
  const readInt = () => {
    offset += 1; // 0x02
    const len = der[offset]!;
    offset += 1;
    let value = der.subarray(offset, offset + len);
    offset += len;
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - value.length, 0), value]);
  };
  return Buffer.concat([readInt(), readInt()]);
}

function joseToDer(sig: Buffer): Buffer {
  const trim = (b: Buffer) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const out = b.subarray(i);
    return out[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), out]) : out;
  };
  const r = trim(sig.subarray(0, 32));
  const s = trim(sig.subarray(32, 64));
  const body = Buffer.concat([
    Buffer.from([0x02, r.length]),
    r,
    Buffer.from([0x02, s.length]),
    s,
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

export function loadPrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem);
}

export function publicJwkFromPrivate(pem: string, kid: string) {
  const jwk = createPublicKey(createPrivateKey(pem)).export({ format: "jwk" }) as Record<string, string>;
  return { ...jwk, kid, alg: "ES256", use: "sig" };
}

export interface IssueOptions {
  privateKeyPem: string;
  kid: string;
  userId: string;
  email?: string;
  tenantId?: string;
  sessionId?: string;
  role?: NovaClaims["role"];
  ttlSeconds: number;
  now?: number;
}

export function issueAccessToken(options: IssueOptions): { token: string; claims: NovaClaims } {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const claims: NovaClaims = {
    sub: options.userId,
    role: options.role ?? "authenticated",
    aud: NOVA_JWT_AUDIENCE,
    iss: NOVA_JWT_ISSUER,
    iat: now,
    exp: now + options.ttlSeconds,
    jti: randomUUID(),
    ...(options.email ? { email: options.email } : {}),
    ...(options.tenantId ? { tenant_id: options.tenantId } : {}),
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
  };

  const header = { alg: "ES256", typ: "JWT", kid: options.kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  const der = signer.sign(createPrivateKey(options.privateKeyPem));
  return { token: `${signingInput}.${b64url(derToJose(der))}`, claims };
}

export type VerifyResult =
  | { valid: true; claims: NovaClaims }
  | { valid: false; reason: "malformed" | "bad-signature" | "expired" | "wrong-issuer" };

export function verifyAccessToken(
  token: string,
  publicKeyPem: string,
  now: number = Date.now(),
): VerifyResult {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) return { valid: false, reason: "malformed" };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let claims: NovaClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as NovaClaims;
  } catch {
    return { valid: false, reason: "malformed" };
  }

  let ok = false;
  try {
    const verifier = createVerify("SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    ok = verifier.verify(createPublicKey(publicKeyPem), joseToDer(Buffer.from(signatureB64, "base64url")));
  } catch {
    return { valid: false, reason: "bad-signature" };
  }
  if (!ok) return { valid: false, reason: "bad-signature" };

  if (claims.iss !== NOVA_JWT_ISSUER) return { valid: false, reason: "wrong-issuer" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, claims };
}