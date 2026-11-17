/**
 * ME-16 remediation (ME16-03) — one shared classifier deciding whether an
 * error's own message is safe to show a staff user verbatim, or whether it
 * looks like a raw technical/parser/network failure that must be replaced
 * with a generic, reference-carrying message instead.
 *
 * Reproduced failure this closes: a Supabase Auth call whose response
 * wasn't valid JSON (e.g. an infrastructure failure returning an HTML error
 * page) surfaced the literal parser exception —
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` — directly in
 * the sign-in form via `toast.error(error.message)`
 * (src/routes/auth.tsx, src/routes/auth_.sign-up.tsx).
 *
 * This does NOT change the message for a normal, already-safe rejection
 * (e.g. "Invalid login credentials", "Unauthorized: ...") — those are
 * short, human-authored sentences the app already relies on showing
 * verbatim. It only intercepts messages that look like leaked internals.
 */

const UNSAFE_PATTERNS: RegExp[] = [
  /unexpected token/i,
  /is not valid json/i,
  /syntaxerror/i,
  /<!doctype/i,
  /\bat .*:\d+:\d+/, // stack-frame shaped ("at Object.<anonymous> (file:12:34)")
  /\bfetch failed\b/i,
  /\becconnrefused\b/i,
  /\betimedout\b/i,
];

const MAX_SAFE_LENGTH = 200;

function looksUnsafe(message: string): boolean {
  if (message.length > MAX_SAFE_LENGTH) return true;
  return UNSAFE_PATTERNS.some((pattern) => pattern.test(message));
}

export interface PresentedError {
  message: string;
  requestId: string;
}

/**
 * Returns a message safe to render to a staff/guest user, plus a reference
 * ID to quote to support. `error` is logged to the console verbatim
 * (browser devtools only, never sent anywhere) so a developer with the
 * device in hand can still see the original failure.
 */
export function presentUserFacingError(
  error: unknown,
  fallback = "Something went wrong.",
): PresentedError {
  const requestId =
    (typeof error === "object" && error !== null && "requestId" in error
      ? String((error as { requestId?: unknown }).requestId)
      : undefined) ?? crypto.randomUUID();

  const rawMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const safeMessage = rawMessage && !looksUnsafe(rawMessage) ? rawMessage : fallback;

  console.error(`[client] reference=${requestId}`, error);

  return {
    message: `${safeMessage} Reference: ${requestId}`,
    requestId,
  };
}
