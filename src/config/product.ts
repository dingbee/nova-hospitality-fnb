/**
 * LexiBite — product identity.
 *
 * Product identity is fixed; *customer* identity (tenant, property, outlet)
 * is data and is resolved from the database at runtime. Nothing here may
 * name a specific hotel, lodge or restaurant group.
 *
 * LexiBite is the single product identity across every surface — guest
 * ordering PWA and staff operational terminal (POS/KDS/back office) alike.
 * Internal code, database entities and provider identifiers keep their
 * existing technical names; only the customer/operator-facing strings read
 * from this file.
 */
export const PRODUCT = {
  name: "LexiBite",
  shortName: "LexiBite",
  tagline: "Restaurant & Bar OS",
  vendor: "LexiBite",
  supportEmail: "support@lexibite.local",
  /**
   * The customer/operator-facing name of the AI intelligence experience —
   * "Ask LexiBite", "LexiBite's interpretation", "LexiBite recommendation",
   * "LexiBite Intelligence". This is the ONLY place that name is defined:
   * every screen reads it from here rather than hardcoding the string, so
   * the underlying LLM provider/model can change without touching any
   * customer-facing UI. Never render the underlying provider, model,
   * model version, latency, token counts, or any other technical/AI
   * telemetry in product UI — those remain available server-side for
   * engineering observability only.
   */
  aiName: "LexiBite",
  /**
   * The customer-facing product identity: guest portal, guest PWA, QR
   * artifacts, receipts, invoices, confirmation documents, transactional
   * emails — anywhere a diner/guest sees the product name. Kept as its own
   * field (currently equal to `name`) so guest-facing copy can keep reading
   * a dedicated identity even though the staff terminal now shares it too.
   */
  guestFacingName: "LexiBite",
} as const;

export function productTitle(page: string): string {
  return `${page} — ${PRODUCT.shortName}`;
}
