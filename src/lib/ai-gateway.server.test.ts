/* eslint-disable @typescript-eslint/no-explicit-any -- fetch fakes are untyped at this boundary. */
/**
 * Regression coverage for the live INT-01 OpenAI 400:
 * "Response input messages must contain the word 'json' in some form to
 * use 'text.format' of type 'json_object'." — OpenAI validates the literal
 * word "json" against the Responses API's `input` field itself; having it
 * only in `instructions` does not satisfy that check.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callAiGateway } from "./ai-gateway.server";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function fakeFetch(bodies: any[]) {
  return vi.fn(async (_url: string, opts: any) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ output_text: "ok" }) };
  });
}

describe("callAiGateway — Responses API protocol, jsonMode", () => {
  it("the literal word 'json' appears in the `input` field itself, not only in `instructions` — this is what OpenAI actually validates", async () => {
    const bodies: any[] = [];
    global.fetch = fakeFetch(bodies) as any;
    await callAiGateway({
      system: "You are NOVA.",
      user: "What is selling?",
      jsonMode: true,
      protocol: "responses",
      endpoint: {
        url: "https://api.openai.com/v1/responses",
        apiKey: "sk-test",
        model: "gpt-test",
        protocol: "responses",
      },
    });
    const body = bodies[0];
    expect(typeof body.input).toBe("string");
    expect(body.input.toLowerCase()).toContain("json");
    expect(body.text).toEqual({ format: { type: "json_object" } });
  });

  it("with conversation history, the word 'json' appears on the final (user) message inside the `input` array", async () => {
    const bodies: any[] = [];
    global.fetch = fakeFetch(bodies) as any;
    await callAiGateway({
      system: "You are NOVA.",
      user: "What is selling?",
      jsonMode: true,
      history: [{ role: "user", content: "hi" }],
      protocol: "responses",
      endpoint: {
        url: "https://api.openai.com/v1/responses",
        apiKey: "sk-test",
        model: "gpt-test",
        protocol: "responses",
      },
    });
    const body = bodies[0];
    expect(Array.isArray(body.input)).toBe(true);
    const lastMessage = body.input.at(-1);
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content.toLowerCase()).toContain("json");
  });

  it("does not alter the user input when jsonMode is not requested", async () => {
    const bodies: any[] = [];
    global.fetch = fakeFetch(bodies) as any;
    await callAiGateway({
      system: "You are NOVA.",
      user: "What is selling?",
      protocol: "responses",
      endpoint: {
        url: "https://api.openai.com/v1/responses",
        apiKey: "sk-test",
        model: "gpt-test",
        protocol: "responses",
      },
    });
    expect(bodies[0].input).toBe("What is selling?");
    expect(bodies[0].text).toBeUndefined();
  });

  it("chat-completions protocol is unaffected — jsonMode still uses response_format, user content is untouched", async () => {
    const bodies: any[] = [];
    global.fetch = fakeFetch(bodies) as any;
    await callAiGateway({
      system: "You are NOVA.",
      user: "What is selling?",
      jsonMode: true,
      endpoint: {
        url: "https://api.openai.com/v1/chat/completions",
        apiKey: "sk-test",
        model: "gpt-test",
      },
    });
    const body = bodies[0];
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "What is selling?" });
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});
