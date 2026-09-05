/**
 * TRA VFD TEST/sandbox HTTP client — server-only. Makes real HTTP requests
 * to virtual.tra.go.tz. Never simulates a response; every function here
 * either returns what TRA actually sent back or throws a TraProtocolError
 * classified per spec section 20 (configuration/network/timeout/etc).
 *
 * This is the ONLY file in the fiscal module allowed to call fetch() against
 * a TRA endpoint (spec section 28 — TRA protocol I/O stays isolated here).
 */
import {
  TRA_TEST_ENDPOINTS,
  TraProtocolError,
  type TraRegistrationResponse,
  type TraTokenResponse,
  type TraReceiptAck,
  type TraZReportAck,
} from "./traTypes";
import { extractXmlTags } from "./traXml";

const REQUEST_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new TraProtocolError("TRA_TIMEOUT", `TRA request to ${url} timed out.`);
    }
    throw new TraProtocolError(
      "TRA_NETWORK_ERROR",
      `TRA request to ${url} failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

const REGISTRATION_RESPONSE_TAGS = [
  "ACKCODE",
  "ACKMSG",
  "REGID",
  "SERIAL",
  "EFDSERIAL",
  "UIN",
  "TIN",
  "VRN",
  "RECEIPTCODE",
  "TAXOFFICE",
  "REGION",
  "USERNAME",
  "PASSWORD",
  "TOKENPATH",
  "TAXCODE",
] as const;

export async function registerVfd(
  signedXml: string,
  certSerialBase64: string,
): Promise<TraRegistrationResponse> {
  const res = await fetchWithTimeout(TRA_TEST_ENDPOINTS.registration, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      Client: "webapi",
      "Cert-Serial": certSerialBase64,
    },
    body: signedXml,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new TraProtocolError(
      "TRA_REGISTRATION_FAILED",
      `TRA registration returned HTTP ${res.status}.`,
    );
  }
  const fields = extractXmlTags(text, REGISTRATION_RESPONSE_TAGS);
  if (!fields.ACKCODE) {
    throw new TraProtocolError(
      "TRA_INVALID_XML",
      "TRA registration response could not be parsed — no ACKCODE present.",
    );
  }
  return {
    ackCode: fields.ACKCODE,
    ackMessage: fields.ACKMSG ?? "",
    regId: fields.REGID ?? null,
    efdSerial: fields.EFDSERIAL ?? fields.SERIAL ?? null,
    uin: fields.UIN ?? null,
    tin: fields.TIN ?? null,
    vrn: fields.VRN ?? null,
    receiptCode: fields.RECEIPTCODE ?? null,
    taxOffice: fields.TAXOFFICE ?? null,
    region: fields.REGION ?? null,
    username: fields.USERNAME ?? null,
    password: fields.PASSWORD ?? null,
    tokenPath: fields.TOKENPATH ?? null,
    taxCode: fields.TAXCODE ?? null,
    raw: fields,
  };
}

export async function requestAccessToken(
  username: string,
  password: string,
): Promise<TraTokenResponse> {
  const body = new URLSearchParams({
    username,
    password,
    grant_type: "password",
  });
  const res = await fetchWithTimeout(TRA_TEST_ENDPOINTS.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.status === 401 || res.status === 400) {
    throw new TraProtocolError(
      "TRA_AUTHENTICATION_FAILED",
      `TRA token endpoint rejected credentials (HTTP ${res.status}).`,
    );
  }
  if (!res.ok) {
    throw new TraProtocolError(
      "TRA_AUTHENTICATION_FAILED",
      `TRA token endpoint returned HTTP ${res.status}.`,
    );
  }
  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new TraProtocolError(
      "TRA_INVALID_XML",
      "TRA token response could not be parsed as JSON.",
    );
  }
  const accessToken = json.access_token ?? json.accessToken;
  if (!accessToken) {
    throw new TraProtocolError(
      "TRA_AUTHENTICATION_FAILED",
      "TRA token response had no access_token.",
    );
  }
  return {
    accessToken: String(accessToken),
    tokenType: String(json.token_type ?? json.tokenType ?? "bearer"),
    expiresInSeconds: Number(json.expires_in ?? json.expiresIn ?? 3600),
  };
}

const RECEIPT_ACK_TAGS = ["ACKCODE", "ACKMSG", "RCTNUM", "DATE", "TIME"] as const;

export async function submitReceiptXml(
  signedXml: string,
  certSerialBase64: string,
  accessToken: string,
): Promise<TraReceiptAck> {
  const res = await fetchWithTimeout(TRA_TEST_ENDPOINTS.receipt, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      "Routing-Key": "vfdrct",
      "Cert-Serial": certSerialBase64,
      Authorization: `bearer ${accessToken}`,
    },
    body: signedXml,
  });
  if (res.status === 401 || res.status === 403) {
    throw new TraProtocolError(
      "TRA_TOKEN_EXPIRED",
      `TRA rejected the access token submitting a receipt (HTTP ${res.status}).`,
    );
  }
  const text = await res.text();
  const fields = extractXmlTags(text, RECEIPT_ACK_TAGS);
  if (!fields.ACKCODE) {
    throw new TraProtocolError(
      "TRA_INVALID_XML",
      "TRA receipt response could not be parsed — no ACKCODE present.",
    );
  }
  return {
    ackCode: fields.ACKCODE,
    ackMessage: fields.ACKMSG ?? "",
    rctNum: fields.RCTNUM ?? null,
    date: fields.DATE ?? null,
    time: fields.TIME ?? null,
    raw: fields,
  };
}

export async function submitZReportXml(
  signedXml: string,
  certSerialBase64: string,
  accessToken: string,
): Promise<TraZReportAck> {
  const res = await fetchWithTimeout(TRA_TEST_ENDPOINTS.zReport, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      "Routing-Key": "vfdzreport",
      "Cert-Serial": certSerialBase64,
      Authorization: `bearer ${accessToken}`,
    },
    body: signedXml,
  });
  if (res.status === 401 || res.status === 403) {
    throw new TraProtocolError(
      "TRA_TOKEN_EXPIRED",
      `TRA rejected the access token submitting a Z-report (HTTP ${res.status}).`,
    );
  }
  const text = await res.text();
  const fields = extractXmlTags(text, ["ACKCODE", "ACKMSG"] as const);
  if (!fields.ACKCODE) {
    throw new TraProtocolError(
      "TRA_Z_REPORT_FAILED",
      "TRA Z-report response could not be parsed — no ACKCODE present.",
    );
  }
  return { ackCode: fields.ACKCODE, ackMessage: fields.ACKMSG ?? "", raw: fields };
}
