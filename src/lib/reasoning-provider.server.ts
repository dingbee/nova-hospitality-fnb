// NOVA Hospitality F&B — INT-01 reasoning provider selector.
//
// The Intelligence Reasoning Layer must not contain provider-specific
// logic: it asks for "openai" or "gemini" and gets back either a real
// result or an explicit unavailable state, never a fabricated one.
import {
  callAiGateway,
  type AiGatewayCallOptions,
  type AiGatewayResult,
} from "./ai-gateway.server";

export type ReasoningProviderName = "openai" | "gemini";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const GEMINI_OPENAI_COMPAT_URL =
  process.env["NOVA_GEMINI_GATEWAY_URL"] ??
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_DEFAULT_MODEL = process.env["NOVA_GEMINI_MODEL"] ?? "gemini-2.0-flash";

export type ReasoningProviderResult =
  | (AiGatewayResult & { provider: ReasoningProviderName; unavailable: false })
  | { provider: ReasoningProviderName; unavailable: true; reason: string };

export function isReasoningProviderConfigured(provider: ReasoningProviderName): boolean {
  return provider === "openai"
    ? Boolean(process.env["NOVA_AI_API_KEY"])
    : Boolean(process.env["NOVA_GEMINI_API_KEY"]);
}

/**
 * Calls the named provider using its correct production transport.
 * OpenAI GPT-5.6 reasoning models are routed explicitly to Responses API;
 * existing Staff/Guest NOVA callers continue using the shared Chat
 * Completions default in ai-gateway.server.ts.
 */
export async function callReasoningProvider(
  provider: ReasoningProviderName,
  opts: Omit<AiGatewayCallOptions, "endpoint" | "model"> & { model?: string },
): Promise<ReasoningProviderResult> {
  if (!isReasoningProviderConfigured(provider)) {
    return {
      provider,
      unavailable: true,
      reason:
        provider === "openai"
          ? "OpenAI is not configured for this deployment (missing NOVA_AI_API_KEY)."
          : "Gemini is not configured for this deployment (missing NOVA_GEMINI_API_KEY).",
    };
  }

  try {
    const result =
      provider === "openai"
        ? await callAiGateway({
            ...opts,
            protocol: "responses",
            endpoint: {
              url: OPENAI_RESPONSES_URL,
              apiKey: process.env["NOVA_AI_API_KEY"] as string,
              model: opts.model ?? process.env["NOVA_AI_MODEL"] ?? "gpt-5.6-terra",
              protocol: "responses",
            },
          })
        : await callAiGateway({
            ...opts,
            endpoint: {
              url: GEMINI_OPENAI_COMPAT_URL,
              apiKey: process.env["NOVA_GEMINI_API_KEY"] as string,
              model: opts.model ?? GEMINI_DEFAULT_MODEL,
              protocol: "chat-completions",
            },
          });

    return { ...result, provider, unavailable: false };
  } catch (err) {
    return { provider, unavailable: true, reason: (err as Error).message };
  }
}
