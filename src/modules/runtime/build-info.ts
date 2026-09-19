/**
 * ME-16 remediation (ME16-09/10) — build identity for the hosted runtime.
 *
 * Never invents a value: Vercel sets `VERCEL_GIT_COMMIT_SHA` automatically
 * on every deployment (https://vercel.com/docs/environment-variables/system-environment-variables).
 * When it is absent (local dev, the standalone appliance — which has its
 * own separate `standalone/BUILD_INFO` marker, see local/gateway/system.ts)
 * this reports "unknown" rather than fabricating a SHA.
 */
import { APP_VERSION } from "./version";

export function resolveBuildId(env: Record<string, string | undefined> = process.env): string {
  return env.VERCEL_GIT_COMMIT_SHA ?? env.SOURCE_VERSION ?? env.GIT_SHA ?? "unknown";
}

export interface BuildIdentity {
  appVersion: string;
  buildId: string;
  vercelEnv: string | null;
}

export function resolveBuildIdentity(
  env: Record<string, string | undefined> = process.env,
): BuildIdentity {
  return {
    appVersion: APP_VERSION,
    buildId: resolveBuildId(env),
    vercelEnv: env.VERCEL_ENV ?? null,
  };
}
