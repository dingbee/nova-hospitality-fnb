// NOVA Hospitality F&B — server-side AI transport.
//
// Advisory intelligence is optional and WAN-dependent: an appliance with no
// gateway configured simply reports the capability as unavailable. The
// endpoint and model are deployment configuration, never product identity —
// any OpenAI-compatible chat-completions endpoint works.

export const AI_GATEWAY_URL =
  process.env["NOVA_AI_GATEWAY_URL"] ?? "https://api.openai.com/v1/chat/completions";
export const AI_GATEWAY_DEFAULT_MODEL = process.env["NOVA_AI_MODEL"] ?? "gpt-4o-mini";

export interface AiGatewayCallOptions {
  system: string;
  user: string;
  jsonMode?: boolean;
  model?: string;
  /** Extra chat messages inserted between system and final user message. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * INT-01 — overrides the destination endpoint/credential/model for this one
   * call, without touching the NOVA_AI_* defaults every existing caller
   * (Staff Ask NOVA, Guest Ask NOVA, decision narration) relies on. Absent =
   * unchanged behavior. This is the seam reasoning-provider.server.ts uses to
   * route the exact same call shape at a second (challenger) provider — the
   * gateway itself stays vendor-agnostic, since any OpenAI-compatible
   * chat-completions endpoint works (see file header).
   */
  endpoint?: { url: string; apiKey: string; model: string };
  /** Defaults to 20s — every existing caller already tolerates the network's own timeout; this bounds it explicitly instead of hanging indefinitely on a stalled provider. */
  timeoutMs?: number;
}

export interface AiGatewayResult {
  content: string;
  latencyMs: number;
  model: string;
  /** Present only when the provider's response includes a `usage` block (both OpenAI and Gemini's OpenAI-compat endpoint do). */
  inputTokens?: number;
  outputTokens?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Call the configured AI gateway. Throws user-facing errors for 429/402/
 * timeout and a short diagnostic error otherwise. Never leaks the API key.
 */
export async function callAiGateway(opts: AiGatewayCallOptions): Promise<AiGatewayResult> {
  const url = opts.endpoint?.url ?? AI_GATEWAY_URL;
  const key = opts.endpoint?.apiKey ?? process.env["NOVA_AI_API_KEY"];
  if (!key)
    throw new Error("AI advisory is not configured for this deployment (missing NOVA_AI_API_KEY).");
  const model = opts.model ?? opts.endpoint?.model ?? AI_GATEWAY_DEFAULT_MODEL;
  const messages = [
    { role: "system" as const, content: opts.system },
    ...(opts.history ?? []),
    { role: "user" as const, content: opts.user },
  ];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages,
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`AI request timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("AI rate limit reached. Try again in a moment.");
    if (res.status === 402)
      throw new Error("AI credits exhausted. Please top up in workspace settings.");
    throw new Error(`AI request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    latencyMs,
    model,
    inputTokens: json.usage?.prompt_tokens,
    outputTokens: json.usage?.completion_tokens,
  };
}

/**
 * Best-effort JSON extraction — tolerates code fences and leading/trailing
 * narration around a JSON object. Returns `null` when nothing parses.
 */
export function parseAiJson<T = unknown>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    /* fallthrough */
  }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      /* ignore */
    }
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1)) as T;
    } catch {
      /* ignore */
    }
  }
  return null;
}
