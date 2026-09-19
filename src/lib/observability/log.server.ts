/**
 * ME-16 remediation — one shared, structured server-side diagnostic log
 * shape, reused by the server-fn correlation middleware, auth/RBAC denial
 * points, webhook receivers, and external-integration adapters, so a single
 * pattern is grep-able across the whole server surface instead of N ad hoc
 * `console.warn` call shapes.
 *
 * Never pass secrets, tokens, full request/response payloads, or raw SQL
 * into `details` — callers own that boundary; this module does not attempt
 * to redact, it only formats.
 */

export type DiagnosticDetails = Record<string, string | number | boolean | null | undefined>;

/**
 * A failure with a caught exception. Logs at `console.error` and includes
 * the original error object (Node/Bun's console.error prints its stack),
 * matching the existing `[api-platform] unhandled error` convention.
 */
export function logServerFailure(
  scope: string,
  requestId: string | null | undefined,
  details: DiagnosticDetails,
  error: unknown,
): void {
  console.error(
    `[${scope}]`,
    JSON.stringify({
      requestId: requestId ?? "unknown",
      timestamp: new Date().toISOString(),
      ...details,
    }),
    error,
  );
}

/**
 * An expected denial (auth/authz rejection, validation refusal) — not a bug,
 * so it logs at `console.warn`, with no error object required.
 */
export function logServerDenial(
  scope: string,
  requestId: string | null | undefined,
  details: DiagnosticDetails,
): void {
  console.warn(
    `[${scope}]`,
    JSON.stringify({
      requestId: requestId ?? "unknown",
      timestamp: new Date().toISOString(),
      ...details,
    }),
  );
}
