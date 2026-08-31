// NOVA Hospitality F&B — INT-01 reasoning provider selector.
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
const GEMINI_DEFAULT_MODEL = process.env["NOVA_GEMINI_MODEL"] ?? "gemini-2.0-flash";

export type ReasoningProviderResult =
  | (AiGatewayResult & { provider: ReasoningProviderName; unavailable: false })
  | { provider: ReasoningProviderName; unavailable: true; reason: string };

export function isReasoningProviderConfigured(provider: ReasoningProviderName): boolean {
  if (OPENAI_PROVIDERS.has(provider)) return Boolean(process.env["NOVA_AI_API_KEY"]);
  return Boolean(process.env["NOVA_GEMINI_API_KEY"]);
}

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
        ? await callAiGateway({ ...opts, protocol: "responses" })
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
