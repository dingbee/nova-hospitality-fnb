/**
 * LexiBite Demo Access — canonical environment constants.
 *
 * These ids are never client-supplied and never read from a request body —
 * they are the fixed identifiers of the real, existing "LexiBite Demo
 * Restaurant" / "Kilimanjaro Grill" / "Kilimanjaro Grill West" tenant
 * established by migration 0039_branding_sprint_identity_hierarchy_repair.sql.
 * The grant function in migration 0082 hardcodes the same three ids as SQL
 * literals; this file is the TypeScript side of that same fixed binding
 * (used for display/links/reset targeting, never passed to the grant RPC).
 */
export const DEMO_TENANT_ID = "cebda97b-33b1-43bf-932e-d7fee992a6c3";
export const DEMO_PROPERTY_ID = "d6674bdc-ebe2-4bb7-801a-54b1b8dfc218";
export const DEMO_LOCATION_ID = "fb15e245-b2bf-4d07-abb6-213bbeafa584";
export const DEMO_ROLE = "viewer";
export const DEMO_SOURCE = "LEXIBITE_DEMO";

/** Matches the hardcoded interval in restaurant_grant_demo_session() (migration 0082). */
export const DEMO_SESSION_TTL_HOURS = 4;

export const DEMO_REGISTRATION_STATUS = {
  PENDING_VERIFICATION: "pending_verification",
  VERIFIED: "verified",
  SESSION_ACTIVE: "session_active",
  ERROR: "error",
} as const;
export type DemoRegistrationStatus =
  (typeof DEMO_REGISTRATION_STATUS)[keyof typeof DEMO_REGISTRATION_STATUS];

/** Per-IP and per-email abuse limits. Deliberately conservative — a demo funnel has low legitimate volume. */
export const DEMO_RATE_LIMITS = {
  MAX_REGISTRATIONS_PER_IP_PER_HOUR: 5,
  MAX_RESENDS: 5,
  MIN_RESEND_INTERVAL_SECONDS: 60,
};
