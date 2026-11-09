/**
 * LB-01 outbound approval transport.
 * Caller must resolve the peer credential and endpoint from trusted,
 * connection-scoped server-side storage. Never pass client-supplied URLs or
 * credentials into this module. Requests are signed and never auto-retried.
 */
import { randomBytes } from "node:crypto";
import { signLb01Request } from "./lb01.service-auth";

const APPROVAL_PATH = "/api/integrations/lb01/approval";

export interface Lb01PeerTarget {
  endpointUrl: string;
  credentialToken: string;
}

export interface Lb01ApprovalResult {
  accepted: true;
  status: "pending" | "active";
  correlationId: string;
}

function parsePeerCredential(token: string): string {
  const match = /^lb01_v1_[a-f0-9]{24}_([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) throw new Error("Invalid LB-01 peer credential.");
  return match[1];
}

function approvalUrl(endpointUrl: string): URL {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash
      || url.pathname !== APPROVAL_PATH) {
    throw new Error("LB-01 peer endpoint must be a trusted HTTPS approval endpoint.");
  }
  return url;
}

/**
 * Send one signed approval request. The receiver's durable nonce ledger makes
 * retries with a fresh nonce safe; this adapter deliberately does not retry
 * automatically because transport failures can occur after receiver commit.
 */
export async function sendLb01Approval(
  target: Lb01PeerTarget,
  correlationId: string,
  fetcher: typeof fetch = fetch,
): Promise<Lb01ApprovalResult> {
  if (typeof correlationId !== "string" || correlationId.length < 8 || correlationId.length > 128) {
    throw new Error("Invalid LB-01 approval correlation ID.");
  }
  const url = approvalUrl(target.endpointUrl);
  const secret = parsePeerCredential(target.credentialToken);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(24).toString("base64url");
  const rawBody = JSON.stringify({ correlationId });
  const signature = signLb01Request(secret, {
    method: "POST",
    pathname: url.pathname + url.search,
    rawBody,
    timestamp,
    nonce,
  });

  const response = await fetcher(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Bearer ${target.credentialToken}`,
      "content-type": "application/json",
      "x-lb01-timestamp": timestamp,
      "x-lb01-nonce": nonce,
      "x-lb01-signature": signature,
    },
    body: rawBody,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`LB-01 peer approval failed with HTTP ${response.status}.`);
  }
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") throw new Error("Invalid LB-01 peer response.");
  const result = payload as Record<string, unknown>;
  if (result.accepted !== true || result.correlationId !== correlationId
      || (result.status !== "pending" && result.status !== "active")) {
    throw new Error("LB-01 peer did not confirm the requested approval.");
  }
  return {
    accepted: true,
    status: result.status as "pending" | "active",
    correlationId,
  };
}
