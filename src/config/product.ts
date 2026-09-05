/**
 * NOVA Hospitality F&B — product identity.
 *
 * Product identity is fixed; *customer* identity (tenant, property, outlet)
 * is data and is resolved from the database at runtime. Nothing here may
 * name a specific hotel, lodge or restaurant group.
 */
export const PRODUCT = {
  name: "NOVA Hospitality F&B",
  shortName: "NOVA F&B",
  tagline: "Restaurant & Bar OS",
  vendor: "NOVA Hospitality",
  supportEmail: "support@nova-hospitality.local",
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
   * emails — anywhere a diner/guest sees the product name. The staff-facing
   * operational terminal (POS/KDS/back office) keeps `name`/`shortName`
   * above; only surfaces the GUEST sees must say this, never NOVA.
   */
  guestFacingName: "LexiBite",
} as const;

export function productTitle(page: string): string {
  return `${page} — ${PRODUCT.shortName}`;
}
