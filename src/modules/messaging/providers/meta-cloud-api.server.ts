import { createHmac, timingSafeEqual } from "node:crypto";

export const META_WHATSAPP_PROVIDER_KEY = "meta-whatsapp";
export const META_WHATSAPP_CHANNEL_KEY = "whatsapp";
export const DEFAULT_META_GRAPH_API_VERSION = "v27.0";

export type MetaPlatformConfig = {
  appId: string;
  appSecret: string;
  graphApiVersion?: string;
};

export type MetaTenantCredentials = {
  accessToken: string;
  wabaId: string;
  phoneNumberId: string;
};

export type MetaGraphErrorInfo = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
  is_transient?: boolean;
};

export class MetaGraphError extends Error {
  readonly status: number | null;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly fbtraceId: string | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    status: number | null,
    code: number | null = null,
    subcode: number | null = null,
    options: {
      fbtraceId?: string | null;
      isTransient?: boolean;
      retryAfterMs?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "MetaGraphError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.fbtraceId = options.fbtraceId ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable =
      status === null ||
      status === 429 ||
      (status !== null && status >= 500) ||
      [4, 17, 32, 613].includes(code ?? -1) ||
      options.isTransient === true;
  }
}

function graphVersion(config?: Pick<MetaPlatformConfig, "graphApiVersion">): string {
  const candidate = config?.graphApiVersion ?? process.env.META_GRAPH_API_VERSION ?? DEFAULT_META_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(candidate)) {
    throw new Error("META_GRAPH_API_VERSION must use the format vNN.NN.");
  }
  return candidate;
}

function required(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is not configured.`);
  return result;
}

function graphUrl(path: string, config?: Pick<MetaPlatformConfig, "graphApiVersion">): URL {
  const cleanPath = path.replace(/^\/+/, "");
  return new URL(`/${graphVersion(config)}/${cleanPath}`, "https://graph.facebook.com");
}

async function readGraphResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const payload =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const error = typeof payload.error === "object" && payload.error !== null
      ? (payload.error as MetaGraphErrorInfo)
    : {};
  if (!response.ok || payload.error) {
    const message =
      typeof error.message === "string"
        ? error.message.slice(0, 500)
        : "Meta Graph API request failed.";
    const retryAfter = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : null;
    throw new MetaGraphError(
      message,
      response.status,
      typeof error.code === "number" ? error.code : null,
      typeof error.error_subcode === "number" ? error.error_subcode : null,
      {
        fbtraceId: typeof error.fbtrace_id === "string" ? error.fbtrace_id : null,
        isTransient: error.is_transient === true,
        retryAfterMs: retryAfterSeconds === null ? null : Math.max(0, Math.round(retryAfterSeconds * 1000)),
      },
    );
  }
  if (body === null) throw new MetaGraphError("Meta Graph API returned an invalid JSON response.", response.status);
  return body as T;
}

async function graphRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  config?: Pick<MetaPlatformConfig, "graphApiVersion">,
): Promise<T> {
  const token = required(accessToken, "Meta access token");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);

  const url = graphUrl(path, config);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MetaGraphError(
      "Meta Graph API request failed due to a network or timeout error.",
      null,
    );
  }
  return readGraphResponse<T>(response);
}

export type MetaTokenExchangeResult = {
  accessToken: string;
  tokenType: string;
  expiresIn: number | null;
};

/**
 * Exchanges the short-lived authorization code returned by Embedded Signup v4.
 * App credentials are accepted only by this server-only module and must never
 * be passed from a browser request or included in logs.
 */
export async function exchangeEmbeddedSignupCode(
  code: string,
  platform: MetaPlatformConfig,
): Promise<MetaTokenExchangeResult> {
  const authorizationCode = required(code, "Embedded Signup authorization code");
  const appId = required(platform.appId, "META_APP_ID");
  const appSecret = required(platform.appSecret, "META_APP_SECRET");
  const url = graphUrl("oauth/access_token", platform);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", authorizationCode);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MetaGraphError(
      "Meta authorization-code exchange failed due to a network or timeout error.",
      null,
    );
  }
  const body = await readGraphResponse<{
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  }>(response);
  if (!body.access_token) throw new MetaGraphError("Meta did not return an access token.", response.status);
  return {
    accessToken: body.access_token,
    tokenType: body.token_type ?? "bearer",
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
  };
}

export type MetaTokenInspection = {
  is_valid: boolean;
  app_id?: string;
  type?: string;
  expires_at?: number;
  scopes?: string[];
  granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
};

/** Inspects a tenant token using Meta's app-scoped debug_token endpoint. */
export async function inspectAccessToken(
  accessToken: string,
  platform: MetaPlatformConfig,
): Promise<MetaTokenInspection> {
  const appId = required(platform.appId, "META_APP_ID");
  const appSecret = required(platform.appSecret, "META_APP_SECRET");
  const url = graphUrl("debug_token", platform);
  url.searchParams.set("input_token", required(accessToken, "Meta access token"));
  url.searchParams.set("access_token", `${appId}|${appSecret}`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MetaGraphError(
      "Meta token inspection failed due to a network or timeout error.",
      null,
    );
  }
  const body = await readGraphResponse<{ data?: MetaTokenInspection }>(response);
  if (!body.data) throw new MetaGraphError("Meta token inspection returned no token data.", response.status);
  return body.data;
}

export function assertRequiredWhatsAppPermissions(token: MetaTokenInspection): void {
  if (!token.is_valid) throw new Error("Meta access token is invalid or expired.");
  const scopes = new Set(token.scopes ?? []);
  const requiredScopes = ["whatsapp_business_management", "whatsapp_business_messaging"];
  const missing = requiredScopes.filter((scope) => !scopes.has(scope));
  if (missing.length) throw new Error(`Meta token is missing required permissions: ${missing.join(", ")}.`);
}

export type MetaWabaDetails = {
  id: string;
  name?: string;
  currency?: string;
  timezone_id?: string;
  status?: string;
};

export async function getWabaDetails(
  credentials: MetaTenantCredentials,
  platform?: Pick<MetaPlatformConfig, "graphApiVersion">,
): Promise<MetaWabaDetails> {
  const id = encodeURIComponent(required(credentials.wabaId, "WABA ID"));
  const query = new URLSearchParams({ fields: "id,name,currency,timezone_id,status" });
  return graphRequest<MetaWabaDetails>(
    `${id}?${query.toString()}`,
    credentials.accessToken,
    {},
    platform,
  );
}

export type MetaPhoneNumber = {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  platform_type?: string;
  status?: string;
};

export async function listWabaPhoneNumbers(
  credentials: MetaTenantCredentials,
  platform?: Pick<MetaPlatformConfig, "graphApiVersion">,
): Promise<MetaPhoneNumber[]> {
  const id = encodeURIComponent(required(credentials.wabaId, "WABA ID"));
  const query = new URLSearchParams({
    fields:
      "id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status",
  });
  const body = await graphRequest<{ data?: MetaPhoneNumber[] }>(
    `${id}/phone_numbers?${query.toString()}`,
    credentials.accessToken,
    {},
    platform,
  );
  return body.data ?? [];
}

export async function registerVerifiedPhoneNumber(
  credentials: MetaTenantCredentials,
  pin: string,
  platform?: Pick<MetaPlatformConfig, "graphApiVersion">,
): Promise<{ success: boolean }> {
  if (!/^\d{6}$/.test(pin)) throw new Error("WhatsApp phone registration PIN must contain exactly six digits.");
  const id = encodeURIComponent(required(credentials.phoneNumberId, "Phone number ID"));
  return graphRequest<{ success: boolean }>(
    `${id}/register`,
    credentials.accessToken,
    {
    method: "POST",
      body: JSON.stringify({ messaging_product: "whatsapp", pin }),
    },
    platform,
  );
}

export async function subscribeWabaToApp(
  credentials: MetaTenantCredentials,
  platform?: Pick<MetaPlatformConfig, "graphApiVersion">,
): Promise<{ success: boolean }> {
  const id = encodeURIComponent(required(credentials.wabaId, "WABA ID"));
  return graphRequest<{ success: boolean }>(
    `${id}/subscribed_apps`,
    credentials.accessToken,
    {
    method: "POST",
      body: JSON.stringify({}),
    },
    platform,
  );
}

export async function checkPhoneNumberHealth(
  credentials: MetaTenantCredentials,
  platform?: Pick<MetaPlatformConfig, "graphApiVersion">,
): Promise<MetaPhoneNumber> {
  const id = encodeURIComponent(required(credentials.phoneNumberId, "Phone number ID"));
  const query = new URLSearchParams({
    fields:
      "id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type",
  });
  return graphRequest<MetaPhoneNumber>(
    `${id}?${query.toString()}`,
    credentials.accessToken,
    {},
    platform,
  );
}

export type MetaSendTextResult = {
  messaging_product: "whatsapp";
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string; message_status?: string }>;
};

export async function sendTextMessage(
  credentials: MetaTenantCredentials,
  recipientE164: string,
  body: string,
  platform?: Pick<MetaPlatformConfig, "graphApiVersion">,
): Promise<MetaSendTextResult> {
  const recipient = recipientE164.replace(/[^\d]/g, "");
  if (!/^\d{8,15}$/.test(recipient)) throw new Error("WhatsApp recipient must be an E.164 phone number.");
  const text = body.trim();
  if (!text || text.length > 4096) throw new Error("WhatsApp text message must contain 1–4096 characters.");
  const id = encodeURIComponent(required(credentials.phoneNumberId, "Phone number ID"));
  return graphRequest<MetaSendTextResult>(
    `${id}/messages`,
    credentials.accessToken,
    {
    method: "POST",
    body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
      to: recipient,
        type: "text",
      text: { preview_url: false, body: text },
      }),
    },
    platform,
  );
}

/** Meta's GET webhook challenge; returns the challenge only for a constant-time token match. */
export function verifyWebhookChallenge(
  params: URLSearchParams,
  expectedVerifyToken: string,
): string | null {
  const mode = params.get("hub.mode");
  const supplied = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge");
  if (mode !== "subscribe" || !challenge || !expectedVerifyToken) return null;
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expectedVerifyToken, "utf8");
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  return challenge;
}

/** Verifies X-Hub-Signature-256 against the exact raw request bytes. */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader) || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const supplied = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
