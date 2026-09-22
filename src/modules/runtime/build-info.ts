/**
 * ME-16 remediation (ME16-09/10) — build identity for the hosted runtime.
 *
 * Never invents a value: Vercel sets `VERCEL_GIT_COMMIT_SHA` automatically
 * on every deployment (https://vercel.com/docs/environment-variables/system-environment-variables).
 * When it is absent (local dev, the standalone appliance — which has its
 * own separate `standalone/BUILD_INFO` marker, see local/gateway/system.ts)
 * this reports "unknown" rather than fabricating a SHA.
 */
import { APP_VERSION, REQUIRED_SCHEMA_VERSION } from "./version";

export function resolveBuildId(env: Record<string, string | undefined> = process.env): string {
  return env.VERCEL_GIT_COMMIT_SHA ?? env.SOURCE_VERSION ?? env.GIT_SHA ?? "unknown";
}

export interface BuildIdentity {
  appVersion: string;
  buildId: string;
  vercelEnv: string | null;
  deploymentId: string | null;
  deploymentUrl: string | null;
  buildTimestamp: string | null;
  schemaVersion: string;
}

function resolveBuildTimestamp(env: Record<string, string | undefined>): string | null {
  const value = env.LEXIBITE_BUILD_TIMESTAMP ?? env.BUILD_TIMESTAMP;
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

export function resolveBuildIdentity(
  env: Record<string, string | undefined> = process.env,
): BuildIdentity {
  return {
    appVersion: APP_VERSION,
    buildId: resolveBuildId(env),
    vercelEnv: env.VERCEL_ENV ?? null,
    deploymentId: env.VERCEL_DEPLOYMENT_ID ?? null,
    deploymentUrl: env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL ?? null,
    buildTimestamp: resolveBuildTimestamp(env),
    schemaVersion: REQUIRED_SCHEMA_VERSION,
  };
}
