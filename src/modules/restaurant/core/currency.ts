export interface SupportedCurrency {
  code: string;
  name: string;
  symbol: string;
}

export const SUPPORTED_CURRENCIES: readonly SupportedCurrency[] = [
  { code: "TZS", name: "Tanzanian Shilling", symbol: "TSh" },
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "EUR", name: "Euro", symbol: "€" },
  { code: "GBP", name: "British Pound", symbol: "£" },
  { code: "KES", name: "Kenyan Shilling", symbol: "KSh" },
  { code: "UGX", name: "Ugandan Shilling", symbol: "USh" },
  { code: "RWF", name: "Rwandan Franc", symbol: "FRw" },
  { code: "ZAR", name: "South African Rand", symbol: "R" },
  { code: "AED", name: "UAE Dirham", symbol: "AED" },
  { code: "SAR", name: "Saudi Riyal", symbol: "SAR" },
  { code: "INR", name: "Indian Rupee", symbol: "₹" },
  { code: "CNY", name: "Chinese Yuan", symbol: "¥" },
  { code: "CHF", name: "Swiss Franc", symbol: "CHF" },
  { code: "CAD", name: "Canadian Dollar", symbol: "CA$" },
  { code: "AUD", name: "Australian Dollar", symbol: "A$" },
] as const;

export const SUPPORTED_CURRENCY_CODES = SUPPORTED_CURRENCIES.map((c) => c.code);

export function normalizeCurrency(value: string | null | undefined, fallback = "TZS"): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : fallback;
}


type CurrencyDb = {
  from: (table: string) => any;
};

/**
 * Authoritative operating-currency resolver.
 *
 * Precedence:
 *   property.currency -> tenant settings.business.defaultCurrency
 *   -> tenant base currency registry -> product fallback.
 *
 * TZS is deliberately the final bootstrap/legacy fallback only; it is never
 * preferred over an operator-configured tenant or property currency.
 */
export async function resolveOperatingCurrency(
  sb: CurrencyDb,
  tenantId: string,
  propertyId?: string | null,
  locationId?: string | null,
): Promise<string> {
  let resolvedPropertyId = propertyId ?? null;

  if (!resolvedPropertyId && locationId) {
    const { data: location } = await sb
      .from("restaurant_locations")
      .select("property_id")
      .eq("tenant_id", tenantId)
      .eq("id", locationId)
      .maybeSingle();
    resolvedPropertyId = location?.property_id ?? null;
  }

  if (resolvedPropertyId) {
    const { data: property } = await sb
      .from("restaurant_properties")
      .select("currency")
      .eq("tenant_id", tenantId)
      .eq("id", resolvedPropertyId)
      .maybeSingle();
    const propertyCurrency = normalizeCurrency(property?.currency, "");
    if (propertyCurrency) return propertyCurrency;
  }

  const { data: tenant } = await sb
    .from("restaurant_tenants")
    .select("settings")
    .eq("id", tenantId)
    .maybeSingle();
  const tenantCurrency = normalizeCurrency(
    (tenant?.settings as { business?: { defaultCurrency?: string | null } } | null)?.business
      ?.defaultCurrency,
    "",
  );
  if (tenantCurrency) return tenantCurrency;

  const { data: base } = await sb
    .from("restaurant_currencies")
    .select("code")
    .eq("tenant_id", tenantId)
    .eq("is_base", true)
    .limit(1);
  const registryCurrency = normalizeCurrency((base ?? [])[0]?.code, "");
  return registryCurrency || normalizeCurrency(undefined);
}
