import { describe, expect, it } from "vitest";
import { ApiError, toApiErrorBody } from "./errors";

describe("errors — external error envelope", () => {
  it("maps a deliberate ApiError to its declared status/code/message", () => {
    const err = new ApiError("forbidden", 'This credential is not scoped for "orders:write".');
    const { status, body } = toApiErrorBody(err, "req-1");
    expect(status).toBe(403);
    expect(body).toEqual({
      ok: false,
      error: { code: "forbidden", message: err.message, details: undefined },
      requestId: "req-1",
    });
  });

  it("never leaks an unexpected error's message — internal errors are generic", () => {
    const secretLeak = new Error(
      "password=hunter2 at /home/user/nova-hospitality-fnb/secrets.ts:42",
    );
    const { status, body } = toApiErrorBody(secretLeak, "req-2");
    expect(status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("hunter2");
    expect(body.error.message).not.toContain("secrets.ts");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("never leaks a stack trace for an unexpected error", () => {
    let thrown: unknown;
    try {
      throw new Error("boom");
    } catch (err) {
      thrown = err;
    }
    const { body } = toApiErrorBody(thrown, "req-3");
    expect(JSON.stringify(body)).not.toMatch(/at .*:\d+:\d+/);
  });

  it("never leaks a non-Error thrown value (e.g. a raw Postgres error object)", () => {
    const pgLikeError = {
      message: 'duplicate key value violates unique constraint "api_credentials_pkey"',
      code: "23505",
    };
    const { status, body } = toApiErrorBody(pgLikeError, "req-4");
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("23505");
    expect(JSON.stringify(body)).not.toContain("api_credentials_pkey");
  });

  it("preserves safe, deliberate details on a validation_failed ApiError", () => {
    const err = new ApiError("validation_failed", "Request failed validation.", {
      issues: [{ path: "scopes", message: "Required" }],
    });
    const { body } = toApiErrorBody(err, "req-5");
    expect(body.error.details).toEqual({ issues: [{ path: "scopes", message: "Required" }] });
  });

  it.each([
    ["unauthorized", 401],
    ["forbidden", 403],
    ["not_found", 404],
    ["method_not_allowed", 405],
    ["validation_failed", 422],
    ["rate_limited", 429],
    ["quota_exceeded", 429],
    ["idempotency_conflict", 409],
    ["conflict", 409],
    ["not_entitled", 402],
    ["internal_error", 500],
  ] as const)("%s maps to HTTP %i", (code, expectedStatus) => {
    const err = new ApiError(code, "x");
    expect(err.status).toBe(expectedStatus);
  });
});
