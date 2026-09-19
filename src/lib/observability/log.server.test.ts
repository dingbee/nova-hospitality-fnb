import { afterEach, describe, expect, it, vi } from "vitest";
import { logServerDenial, logServerFailure } from "./log.server";

describe("logServerFailure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs at console.error with requestId, timestamp, caller details, and the error object", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("boom");
    logServerFailure("test-scope", "req-1", { fn: "doThing" }, error);

    expect(spy).toHaveBeenCalledTimes(1);
    const [tag, payload, loggedError] = spy.mock.calls[0]!;
    expect(tag).toBe("[test-scope]");
    const parsed = JSON.parse(payload as string);
    expect(parsed.requestId).toBe("req-1");
    expect(parsed.fn).toBe("doThing");
    expect(typeof parsed.timestamp).toBe("string");
    expect(loggedError).toBe(error);
  });

  it("falls back to 'unknown' when no requestId is available, rather than dropping the log", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logServerFailure("test-scope", null, {}, new Error("x"));
    const parsed = JSON.parse(spy.mock.calls[0]![1] as string);
    expect(parsed.requestId).toBe("unknown");
  });
});

describe("logServerDenial", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs at console.warn (not console.error) since a denial is not a bug", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logServerDenial("auth", "req-2", { reason: "missing_authorization_header" });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(warnSpy.mock.calls[0]![1] as string);
    expect(parsed.requestId).toBe("req-2");
    expect(parsed.reason).toBe("missing_authorization_header");
  });
});
