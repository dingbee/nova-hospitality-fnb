/**
 * Regression coverage for the production runtime error observed on
 * /api/public/demo/register and /api/public/demo/resend:
 *   TypeError: Invalid URL
 * Root cause: the Node-runtime adapter's `resolveRequestUrl` built its
 * request base as `${protocol}://${host}` using `host ?? "localhost"`.
 * Nullish coalescing only catches `null`/`undefined` — an *empty-string*
 * `host` header (which this project has observed in production) collapses
 * the base to the literal string `"https://"`, and `new URL()` throws
 * constructing anything against that, which the outer handler then turned
 * into a generic 500 for every register/resend request carrying that
 * header shape.
 *
 * These tests exercise the exported `resolveRequestUrl` directly (the
 * precise unit that broke) and then the full Node-style `handler(request,
 * response)` adapter end to end with exactly the header shape that used to
 * crash it, proving routing/business logic is reached rather than the
 * top-level catch-all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

/** Mimics just enough of Node's IncomingMessage (method/url/headers, plus
 * being an async-iterable of body chunks) for the adapter under test. */
interface FakeNodeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  [Symbol.asyncIterator](): AsyncGenerator<Buffer>;
}

/** Mimics just enough of Node's ServerResponse for the adapter under test. */
interface FakeNodeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(key: string, value: string): void;
  end(payload?: Buffer | string): void;
}

function nodeRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  jsonBody?: unknown;
}): FakeNodeRequest {
  const bodyStr = opts.jsonBody !== undefined ? JSON.stringify(opts.jsonBody) : "";
  const chunks = bodyStr ? [Buffer.from(bodyStr, "utf8")] : [];
  return {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function nodeResponse(): FakeNodeResponse {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      this.body = payload ? payload.toString() : "";
    },
  };
}

describe("resolveRequestUrl", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("passes an already-absolute Web Standard request.url straight through", async () => {
    const { resolveRequestUrl } = await import("./[...path]");
    const url = resolveRequestUrl({ url: "https://lexibite.nolmark.co/api/public/demo/register" });
    expect(url.pathname).toBe("/api/public/demo/register");
  });

  it("resolves a Node-style relative url against a normal host header", async () => {
    const { resolveRequestUrl } = await import("./[...path]");
    const url = resolveRequestUrl({
      url: "/api/public/demo/register",
      headers: { host: "lexibite.nolmark.co", "x-forwarded-proto": "https" },
    });
    expect(url.pathname).toBe("/api/public/demo/register");
  });

  it("never throws when the host header is an empty string (the exact production crash)", async () => {
    const { resolveRequestUrl } = await import("./[...path]");
    expect(() =>
      resolveRequestUrl({
        url: "/api/public/demo/register",
        headers: { host: "", "x-forwarded-proto": "https" },
      }),
    ).not.toThrow();
    const url = resolveRequestUrl({
      url: "/api/public/demo/resend",
      headers: { host: "", "x-forwarded-proto": "https" },
    });
    expect(url.pathname).toBe("/api/public/demo/resend");
  });

  it("never throws when headers are entirely missing", async () => {
    const { resolveRequestUrl } = await import("./[...path]");
    const url = resolveRequestUrl({ url: "/api/public/demo/register" });
    expect(url.pathname).toBe("/api/public/demo/register");
  });
});

describe("POST /api/public/demo/resend via the Node runtime adapter", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("reaches routing and business logic (not the top-level 500) even with an empty host header", async () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");

    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    const { createClient } = await import("@supabase/supabase-js");
    vi.mocked(createClient).mockReturnValue({ from: () => chain } as unknown as ReturnType<
      typeof createClient
    >);

    const { default: handler } = await import("./[...path]");
    const request = nodeRequest({
      method: "POST",
      url: "/api/public/demo/resend",
      headers: { host: "", "x-forwarded-proto": "https", "content-type": "application/json" },
      jsonBody: { workEmail: "guest@example.com" },
    });
    const response = nodeResponse();

    await handler(request, response);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({
      status: "verification_required",
      registrationId: null,
      message: "If that email has a pending demo request, a new link has been sent.",
    });
  });
});
