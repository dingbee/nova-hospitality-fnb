/**
 * Shared structured server-side diagnostic logging.
 *
 * Callers must never pass secrets, tokens, full request/response payloads,
 * or raw SQL in details.
 */
export type DiagnosticDetails = Record<string, string | number | boolean | null | undefined>;

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
