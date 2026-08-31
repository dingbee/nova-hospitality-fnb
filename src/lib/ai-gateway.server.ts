// NOVA Hospitality F&B — server-side AI transport.
// Existing Staff/Guest NOVA callers use Chat Completions; INT-01 reasoning
// can explicitly opt into the OpenAI Responses API without changing them.

export const AI_GATEWAY_URL =
  process.env["NOVA_AI_GATEWAY_URL"] ?? "https://api.openai.com/v1/chat/completions";
export const AI_GATEWAY_DEFAULT_MODEL = process.env["NOVA_AI_MODEL"] ?? "gpt-5.6-terra";

export interface AiGatewayCallOptions {
  system: string;
  user: string;
  jsonMode?: boolean;
  model?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  endpoint?: { url: string; apiKey: string; model: string; protocol?: "responses" | "chat-completions" };
  protocol?: "responses" | "chat-completions";
  timeoutMs?: number;
}

export interface AiGatewayResult {
  content: string;
  latencyMs: number;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function extractResponsesText(json: unknown): string {
  const body = json as { output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
  if (typeof body.output_text === "string") return body.output_text;
  for (const item of body.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

export async function callAiGateway(opts: AiGatewayCallOptions): Promise<AiGatewayResult> {
  const url = opts.endpoint?.url ?? AI_GATEWAY_URL;
  const key = opts.endpoint?.apiKey ?? process.env["NOVA_AI_API_KEY"];
  if (!key) throw new Error("AI advisory is not configured for this deployment (missing NOVA_AI_API_KEY).");

  const model = opts.model ?? opts.endpoint?.model ?? AI_GATEWAY_DEFAULT_MODEL;
  const protocol = opts.protocol ?? opts.endpoint?.protocol ?? "chat-completions";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  let res: Response;

  try {
    const body = protocol === "responses"
      ? {
          model,
          instructions: opts.system,
          input: opts.history?.length
            ? [...opts.history.map((message) => ({ role: message.role, content: message.content })), { role: "user", content: opts.user }]
            : opts.user,
          ...(opts.jsonMode ? { text: { format: { type: "json_object" } } } : {}),
        }
      : {
          model,
          messages: [{ role: "system", content: opts.system }, ...(opts.history ?? []), { role: "user", content: opts.user }],
          ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
        };

    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error(`AI request timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) throw new Error("AI authentication failed. Check NOVA_AI_API_KEY.");
    if (res.status === 429) throw new Error("AI rate limit reached. Try again in a moment.");
    if (res.status === 402) throw new Error("AI credits exhausted. Please top up in workspace settings.");
    throw new Error(`AI request failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }>; output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>; usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } };
  return {
    content: protocol === "responses" ? extractResponsesText(json) : (json.choices?.[0]?.message?.content ?? ""),
    latencyMs,
    model,
    inputTokens: json.usage?.input_tokens ?? json.usage?.prompt_tokens,
    outputTokens: json.usage?.output_tokens ?? json.usage?.completion_tokens,
  };
}

export function parseAiJson<T = unknown>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { /* fallthrough */ }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) { try { return JSON.parse(fenced[1]) as T; } catch { /* ignore */ } }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) { try { return JSON.parse(s.slice(start, end + 1)) as T; } catch { /* ignore */ } }
  return null;
}
