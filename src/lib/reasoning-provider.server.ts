// NOVA Hospitality F&B — INT-01 reasoning provider selector.
//
// The Intelligence Reasoning Layer must not contain provider-specific
// logic: it asks for "openai" or "gemini" and gets back either a real
// result or an explicit unavailable state, never a fabricated one.
// Both providers speak through the exact same ai-gateway.server.ts —
// Gemini exposes an OpenAI-compatible chat-completions endpoint
// (https://ai.google.dev/gemini-api/docs/openai), so no second HTTP
// client, SDK, or parsing path is needed. Provider selection is entirely
// configuration-driven (env vars), matching the existing NOVA_AI_* pattern.
import {
  callAiGateway,
  type AiGatewayCallOptions,
  type AiGatewayResult,
} from "./ai-gateway.server";

export type ReasoningProviderName = "openai" | "gemini";

const OPENAI_PROVIDERS: ReadonlySet<ReasoningProviderName> = new Set(["openai"]);

const GEMINI_OPENAI_COMPAT_URL =
  process.env["NOVA_GEMINI_GATEWAY_URL"] ??
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
/**
 * Fallback only — overridable via NOVA_GEMINI_MODEL, exactly like OpenAI's
 * AI_GATEWAY_DEFAULT_MODEL falls back to "gpt-4o-mini" in ai-gateway.server.ts.
 */
const GEMINI_DEFAULT_MODEL = process.env["NOVA_GEMINI_MODEL"] ?? "gemini-2.0-flash";

export type ReasoningProviderResult =
  | (AiGatewayResult & { provider: ReasoningProviderName; unavailable: false })
  | { provider: ReasoningProviderName; unavailable: true; reason: string };

/**
 * Whether a provider has the configuration it needs to actually run —
 * checked before ever attempting a call, so "credentials missing" is a
 * clean, typed outcome rather than a thrown error from deep inside a fetch.
 */
export function isReasoningProviderConfigured(provider: ReasoningProviderName): boolean {
  if (OPENAI_PROVIDERS.has(provider)) return Boolean(process.env["NOVA_AI_API_KEY"]);
  return Boolean(process.env["NOVA_GEMINI_API_KEY"]);
}

/**
 * Calls the named provider with the exact same normalized prompt — the
 * intelligence layer never branches on which provider it's talking to.
 * Never fabricates a result: an unconfigured provider returns
 * `{unavailable: true}` immediately, and a real call failure (timeout, rate
 * limit, malformed response) is caught and returned the same shape rather
 * than thrown, so a challenger provider's outage never breaks the primary
 * evaluation.
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
          : "Gemini is not configured for this deployment (missing NOVA_GEMINI_API_KEY). Set NOVA_GEMINI_API_KEY (and optionally NOVA_GEMINI_MODEL) to enable it as a challenger provider.",
    };
  }
  try {
    const result =
      provider === "openai"
        ? await callAiGateway(opts)
        : await callAiGateway({
            ...opts,
            endpoint: {
              url: GEMINI_OPENAI_COMPAT_URL,
              apiKey: process.env["NOVA_GEMINI_API_KEY"] as string,
              model: opts.model ?? GEMINI_DEFAULT_MODEL,
            },
          });
    return { ...result, provider, unavailable: false };
  } catch (err) {
    return { provider, unavailable: true, reason: (err as Error).message };
  }
}
