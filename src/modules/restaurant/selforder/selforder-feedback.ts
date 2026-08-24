/**
 * Guest feedback routing — pure, DB-free, matching the same
 * pattern as selforder-tracking.ts / selforder-recovery.ts: a plain data
 * transform the server module calls, unit testable without a Supabase
 * client.
 *
 * This phase deliberately does not send a guest anywhere external: 4-5
 * stars only marks the moment a future phase could offer a public review
 * link (Google/TripAdvisor), it never fabricates or shows one.
 */
export type FeedbackRouting = "service_recovery" | "thanks" | "advocacy_ready";

export function classifyFeedbackRouting(rating: number): FeedbackRouting {
  if (rating <= 2) return "service_recovery";
  if (rating === 3) return "thanks";
  return "advocacy_ready";
}
