/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Server-side purchase-order governance: destination resolution, supplier
 * eligibility, supplier-catalogue integrity and commitment re-validation.
 *
 * Every purchase-order entry point (direct order, requisition conversion,
 * submission, approval) goes through these functions; the database guard
 * from migration 0157 enforces the same rules again underneath, so a
 * manipulated payload or a direct API call cannot bypass them.
 */
import { resolveCentralStore } from "../inventory/central-store.server";
import {
  PurchaseOrderGovernanceError,
  purchaseOrderCommitmentIssues,
  type PurchaseOrderCommitmentSnapshot,
} from "./governance";

type Sb = any;

export interface ResolvedPurchaseOrderDestination {
  propertyId: string | null;
  locationId: string | null;
  /** True when the order is destined for the tenant central store. */
  centralStore: boolean;
  /** The property that raised the demand, kept for traceability of central orders. */
  originatingPropertyId: string | null;
  resolvedBy: "explicit_location" | "central_store_policy" | "property";
}

/**
 * Where an order's goods go.
 *
 * 1. An explicit location is validated (tenant, active) and wins; a central
 *    store location yields a tenant-scoped order with no property_id.
 * 2. Without a location, an active central store is the procurement
 *    destination (central-store mode). The requesting property, if any, is
 *    preserved as the originating property.
 * 3. Without a central store, the order is property-level and requires a
 *    property.
 * 4. Otherwise the order is refused — it is never created unassigned.
 */
export async function resolvePurchaseOrderDestination(
  sb: Sb,
  tenantId: string,
  input: { propertyId?: string | null; locationId?: string | null },
): Promise<ResolvedPurchaseOrderDestination> {
  const propertyId = input.propertyId ?? null;
  const locationId = input.locationId ?? null;

  if (locationId) {
    const { data: location, error } = await sb
      .from("restaurant_locations")
      .select("id, tenant_id, property_id, scope, status, is_storage")
      .eq("tenant_id", tenantId)
      .eq("id", locationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!location) {
      throw new PurchaseOrderGovernanceError(
        "PO_DESTINATION_UNRESOLVED",
        "the destination location is not in this tenant or you cannot access it.",
      );
    }
    if (location.status !== "active") {
      throw new PurchaseOrderGovernanceError(
        "PO_DESTINATION_UNRESOLVED",
        "the destination location is inactive.",
      );
    }
    if (location.scope === "tenant") {
      const store = await resolveCentralStore(sb, tenantId);
      if (!store || store.locationId !== location.id) {
        throw new PurchaseOrderGovernanceError(
          "PO_DESTINATION_UNRESOLVED",
          "the tenant-scoped location is not the active central store.",
        );
      }
      return {
        propertyId: null,
        locationId: location.id,
        centralStore: true,
        originatingPropertyId: propertyId,
        resolvedBy: "explicit_location",
      };
    }
    if (propertyId && location.property_id !== propertyId) {
      throw new PurchaseOrderGovernanceError(
        "PO_DESTINATION_UNRESOLVED",
        "the destination location does not belong to the selected property.",
      );
    }
    return {
      propertyId: location.property_id,
      locationId: location.id,
      centralStore: false,
      originatingPropertyId: location.property_id,
      resolvedBy: "explicit_location",
    };
  }

  const store = await resolveCentralStore(sb, tenantId);
  if (store) {
    return {
      propertyId: null,
      locationId: store.locationId,
      centralStore: true,
      originatingPropertyId: propertyId,
      resolvedBy: "central_store_policy",
    };
  }

  if (propertyId) {
    return {
      propertyId,
      locationId: null,
      centralStore: false,
      originatingPropertyId: propertyId,
      resolvedBy: "property",
    };
  }

  throw new PurchaseOrderGovernanceError(
    "PO_DESTINATION_UNRESOLVED",
    "no destination was given and this tenant has no active central store. Select the receiving property or location.",
  );
}

/** A new or changed order may only name an active supplier of this tenant. */
export async function assertSupplierEligible(sb: Sb, tenantId: string, supplierId: string) {
  const { data, error } = await sb
    .from("restaurant_suppliers")
    .select("id, name, status")
    .eq("tenant_id", tenantId)
    .eq("id", supplierId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    throw new PurchaseOrderGovernanceError(
      "PO_SUPPLIER_INACTIVE",
      "the supplier does not exist in this tenant.",
    );
  }
  if (data.status !== "active") {
    throw new PurchaseOrderGovernanceError(
      "PO_SUPPLIER_INACTIVE",
      `${data.name} is ${data.status}. Inactive suppliers cannot be used for new purchasing.`,
    );
  }
  return data as { id: string; name: string; status: string };
}

/**
 * A line that names a supplier-catalogue product must reference an active
 * product of the order's own supplier, in the order's currency.
 */
export async function assertSupplierProductsBelongToSupplier(
  sb: Sb,
  tenantId: string,
  supplierId: string | null,
  currency: string,
  supplierProductIds: string[],
) {
  const ids = [...new Set(supplierProductIds.filter(Boolean))];
  if (ids.length === 0) return;
  if (!supplierId) {
    throw new PurchaseOrderGovernanceError(
      "PO_SUPPLIER_REQUIRED",
      "a supplier-catalogue line requires the order's supplier.",
    );
  }
  const { data, error } = await sb
    .from("restaurant_supplier_products")
    .select("id, supplier_id, active, currency")
    .eq("tenant_id", tenantId)
    .in("id", ids);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as any[];
  if (
    rows.length !== ids.length ||
    rows.some((r) => r.supplier_id !== supplierId || r.active === false)
  ) {
    throw new PurchaseOrderGovernanceError(
      "PO_LINE_INVALID",
      "a catalogue line references a product that is not an active product of this supplier.",
    );
  }
  if (rows.some((r) => String(r.currency ?? "").toUpperCase() !== currency)) {
    throw new PurchaseOrderGovernanceError(
      "PO_CURRENCY_INVALID",
      "a catalogue product is priced in a different currency from the order.",
    );
  }
}

export async function loadPurchaseOrderCommitmentSnapshot(
  sb: Sb,
  tenantId: string,
  purchaseOrderId: string,
): Promise<PurchaseOrderCommitmentSnapshot> {
  const { data: po, error } = await sb
    .from("restaurant_purchase_orders")
    .select("id, supplier_id, property_id, location_id, subtotal, tax_total, discount_total, total")
    .eq("tenant_id", tenantId)
    .eq("id", purchaseOrderId)
    .single();
  if (error || !po) throw new Error("Purchase order not found.");
  const [{ data: supplier }, { data: lines, error: linesError }] = await Promise.all([
    po.supplier_id
      ? sb
          .from("restaurant_suppliers")
          .select("status")
          .eq("tenant_id", tenantId)
          .eq("id", po.supplier_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    sb
      .from("restaurant_purchase_order_items")
      .select(
        "description, quantity, unit_price, line_total, price_exception_reason, price_exception_authorised_by",
      )
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", purchaseOrderId),
  ]);
  if (linesError) throw new Error(linesError.message);
  return {
    supplierId: po.supplier_id ?? null,
    supplierStatus: supplier?.status ?? null,
    propertyId: po.property_id ?? null,
    locationId: po.location_id ?? null,
    subtotal: Number(po.subtotal ?? 0),
    taxTotal: Number(po.tax_total ?? 0),
    discountTotal: Number(po.discount_total ?? 0),
    total: Number(po.total ?? 0),
    lines: ((lines ?? []) as any[]).map((l) => ({
      description: l.description,
      quantity: Number(l.quantity ?? 0),
      unitPrice: Number(l.unit_price ?? 0),
      lineTotal: Number(l.line_total ?? 0),
      priceExceptionReason: l.price_exception_reason ?? null,
      priceExceptionAuthorisedBy: l.price_exception_authorised_by ?? null,
    })),
  };
}

/** Re-validates an order immediately before submission or approval. */
export async function assertPurchaseOrderCommitmentReady(
  sb: Sb,
  tenantId: string,
  purchaseOrderId: string,
): Promise<PurchaseOrderCommitmentSnapshot> {
  const snapshot = await loadPurchaseOrderCommitmentSnapshot(sb, tenantId, purchaseOrderId);
  const issues = purchaseOrderCommitmentIssues(snapshot);
  if (issues.length > 0) {
    throw new Error(`This purchase order cannot proceed: ${issues.join(" ")}`);
  }
  return snapshot;
}
