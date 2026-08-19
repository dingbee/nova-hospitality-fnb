/**
 * Restaurant & Bar OS — product identity and neutral defaults.
 *
 * The product must boot and operate without any single customer's data.
 * Anything here is a *fallback* only: tenant / property / outlet configuration
 * always wins at runtime. Deployments may override the seed defaults through
 * environment configuration (read server-side only).
 */
export const PRODUCT_NAME = "Restaurant & Bar OS";

/** Fallback business name on documents before a tenant names itself. */
export const FALLBACK_BUSINESS_NAME = "Restaurant";

/** UI seed defaults for the first property a new tenant creates. */
export const DEFAULT_CURRENCY = "TZS";
export const DEFAULT_TIMEZONE = "Africa/Dar_es_Salaam";

/**
 * Absolute origin used for guest-facing share links.
 * Resolution order: explicit deployment config → live request host → relative.
 * There is deliberately no customer domain baked into the product.
 */
export function resolvePublicOrigin(requestHost?: string | null, proto = "https"): string {
  const configured = process.env["PUBLIC_APP_URL"];
  if (configured) return configured.replace(/\/$/, "");
  if (requestHost) return `${proto}://${requestHost}`;
  return "";
}