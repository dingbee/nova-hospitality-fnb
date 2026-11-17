/**
 * Reproduces the ME-16 ME16-03 finding directly: a raw JSON-parser
 * exception (`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
 * captured live from a failed sign-in against an unreachable auth backend)
 * must never reach the user; a normal, already-safe rejection must be
 * shown unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { presentUserFacingError } from "./present-error";

describe("presentUserFacingError", () => {
  afterEach(() => vi.restoreAllMocks());

  it("replaces a raw JSON-parser error with the safe fallback message", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = new Error(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);
    const presented = presentUserFacingError(raw, "Sign-in failed.");
    expect(presented.message.startsWith("Sign-in failed.")).toBe(true);
    expect(presented.message).not.toContain("Unexpected token");
    expect(presented.message).not.toContain("<!DOCTYPE");
  });

  it("passes through a normal, short, human-authored rejection unchanged (aside from the reference suffix)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const authError = new Error("Invalid login credentials");
    const presented = presentUserFacingError(authError, "Sign-in failed.");
    expect(presented.message.startsWith("Invalid login credentials")).toBe(true);
  });

  it("passes through the app's own Unauthorized:-prefixed messages unchanged", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const presented = presentUserFacingError(new Error("Unauthorized: Invalid token"));
    expect(presented.message.startsWith("Unauthorized: Invalid token")).toBe(true);
  });

  it("replaces a stack-trace-shaped message and a message over the safe length ceiling", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stackShaped = new Error("boom\n    at Object.<anonymous> (/app/src/foo.ts:12:34)");
    expect(presentUserFacingError(stackShaped, "Fallback.").message.startsWith("Fallback.")).toBe(
      true,
    );

    const tooLong = new Error("x".repeat(500));
    expect(presentUserFacingError(tooLong, "Fallback.").message.startsWith("Fallback.")).toBe(true);
  });

  it("always includes a reference id, reusing error.requestId when the server attached one", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const withRequestId = Object.assign(new Error("failed"), { requestId: "known-request-id" });
    const presented = presentUserFacingError(withRequestId);
    expect(presented.requestId).toBe("known-request-id");
    expect(presented.message).toContain("Reference: known-request-id");
  });

  it("logs the original error to the console for local devtools inspection", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("original");
    presentUserFacingError(err);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("reference="), err);
  });
});
