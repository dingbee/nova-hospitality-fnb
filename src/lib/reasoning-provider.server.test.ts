/* eslint-disable @typescript-eslint/no-explicit-any -- fetch/response fakes are untyped at this boundary. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callReasoningProvider, isReasoningProviderConfigured } from "./reasoning-provider.server";

const originalFetch = global.fetch;

afterEach(() => {
  vi.unstubAllEnvs();
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("isReasoningProviderConfigured", () => {
  it("openai requires NOVA_AI_API_KEY", () => {
    vi.stubEnv("NOVA_AI_API_KEY", "");
    expect(isReasoningProviderConfigured("openai")).toBe(false);
    vi.stubEnv("NOVA_AI_API_KEY", "sk-test");
    expect(isReasoningProviderConfigured("openai")).toBe(true);
  });

  it("gemini requires NOVA_GEMINI_API_KEY — entirely independent of the OpenAI key", () => {
    vi.stubEnv("NOVA_AI_API_KEY", "sk-test");
    vi.stubEnv("NOVA_GEMINI_API_KEY", "");
    expect(isReasoningProviderConfigured("gemini")).toBe(false);
    vi.stubEnv("NOVA_GEMINI_API_KEY", "g-test");
    expect(isReasoningProviderConfigured("gemini")).toBe(true);
  });
});

describe("callReasoningProvider", () => {
  it("never fabricates a result — an unconfigured provider returns unavailable immediately, no fetch attempted", async () => {
    vi.stubEnv("NOVA_GEMINI_API_KEY", "");
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const result = await callReasoningProvider("gemini", { system: "s", user: "u" });
    expect(result.unavailable).toBe(true);
    if (result.unavailable) {
      expect(result.reason).toMatch(/not configured/i);
      // The reason names the env var to set, but never a key value.
      expect(result.reason).not.toMatch(/[a-zA-Z0-9]{16,}/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("openai provider calls the default gateway and returns a real result shape, including token usage when the provider reports it", async () => {
    vi.stubEnv("NOVA_AI_API_KEY", "sk-test");
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    })) as any;
    const result = await callReasoningProvider("openai", { system: "s", user: "u" });
    expect(result.unavailable).toBe(false);
    if (!result.unavailable) {
      expect(result.content).toBe("hello");
      expect(result.provider).toBe("openai");
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(5);
      expect(typeof result.latencyMs).toBe("number");
    }
  });

  it("gemini provider routes through the exact same gateway call shape, at Gemini's OpenAI-compatible endpoint and model", async () => {
    vi.stubEnv("NOVA_GEMINI_API_KEY", "g-test");
    let capturedUrl = "";
    let capturedAuth = "";
    let capturedModel = "";
    global.fetch = vi.fn(async (url: string, opts: any) => {
      capturedUrl = url;
      capturedAuth = opts.headers.Authorization;
      capturedModel = JSON.parse(opts.body).model;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "gemini says hi" } }] }),
      };
    }) as any;
    const result = await callReasoningProvider("gemini", { system: "s", user: "u" });
    expect(result.unavailable).toBe(false);
    expect(capturedUrl).toContain("generativelanguage.googleapis.com");
    expect(capturedAuth).toBe("Bearer g-test");
    expect(capturedModel).toMatch(/gemini/i);
  });

  it("degrades gracefully (never throws) when the provider's HTTP call fails", async () => {
    vi.stubEnv("NOVA_AI_API_KEY", "sk-test");
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })) as any;
    const result = await callReasoningProvider("openai", { system: "s", user: "u" });
    expect(result.unavailable).toBe(true);
  });

  it("times out rather than hanging indefinitely on a stalled provider", async () => {
    vi.stubEnv("NOVA_AI_API_KEY", "sk-test");
    global.fetch = vi.fn(
      (_url: string, opts: any) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    ) as any;
    const result = await callReasoningProvider("openai", { system: "s", user: "u", timeoutMs: 5 });
    expect(result.unavailable).toBe(true);
    if (result.unavailable) expect(result.reason).toMatch(/timed out/i);
  });

  it("the same normalized call shape (system/user/jsonMode) reaches both providers — the reasoning layer never branches on vendor", async () => {
    vi.stubEnv("NOVA_AI_API_KEY", "sk-openai");
    vi.stubEnv("NOVA_GEMINI_API_KEY", "sk-gemini");
    const bodies: any[] = [];
    global.fetch = vi.fn(async (_url: string, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }) as any;
    const opts = { system: "SYS", user: "USER", jsonMode: true };
    await callReasoningProvider("openai", opts);
    await callReasoningProvider("gemini", opts);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.messages[0]).toEqual({ role: "system", content: "SYS" });
      expect(body.messages.at(-1)).toEqual({ role: "user", content: "USER" });
      expect(body.response_format).toEqual({ type: "json_object" });
    }
  });
});
