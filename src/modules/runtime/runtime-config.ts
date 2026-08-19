/**
 * NOVA Hospitality — Restaurant & Bar OS
 * Runtime configuration (PRODUCTIZATION-3, Phase 8).
 *
 * There is exactly ONE application and ONE set of business logic. The only
 * thing that differs between a hosted deployment and a local appliance is the
 * infrastructure it points at. This module resolves that, and nothing else.
 *
 * It must stay free of business rules and free of secrets.
 */

export type RuntimeMode = "hosted" | "local";

export interface RuntimeTarget {
  /** hosted = managed cloud backend, local = on-premise appliance */
  mode: RuntimeMode;
  /** Base URL of the data API surface (hosted PostgREST or local gateway). */
  apiUrl: string;
  /** Publishable/anon key presented by browser terminals. */
  publishableKey: string;
  /** True when the deployment may rely on WAN-only services. */
  wanExpected: boolean;
}

export type RuntimeEnv = Record<string, string | undefined>;

export const RUNTIME_MODE_ENV_KEYS = ["NOVA_RUNTIME_MODE", "VITE_NOVA_RUNTIME_MODE"] as const;

export function resolveRuntimeMode(env: RuntimeEnv): RuntimeMode {
  for (const key of RUNTIME_MODE_ENV_KEYS) {
    const raw = env[key]?.trim().toLowerCase();
    if (raw === "local") return "local";
    if (raw === "hosted") return "hosted";
  }
  return "hosted";
}

export function resolveRuntimeTarget(env: RuntimeEnv): RuntimeTarget {
  const mode = resolveRuntimeMode(env);
  const apiUrl =
    env["VITE_SUPABASE_URL"] ?? env["SUPABASE_URL"] ?? (mode === "local" ? "http://127.0.0.1:8000" : "");
  const publishableKey =
    env["VITE_SUPABASE_PUBLISHABLE_KEY"] ??
    env["SUPABASE_PUBLISHABLE_KEY"] ??
    (mode === "local" ? "nova-local-anon" : "");

  return {
    mode,
    apiUrl,
    publishableKey,
    wanExpected: mode === "hosted",
  };
}

/**
 * WAN-dependent capabilities. Local installs keep operating without these;
 * they must degrade honestly rather than report false success.
 */
export const WAN_DEPENDENT_CAPABILITIES = [
  "email-delivery",
  "whatsapp-delivery",
  "external-payment-capture",
  "intelligence-advisory",
] as const;

export type WanCapability = (typeof WAN_DEPENDENT_CAPABILITIES)[number];

export function isOptionalCapability(capability: string): capability is WanCapability {
  return (WAN_DEPENDENT_CAPABILITIES as readonly string[]).includes(capability);
}