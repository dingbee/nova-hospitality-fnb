/**
 * GEP6 "Table QR & Guest Access Management" — pure, DOM-free logic.
 *
 * The guest ordering URL already exists (O12 architecture, unchanged here):
 * `{origin}/order/{restaurant_tables.id}`. This module only ever derives
 * that same permanent URL and the branding/table data needed to render it
 * as a QR — it never invents a second table-access mechanism, never mints
 * a token, and never changes what the guest route accepts. See
 * `resolveGuestTableContext` in `selforder/selforder.server.ts` for the
 * server-side twin of the branding precedence mirrored here (that function
 * resolves the SAME `tenant.settings.business.{tradingName,logoUrl}`
 * fields when a guest actually scans; this one reads the identical fields
 * from the already-loaded `MasterData.tenant` on the Setup Workbench, so a
 * manager previewing a QR sees exactly what a guest will see).
 *
 * No new server function, no new capability: every input here (`tenant`,
 * `tables`) is already loaded by `listAllMasterData` (gated by
 * `assertTenantRead`) for whichever tenant the signed-in staff member
 * belongs to — QR generation is a client-side projection of data that
 * screen already legitimately holds, not a new read path.
 */
import type { RestaurantTenantRow, TableRow } from "./ui/types";

export interface TableQrBranding {
  businessName: string;
  businessLogoUrl: string | null;
}

type BrandingTenant = Pick<RestaurantTenantRow, "name" | "settings"> | null;

/**
 * Mirrors resolveGuestTableContext's exact precedence: the operator's
 * configured trading name (BusinessPanel.tsx's "doing business as" field)
 * when set, otherwise the tenant's legal/record name — never a second,
 * QR-specific business-name field (spec section 10: "Do NOT create
 * another business-name or logo field").
 */
export function resolveTenantBranding(tenant: BrandingTenant): TableQrBranding {
  if (!tenant) return { businessName: "", businessLogoUrl: null };
  const business = (
    tenant.settings as { business?: { tradingName?: string; logoUrl?: string | null } } | null
  )?.business;
  const tradingName = (business?.tradingName ?? "").trim();
  const businessLogoUrl = business?.logoUrl?.trim() || null;
  return { businessName: tradingName || tenant.name, businessLogoUrl };
}

/**
 * The one and only guest URL a table QR may ever encode (spec section 4):
 * permanent, bound to `restaurant_tables.id`, never a token, never
 * rotated. `origin` is always the caller's own `window.location.origin`
 * (or an explicitly passed production origin for tooling/tests) — never a
 * hardcoded domain, so the exact same code produces the right link on
 * localhost, a preview deploy, or a future custom domain.
 */
export function buildGuestOrderUrl(origin: string, tableId: string): string {
  return `${origin.replace(/\/+$/, "")}/order/${tableId}`;
}

export interface TableQrCard {
  tableId: string;
  tableCode: string;
  /** Raw table name (e.g. "Table 01") — callers render it uppercase for the "TABLE 01" treatment; the underlying string is never mutated. */
  tableLabel: string;
  guestUrl: string;
  businessName: string;
  businessLogoUrl: string | null;
}

/**
 * Active-only, de-duplicated by id, sorted for a stable and predictable
 * print order. Inactive tables never enter the default printable pack
 * (spec section 8) — a deactivated table has no business being handed to
 * a guest to scan.
 */
export function selectActiveTablesForPack<
  T extends Pick<TableRow, "id" | "code" | "name" | "active">,
>(tables: readonly T[]): T[] {
  const seen = new Set<string>();
  return tables
    .filter((t) => t.active)
    .filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    })
    .sort(
      (a, b) =>
        a.code.localeCompare(b.code, undefined, { numeric: true }) || a.name.localeCompare(b.name),
    );
}

export function buildTableQrCard(
  tenant: BrandingTenant,
  table: Pick<TableRow, "id" | "code" | "name">,
  origin: string,
): TableQrCard {
  const branding = resolveTenantBranding(tenant);
  return {
    tableId: table.id,
    tableCode: table.code,
    tableLabel: table.name,
    guestUrl: buildGuestOrderUrl(origin, table.id),
    businessName: branding.businessName,
    businessLogoUrl: branding.businessLogoUrl,
  };
}

/**
 * The data set behind "Download All QR Codes" — active tables of the
 * CALLER'S ALREADY-SCOPED `tables` array only (spec section 7: never leak
 * another tenant/property/location's tables). `includeInactive` exists
 * only for a future explicit "include inactive" toggle the UI does not
 * yet expose; the default is always active-only.
 */
export function buildTableQrCards(
  tenant: BrandingTenant,
  tables: readonly Pick<TableRow, "id" | "code" | "name" | "active">[],
  origin: string,
  opts: { includeInactive?: boolean } = {},
): TableQrCard[] {
  const selected = opts.includeInactive ? tables : selectActiveTablesForPack(tables);
  return selected.map((t) => buildTableQrCard(tenant, t, origin));
}

export interface QrRenderOptions {
  errorCorrectionLevel: "M" | "H";
  /** Quiet zone width, in QR modules — keeps the code readable right up to a printed card's edge. */
  margin: number;
  /** Native pixel width the QR is generated AT — never a small QR upscaled after the fact (spec section 6). */
  width: number;
}

/**
 * A logo sitting on top of QR modules removes usable data capacity — level
 * H (~30% error correction) keeps the code reliably scannable with a
 * small centered logo; level M is already comfortable with no logo and
 * keeps modules a little coarser (chunkier, easier to scan in poor
 * lighting) when there's nothing to compensate for. Scan reliability
 * always outranks decoration (spec section 3).
 */
export function resolveQrRenderOptions(hasLogo: boolean): QrRenderOptions {
  return {
    errorCorrectionLevel: hasLogo ? "H" : "M",
    margin: 3,
    width: 900,
  };
}

/**
 * A centered logo must never cover more than this fraction of the QR's
 * width. Verified empirically (qr.decode.test.ts) at level H: a solid
 * opaque square covering 18% of the QR still decodes cleanly, well inside
 * level H's ~30% error-correction budget once the quiet zone and normal
 * print imperfections are accounted for. Anything a caller can't fit
 * within this fraction should shrink the logo, never raise this constant.
 */
export const LOGO_MAX_QR_FRACTION = 0.18;
