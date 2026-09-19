/**
 * P08 — External API error envelope.
 *
 * Every /api/v1/* response, success or failure, is JSON with a stable
 * shape. Errors never carry a stack trace, an internal error message
 * verbatim, or any secret — `ApiError.publicMessage` is the only text that
 * ever reaches the caller; the original `cause` (if any) is for server-side
 * logging only (see audit.server.ts) and is never serialized into a
 * response.
 */

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "validation_failed"
  | "rate_limited"
  | "quota_exceeded"
  | "idempotency_conflict"
  | "conflict"
  | "not_entitled"
  | "internal_error";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  validation_failed: 422,
  rate_limited: 429,
  quota_exceeded: 429,
  idempotency_conflict: 409,
  conflict: 409,
  not_entitled: 402,
  internal_error: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ApiErrorCode, publicMessage: string, details?: Record<string, unknown>) {
    super(publicMessage);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export interface ApiErrorBody {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId: string;
}

/**
 * Maps ANY thrown value to a safe external error body. Never includes the
 * original error's message unless it was already a deliberate ApiError —
 * an unexpected exception (a bug, a DB error) becomes a generic
 * "internal_error" with no detail, so a Postgres constraint name, a file
 * path, or a stack frame can never leak to an external caller.
 */
export function toApiErrorBody(
  err: unknown,
  requestId: string,
): { status: number; body: ApiErrorBody } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: {
        ok: false,
        error: { code: err.code, message: err.message, details: err.details },
        requestId,
      },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      error: { code: "internal_error", message: "An internal error occurred." },
      requestId,
    },
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
