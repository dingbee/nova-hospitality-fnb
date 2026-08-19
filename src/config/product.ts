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
} as const;

export function productTitle(page: string): string {
  return `${page} — ${PRODUCT.shortName}`;
}
