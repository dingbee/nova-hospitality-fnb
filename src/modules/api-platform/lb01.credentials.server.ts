/**
 * LB-01.03B — LexiBite server-side service credential lifecycle and request gate.
 * Import only from *.server.ts modules or server routes. Raw secrets are
 * returned once at issuance and are never persisted or logged.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  LB01_NONCE_HEADER,
  LB01_SIGNATURE_HEADER,
  LB01_TIMESTAMP_HEADER,
  verifyLb01Request,
} from "./lb01.service-auth";

type SupabaseLike = any;

function parseCredentialToken(token: string): { prefix: string; secret: string } | null {
  const match = /^lb01_v1_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/.exec(token);
  return match ? { prefix: match[1], secret: match[2] } : null;
}

function storedHashBytes(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  const normalized = value.startsWith("\\x") ? value.slice(2) : value;
  if (!/^[a-f0-9]{64}$/.test(normalized)) return null;
  return Buffer.from(normalized, "hex");
}

/** Issues a 256-bit secret once; only its SHA-256 digest is persisted. */
export async function issueLb01ServiceCredential(
  callerClient: SupabaseLike,
  connectionId: string,
  expiresAt: string,
): Promise<{ credentialId: string; token: string; expiresAt: string }> {
  const prefix = randomBytes(12).toString("hex");
  const secretBytes = randomBytes(32);
  const secret = secretBytes.toString("base64url");
  const digest = createHash("sha256").update(secretBytes).digest("hex");
  const { data, error } = await callerClient.rpc("lb01_issue_product_service_credential", {
    _connection_id: connectionId,
    _prefix: prefix,
    _hash: `\\x${digest}`,
    _expires_at: expiresAt,
  });
  if (error || typeof data !== "string") throw new Error("Unable to issue the LB-01 service credential.");
  return { credentialId: data, token: `lb01_v1_${prefix}_${secret}`, expiresAt };
}

export async function revokeLb01ServiceCredential(
  callerClient: SupabaseLike,
  credentialId: string,
  reason: string,
): Promise<boolean> {
  const { data, error } = await callerClient.rpc("lb01_revoke_product_service_credential", {
    _credential_id: credentialId,
    _reason: reason.slice(0, 500),
  });
  if (error) throw new Error("Unable to revoke the LB-01 service credential.");
  return data === true;
}

/** Authenticates, scopes and atomically consumes a signed service nonce. */
export async function authenticateLb01ServiceRequest(
  supabaseAdmin: SupabaseLike,
  request: Request,
): Promise<{ credentialId: string; connection: Record<string, unknown> }> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const parsed = parseCredentialToken(token);
  if (!parsed) throw new Error("Unauthorized LB-01 service request.");

  const { data: credential, error: credentialError } = await supabaseAdmin
    .from("product_service_credentials")
    .select("id, connection_id, credential_hash, status, expires_at")
    .eq("credential_prefix", parsed.prefix)
    .maybeSingle();
  if (credentialError || !credential || credential.status !== "active"
      || new Date(credential.expires_at).getTime() <= Date.now()) {
    throw new Error("Unauthorized LB-01 service request.");
  }

  const secretBytes = Buffer.from(parsed.secret, "base64url");
  if (secretBytes.length !== 32) throw new Error("Unauthorized LB-01 service request.");
  const expected = createHash("sha256").update(secretBytes).digest();
  const stored = storedHashBytes(credential.credential_hash);
  if (!stored || stored.length !== expected.length || !timingSafeEqual(stored, expected)) {
    throw new Error("Unauthorized LB-01 service request.");
  }

  const { data: connection, error: connectionError } = await supabaseAdmin
    .from("staynas_product_connections")
    .select("id, integration_tenant_id, integration_property_id, local_tenant_id, local_property_id, remote_tenant_id, remote_property_id, remote_product, status, correlation_id")
    .eq("id", credential.connection_id)
    .maybeSingle();
  if (connectionError || !connection || !["pending", "active"].includes(connection.status)) {
    throw new Error("Unauthorized LB-01 service request.");
  }

  const timestamp = request.headers.get(LB01_TIMESTAMP_HEADER) ?? "";
  const nonce = request.headers.get(LB01_NONCE_HEADER) ?? "";
  const signature = request.headers.get(LB01_SIGNATURE_HEADER) ?? "";
  const url = new URL(request.url);
  const valid = verifyLb01Request(parsed.secret, {
    method: request.method,
    pathname: url.pathname + url.search,
    rawBody: await request.clone().text(),
    timestamp,
    nonce,
    signature,
  });
  if (!valid) throw new Error("Unauthorized LB-01 service request.");

  const nonceExpiry = new Date(Math.min(Number(timestamp) + 300, Math.floor(Date.now() / 1000) + 300) * 1000).toISOString();
  const { data: claimed, error: nonceError } = await supabaseAdmin.rpc("lb01_claim_service_nonce", {
    _credential_id: credential.id,
    _nonce: nonce,
    _expires_at: nonceExpiry,
  });
  if (nonceError || claimed !== true) throw new Error("Replay or invalid LB-01 service nonce.");

  void supabaseAdmin.from("product_service_credentials")
    .update({ last_used_at: new Date().toISOString() }).eq("id", credential.id);

  return { credentialId: credential.id, connection };
}
