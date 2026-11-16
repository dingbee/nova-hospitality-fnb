/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import { assertCapability, getTenantScope, resolveMultiPropertyScope } from "../core/access.server";
import type { NovaIntentContract } from "../understand/intent.contracts";
import { getPurchasingIntelligence } from "../intelligence/purchasing.server";
import { resolveTenantCurrency } from "../prepare/resolve.server";
import { stockUnitsPerUnit } from "../inventory/stock-position.contract";
import { createPurchaseOrder, transitionPurchaseOrder } from "../purchasing/purchasing.server";
import { createGoodsReceipt } from "./receiving.server";

type Sb = any;
type SerializableJson = null | string | number | boolean | SerializableJson[] | { [key: string]: SerializableJson };
const uuid = z.string().uuid();

export const askLexiBitePurchaseOrderInputSchema = z.object({
  tenantId: uuid,
  contract: z.custom<NovaIntentContract>(),
});
export type AskLexiBitePurchaseOrderInput = z.infer<typeof askLexiBitePurchaseOrderInputSchema>;

export async function createAskLexiBitePurchaseOrder(
  sb: Sb,
  userId: string,
  input: AskLexiBitePurchaseOrderInput,
) {
  const { tenantId, contract } = input;
  if (contract.action !== "prepare_purchase_order") {
    throw new Error("This instruction is not a purchase-order request.");
  }
  if (!contract.supplier?.resolvedId) {
    throw new Error(
      "A specific supplier is required before Ask LexiBite can create a purchase order.",
    );
  }
  if (contract.supplier.status !== "exact" && contract.supplier.status !== "high") {
    throw new Error("The supplier could not be resolved confidently enough to create the order.");
  }

  await assertCapability(sb, userId, tenantId, "purchasing.manage");
  await assertCapability(sb, userId, tenantId, "purchasing.approve");

  const entities = contract.entities.filter(
    (entity) =>
      (entity.status === "exact" || entity.status === "high") && Boolean(entity.resolvedId),
  );
  if (entities.length === 0) throw new Error("At least one identified inventory item is required.");

  const itemIds = entities.map((entity) => entity.resolvedId!);
  const [{ data: items, error: itemError }, { data: products, error: productError }] =
    await Promise.all([
      sb
        .from("restaurant_inventory_items")
        .select(
          "id, name, unit_id, purchase_unit_id, pack_size, property_id, location_id, currency",
        )
        .eq("tenant_id", tenantId)
        .in("id", itemIds),
      sb
        .from("restaurant_supplier_products")
        .select("id, supplier_id, inventory_item_id, unit_id, pack_size, unit_price, currency, last_price_at, active, min_order_quantity")
        .eq("tenant_id", tenantId)
        .eq("supplier_id", contract.supplier.resolvedId)
        .in("inventory_item_id", itemIds),
    ]);
  if (itemError)
    throw new Error("Unable to validate purchase-order inventory: " + itemError.message);
  if (productError) throw new Error("Unable to validate supplier pricing: " + productError.message);

  const itemById = new Map(((items ?? []) as any[]).map((item) => [item.id, item]));
  const productByItem = new Map<string, any>();
  for (const product of (products ?? []) as any[]) {
    if (product.active === false || !product.inventory_item_id || !product.unit_id) continue;
    const item = itemById.get(product.inventory_item_id);
    if (!item?.unit_id) continue;
    let stockUnitsPerPurchaseUnit = 1;
    if (product.unit_id === item.unit_id) {
      stockUnitsPerPurchaseUnit = 1;
    } else if (
      item.purchase_unit_id &&
      product.unit_id === item.purchase_unit_id &&
      Number(item.pack_size) > 0
    ) {
      stockUnitsPerPurchaseUnit = Number(item.pack_size);
    } else {
      continue;
    }
    const price = Number(product.unit_price);
    if (!Number.isFinite(price) || price < 0) continue;
    const normalized = {
      ...product,
      stockUnitsPerPurchaseUnit,
      normalizedStockUnitPrice: price / stockUnitsPerPurchaseUnit,
    };
    const previous = productByItem.get(product.inventory_item_id);
    if (!previous || normalized.normalizedStockUnitPrice < previous.normalizedStockUnitPrice) {
      productByItem.set(product.inventory_item_id, normalized);
    }
  }

  const lines: Array<{
    inventoryItemId: string;
    supplierProductId: string;
    unitId: string;
    description: string;
    quantity: number;
    unitPrice: number;
  }> = [];

  for (const entity of entities) {
    const item = itemById.get(entity.resolvedId!);
    if (!item)
      throw new Error("Inventory item was not found: " + (entity.resolvedName ?? entity.raw) + ".");
    const quantity = entity.quantity?.quantity ?? null;
    if (quantity == null || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(
        "Quantity is required for " + item.name + " before creating the purchase order.",
      );
    }

    const product = productByItem.get(item.id);
    if (!product) {
      throw new Error(
        "No active supplier price is configured for " + item.name + " from the selected supplier.",
      );
    }

    const requestedUnitId = entity.quantity?.resolvedUnitId ?? null;
    const purchaseUnitId = product.unit_id ?? null;
    if (!purchaseUnitId)
      throw new Error("No supplier purchase unit is configured for " + item.name + ".");
    const stockUnitsPerPurchaseUnit = Number(product.stockUnitsPerPurchaseUnit ?? 0);
    if (!(stockUnitsPerPurchaseUnit > 0)) {
      throw new Error(
        "The supplier purchase unit for " + item.name + " cannot be converted to the stock unit.",
      );
    }
    let purchaseQuantity = quantity;
    if (requestedUnitId && requestedUnitId !== purchaseUnitId) {
      if (requestedUnitId !== item.unit_id) {
        throw new Error(
          "The requested unit for " +
            item.name +
            " cannot be converted to the supplier's configured purchase unit.",
        );
      }
      purchaseQuantity = Math.ceil(quantity / stockUnitsPerPurchaseUnit);
    }

    lines.push({
      inventoryItemId: item.id,
      supplierProductId: product.id,
      unitId: purchaseUnitId,
      description: item.name,
      quantity: purchaseQuantity,
      unitPrice: Number(product.unit_price ?? 0),
    });
  }

  const scope = await getTenantScope(sb, userId, tenantId);
  const propertyId = await resolveMultiPropertyScope(sb, tenantId, scope, null);
  const currency = await resolveTenantCurrency(sb, tenantId);

  const po = await createPurchaseOrder(sb, userId, {
    tenantId,
    propertyId: propertyId ?? undefined,
    supplierId: contract.supplier.resolvedId!,
    currency,
    directReason: "Prepared by Ask LexiBite from an explicit purchase-order request.",
    notes: "Created through Ask LexiBite after live supplier and inventory validation.",
    lines,
  });

  return {
    id: po.id as string,
    documentNumber: po.document_number as string,
    status: po.status as string,
  };
}

export const intelligentPurchaseOrderPlanInputSchema = z.object({
  tenantId: uuid,
  inventoryItemIds: z.array(uuid).max(25).default([]),
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  supplierId: uuid.nullable().optional(),
  idempotencyKey: uuid,
  lineOverrides: z
    .array(z.object({ inventoryItemId: uuid, quantity: z.number().positive().max(100000) }))
    .max(25)
    .default([]),
});
export type IntelligentPurchaseOrderPlanInput = z.infer<
  typeof intelligentPurchaseOrderPlanInputSchema
>;

export interface IntelligentPurchaseOrderLine {
  inventoryItemId: string;
  supplierProductId: string;
  unitId: string;
  stockUnitId: string;
  description: string;
  quantity: number;
  recommendedPurchaseQuantity: number;
  overrideApplied?: boolean;
  stockUnitsPerPurchaseUnit: number;
  minimumOrderQuantity: number;
  orderMultiple: number;
  recommendationEvidence: Record<string, SerializableJson>;
  unitPrice: number;
  estimatedCost: number;
  currentQuantity: number;
  dailyVelocity: number;
  leadTimeDays: number;
  coverDays: number;
}

export interface IntelligentPurchaseOrderGroup {
  key: string;
  supplierId: string;
  supplierName: string;
  propertyId: string | null;
  locationId: string | null;
  currency: string;
  lines: IntelligentPurchaseOrderLine[];
  subtotal: number;
}

export interface IntelligentPurchaseOrderPlan {
  generatedAt: string;
  windowDays: number;
  currency: string;
  groups: IntelligentPurchaseOrderGroup[];
  skipped: string[];
  suggestionCount: number;
  totalEstimatedSpend: number;
}

export async function previewIntelligentPurchaseOrders(
  sb: Sb,
  userId: string,
  input: IntelligentPurchaseOrderPlanInput,
): Promise<IntelligentPurchaseOrderPlan> {
  const { tenantId } = input;
  await assertCapability(sb, userId, tenantId, "purchasing.manage");
  await assertCapability(sb, userId, tenantId, "purchasing.approve");

  const scope = await getTenantScope(sb, userId, tenantId);
  const propertyId = input.propertyId
    ? await resolveMultiPropertyScope(sb, tenantId, scope, input.propertyId)
    : input.locationId
      ? null
      : await resolveMultiPropertyScope(sb, tenantId, scope, null);
  const intelligence = await getPurchasingIntelligence(sb, userId, {
    tenantId,
    windowDays: 30,
    propertyId,
    locationId: input.locationId,
  });

  const requestedIds = new Set(input.inventoryItemIds);
  let suggestions = intelligence.suggestions;
  if (requestedIds.size > 0)
    suggestions = suggestions.filter((x) => requestedIds.has(x.inventoryItemId));
  if (input.supplierId) suggestions = suggestions.filter((x) => x.supplierId === input.supplierId);

  const itemIds = suggestions.map((x) => x.inventoryItemId);
  if (itemIds.length === 0)
    return {
      generatedAt: intelligence.generatedAt,
      windowDays: intelligence.windowDays,
      currency: intelligence.currency,
      groups: [],
      skipped: [],
      suggestionCount: 0,
      totalEstimatedSpend: 0,
    };

  const [
    { data: items, error: itemError },
    { data: products, error: productError },
    { data: suppliers, error: supplierError },
    { data: units, error: unitError },
    { data: selectedLocation, error: locationError },
  ] = await Promise.all([
    sb
      .from("restaurant_inventory_items")
      .select("id, name, unit_id, purchase_unit_id, pack_size, property_id, location_id, currency")
      .eq("tenant_id", tenantId)
      .in("id", itemIds),
    sb
      .from("restaurant_supplier_products")
      .select("id, supplier_id, inventory_item_id, unit_id, pack_size, unit_price, active")
      .eq("tenant_id", tenantId)
      .in("inventory_item_id", itemIds),
    sb.from("restaurant_suppliers").select("id, name, status").eq("tenant_id", tenantId),
    sb.from("restaurant_inventory_units").select("id, dimension, base_unit_id, factor").or("tenant_id.eq." + tenantId + ",tenant_id.is.null"),
    input.locationId
      ? sb.from("restaurant_locations").select("id, property_id, scope, is_storage").eq("tenant_id", tenantId).eq("id", input.locationId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (itemError)
    throw new Error("Unable to validate replenishment inventory: " + itemError.message);
  if (productError) throw new Error("Unable to validate supplier pricing: " + productError.message);
  if (supplierError) throw new Error("Unable to validate suppliers: " + supplierError.message);
  if (unitError) throw new Error("Unable to validate supplier unit conversions: " + unitError.message);
  if (locationError) throw new Error("Unable to validate delivery location: " + locationError.message);
  if (input.locationId && !selectedLocation) throw new Error("Selected delivery location is not available in this tenant.");
  const scopedPropertyId = propertyId ?? selectedLocation?.property_id ?? null;

  const itemById = new Map(((items ?? []) as any[]).map((x) => [x.id, x]));
  const supplierById = new Map(((suppliers ?? []) as any[]).map((x) => [x.id, x]));
  const productById = new Map(((products ?? []) as any[]).map((x) => [x.id, x]));
  const selectedProductIds = suggestions.map((row) => row.supplierProductId).filter(Boolean) as string[];
  const priceHistoryRes = selectedProductIds.length
    ? await sb.from("restaurant_supplier_price_history")
        .select("supplier_product_id, unit_id, price, currency, effective_date, created_at")
        .eq("tenant_id", tenantId)
        .in("supplier_product_id", selectedProductIds)
        .lte("effective_date", new Date().toISOString().slice(0, 10))
    : { data: [], error: null };
  if (priceHistoryRes.error) throw new Error("Unable to revalidate supplier price history: " + priceHistoryRes.error.message);
  const latestPriceByProduct = new Map<string, any>();
  for (const row of (priceHistoryRes.data ?? []) as any[]) {
    const previous = latestPriceByProduct.get(row.supplier_product_id);
    if (!previous || String(row.effective_date) > String(previous.effective_date) ||
        (String(row.effective_date) === String(previous.effective_date) && String(row.created_at) > String(previous.created_at))) {
      latestPriceByProduct.set(row.supplier_product_id, row);
    }
  }

  const skipped: string[] = [];
  const groups = new Map<string, IntelligentPurchaseOrderGroup>();
  for (const suggestion of suggestions) {
    if (!suggestion.supplierId || !suggestion.supplierProductId) {
      skipped.push(suggestion.name + ": Purchasing Intelligence has no validated supplier offer.");
      continue;
    }
    const item = itemById.get(suggestion.inventoryItemId);
    if (!item) {
      skipped.push(suggestion.name + ": inventory item could not be revalidated.");
      continue;
    }
    const product = productById.get(suggestion.supplierProductId);
    if (!product || product.active !== true || product.supplier_id !== suggestion.supplierId ||
        product.inventory_item_id !== suggestion.inventoryItemId) {
      skipped.push(suggestion.name + ": the selected supplier product is no longer active or no longer belongs to this item.");
      continue;
    }
    const supplier = supplierById.get(suggestion.supplierId);
    if (!supplier || supplier.status !== "active" || typeof supplier.name !== "string" || !supplier.name.trim()) {
      skipped.push(suggestion.name + ": selected supplier is no longer active.");
      continue;
    }
    const unitId = product.unit_id ?? null;
    const stockUnitsPerPurchaseUnit = Number(suggestion.stockUnitsPerPurchaseUnit ?? 0);
    const purchaseQuantity = Number(suggestion.purchaseQuantity ?? 0);
    const purchaseUnitPrice = Number(suggestion.purchaseUnitPrice ?? NaN);
    const purchaseCurrency = suggestion.purchaseCurrency ?? null;
    const currentStockFactor = unitId
      ? stockUnitsPerUnit(
          unitId,
          item.unit_id ?? null,
          unitId === item.purchase_unit_id ? unitId : null,
          Number(product.pack_size),
          (units ?? []) as any[],
        )
      : null;
    const purchaseUnit = ((units ?? []) as any[]).find((row) => row.id === unitId);
    const currentOrderMultiple = Number(product.order_multiple ??
      (purchaseUnit && purchaseUnit.dimension !== "count" ? 0.0001 : 1));
    if (!unitId || unitId !== suggestion.purchaseUnitId ||
        currentStockFactor == null || Math.abs(currentStockFactor - stockUnitsPerPurchaseUnit) > 0.000001 ||
        !(stockUnitsPerPurchaseUnit > 0) || !Number.isFinite(purchaseQuantity) ||
        purchaseQuantity <= 0 || !Number.isFinite(purchaseUnitPrice) || purchaseUnitPrice < 0) {
      skipped.push(suggestion.name + ": the recommendation's purchase-unit contract is incomplete or stale.");
      continue;
    }
    if (purchaseCurrency !== item.currency || product.currency !== purchaseCurrency) {
      skipped.push(suggestion.name + ": supplier and property currencies are no longer comparable.");
      continue;
    }
    const latestPrice = latestPriceByProduct.get(product.id);
    if (latestPrice && (latestPrice.unit_id !== unitId || latestPrice.currency !== product.currency)) {
      skipped.push(suggestion.name + ": latest supplier price history changed unit or currency; recalculate.");
      continue;
    }
    const currentPrice = Number(latestPrice?.price ?? product.unit_price);
    const currentPriceDate = latestPrice?.effective_date ?? product.last_price_at ?? null;
    if (!Number.isFinite(currentPrice) || currentPrice !== purchaseUnitPrice ||
        currentPriceDate !== (suggestion.effectivePriceDate ?? null)) {
      skipped.push(suggestion.name + ": supplier price or effective date changed after recommendation; recalculate.");
      continue;
    }
    const minimumOrderQuantity = Number(product.min_order_quantity ?? 0);
    const orderMultiple = Number(suggestion.orderMultiple ?? 1);
    if (!Number.isFinite(minimumOrderQuantity) || minimumOrderQuantity > purchaseQuantity ||
        !Number.isFinite(currentOrderMultiple) || currentOrderMultiple <= 0 ||
        Math.abs(currentOrderMultiple - orderMultiple) > 0.000001 ||
        Math.abs(purchaseQuantity / orderMultiple - Math.round(purchaseQuantity / orderMultiple)) > 0.000001) {
      skipped.push(suggestion.name + ": supplier minimum order quantity or order multiple has changed.");
      continue;
    }
    const propertyScopeId = item.property_id ?? scopedPropertyId;
    const deliveryLocationId = input.locationId ?? null;
    if (!deliveryLocationId || (!propertyScopeId && !input.locationId)) {
      skipped.push(suggestion.name + ": an explicit purchasing property or authorized central-store location is required.");
      continue;
    }

    const groupKey = suggestion.supplierId + ":" + propertyScopeId + ":" + deliveryLocationId;
    const currency = purchaseCurrency;
    const existing = groups.get(groupKey);
    const line: IntelligentPurchaseOrderLine = {
      inventoryItemId: item.id,
      supplierProductId: product.id,
      unitId,
      stockUnitId: item.unit_id,
      description: item.name,
      quantity: purchaseQuantity,
      recommendedPurchaseQuantity: purchaseQuantity,
      stockUnitsPerPurchaseUnit,
      minimumOrderQuantity: Number(suggestion.minimumOrderQuantity ?? 0),
      orderMultiple: Number(suggestion.orderMultiple ?? 1),
      recommendationEvidence: {
        currentOnHand: suggestion.currentQuantity,
        netAvailable: suggestion.netAvailable ?? null,
        dailyConsumption: suggestion.dailyVelocity,
        demandObservations: suggestion.demandObservations ?? null,
        forecastConfidence: suggestion.forecastConfidence ?? null,
        forecastDemand: suggestion.forecastDemand ?? null,
        safetyStock: suggestion.safetyStock ?? null,
        leadTimeDays: suggestion.leadTimeDays,
        targetCoverageDays: suggestion.coverDays,
        stockPosition: (suggestion.stockPositionEvidence ?? null) as SerializableJson,
        supplierPriceEffectiveDate: suggestion.effectivePriceDate ?? null,
      },
      unitPrice: purchaseUnitPrice,
      estimatedCost: Number((purchaseQuantity * purchaseUnitPrice).toFixed(2)),
      currentQuantity: Number(suggestion.currentQuantity),
      dailyVelocity: Number(suggestion.dailyVelocity),
      leadTimeDays: Number(suggestion.leadTimeDays),
      coverDays: Number(suggestion.coverDays),
    };
    if (!existing)
      groups.set(groupKey, {
        key: groupKey,
        supplierId: supplier.id,
        supplierName: supplier.name,
        propertyId: propertyScopeId,
        locationId: deliveryLocationId,
        currency,
        lines: [line],
        subtotal: line.estimatedCost,
      });
    else {
      existing.lines.push(line);
      existing.subtotal = Number((existing.subtotal + line.estimatedCost).toFixed(2));
    }
  }

  const groupList = [...groups.values()].map((group) => ({
    ...group,
    lines: group.lines.sort((a, b) => b.estimatedCost - a.estimatedCost),
    subtotal: Number(group.subtotal.toFixed(2)),
  }));
  return {
    generatedAt: intelligence.generatedAt,
    windowDays: intelligence.windowDays,
    currency: intelligence.currency,
    groups: groupList,
    skipped,
    suggestionCount: suggestions.length,
    totalEstimatedSpend: Number(
      groupList.reduce((sum, group) => sum + group.subtotal, 0).toFixed(2),
    ),
  };
}

function intelligentPurchaseOrderReference(idempotencyKey: string, groupKey: string) {
  let hash = 2166136261;
  for (const char of groupKey) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return "LEXI-INT-" + idempotencyKey + "-" + (hash >>> 0).toString(16).padStart(8, "0");
}

export async function createIntelligentPurchaseOrders(
  sb: Sb,
  userId: string,
  input: IntelligentPurchaseOrderPlanInput,
) {
  const plan = await previewIntelligentPurchaseOrders(sb, userId, input);
  if (plan.groups.length === 0) {
    throw new Error(
      plan.skipped.length > 0
        ? "No safe purchase-order draft can be created from the current replenishment recommendations."
        : "Purchasing Intelligence has no current replenishment recommendations.",
    );
  }

  const overrideIds = input.lineOverrides.map((row) => row.inventoryItemId);
  if (new Set(overrideIds).size !== overrideIds.length) {
    throw new Error("A manual quantity override may be supplied only once per inventory item.");
  }
  const created = [];
  for (const group of plan.groups) {
    const reference = intelligentPurchaseOrderReference(input.idempotencyKey, group.key);
    const finalLines = group.lines.map((line) => {
      const override = input.lineOverrides.find(
        (item) => item.inventoryItemId === line.inventoryItemId,
      );
      const finalQuantity = override?.quantity ?? line.quantity;
      const orderMultiple = Number(line.orderMultiple ?? 1);
      const minimumOrderQuantity = Number(line.minimumOrderQuantity ?? 0);
      if (!Number.isFinite(finalQuantity) || finalQuantity <= 0 ||
          !Number.isFinite(orderMultiple) || orderMultiple <= 0 ||
          !Number.isFinite(minimumOrderQuantity) || finalQuantity < minimumOrderQuantity ||
          Math.abs(finalQuantity / orderMultiple - Math.round(finalQuantity / orderMultiple)) > 0.000001) {
        throw new Error("Every intelligent PO quantity must satisfy its supplier minimum and configured order multiple.");
      }
      return { ...line, quantity: finalQuantity, overrideApplied: override !== undefined };
    });

    const { data: existing, error: existingError } = await sb
      .from("restaurant_purchase_orders")
      .select(
        "id, document_number, reference, status, supplier_id, property_id, location_id, total, currency, metadata",
      )
      .eq("tenant_id", input.tenantId)
      .eq("reference", reference)
      .maybeSingle();
    if (existingError)
      throw new Error("Unable to verify intelligent PO retry: " + existingError.message);

    if (existing) {
      const { data: existingLines, error: existingLinesError } = await sb
        .from("restaurant_purchase_order_items")
        .select("id, inventory_item_id, supplier_product_id, unit_id, stock_unit_id, stock_units_per_purchase_unit, minimum_order_quantity, order_multiple, quantity, unit_price")
        .eq("tenant_id", input.tenantId)
        .eq("purchase_order_id", existing.id);
      if (existingLinesError)
        throw new Error(
          "Unable to verify existing intelligent PO lines: " + existingLinesError.message,
        );

      const persisted = (existingLines ?? []) as any[];
      const lineMatches =
        persisted.length === finalLines.length &&
        finalLines.every((line) =>
          persisted.some(
            (saved) =>
              saved.inventory_item_id === line.inventoryItemId &&
              saved.supplier_product_id === line.supplierProductId &&
              saved.unit_id === line.unitId &&
              saved.stock_unit_id === line.stockUnitId &&
              Number(saved.stock_units_per_purchase_unit) === Number(line.stockUnitsPerPurchaseUnit) &&
              Number(saved.minimum_order_quantity ?? 0) === Number(line.minimumOrderQuantity ?? 0) &&
              Number(saved.order_multiple ?? 1) === Number(line.orderMultiple ?? 1) &&
              Number(saved.quantity) === Number(line.quantity) &&
              Number(saved.unit_price) === Number(line.unitPrice),
          ),
        );
      if (!lineMatches || existing.supplier_id !== group.supplierId ||
          existing.property_id !== group.propertyId || existing.location_id !== group.locationId ||
          existing.currency !== group.currency ||
          !(existing.metadata as any)?.intelligent_replenishment) {
        throw new Error(
          "An intelligent PO already exists for this request but its persisted lines differ from the current plan. Review the Procurement Centre; the existing order was not changed.",
        );
      }

      created.push({
        id: existing.id as string,
        documentNumber: existing.document_number as string,
        status: existing.status as string,
        supplierName: group.supplierName,
        total: Number(existing.total),
        currency: existing.currency,
        lineCount: finalLines.length,
      });
      continue;
    }

    const po = await createPurchaseOrder(sb, userId, {
      tenantId: input.tenantId,
      propertyId: group.propertyId ?? undefined,
      locationId: group.locationId ?? undefined,
      supplierId: group.supplierId,
      reference,
      currency: group.currency,
      directReason:
        "Prepared by Ask LexiBite from Purchasing Intelligence replenishment recommendations.",
      notes:
        "Draft generated from live Purchasing Intelligence. Quantities come from its replenishment recommendation; supplier prices and pack constraints were revalidated. " +
        (finalLines.some((line) => line.overrideApplied) ? "One or more purchase quantities were manually overridden; see the retained audit metadata." : "No manual quantity overrides were applied."),
      metadata: {
        intelligent_replenishment: {
          engine: "p0-02-stock-position-v1",
          generated_at: plan.generatedAt,
          idempotency_key: input.idempotencyKey,
          lines: finalLines.map((line) => ({
            inventory_item_id: line.inventoryItemId,
            supplier_product_id: line.supplierProductId,
            recommended_purchase_quantity: line.recommendedPurchaseQuantity,
            final_purchase_quantity: line.quantity,
            override_applied: Boolean(line.overrideApplied),
            stock_units_per_purchase_unit: line.stockUnitsPerPurchaseUnit,
            recommendation_evidence: line.recommendationEvidence,
          })),
        },
      },
      lines: finalLines.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        supplierProductId: line.supplierProductId,
        unitId: line.unitId,
        stockUnitId: line.stockUnitId,
        stockUnitsPerPurchaseUnit: line.stockUnitsPerPurchaseUnit,
        minimumOrderQuantity: line.minimumOrderQuantity,
        orderMultiple: line.orderMultiple,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      })),
    });

    const { data: persistedLines, error: persistedError } = await sb
      .from("restaurant_purchase_order_items")
      .select("inventory_item_id, supplier_product_id, unit_id, stock_unit_id, stock_units_per_purchase_unit, minimum_order_quantity, order_multiple, quantity, unit_price")
      .eq("tenant_id", input.tenantId)
      .eq("purchase_order_id", po.id);
    if (persistedError) throw new Error("Unable to verify persisted intelligent PO lines: " + persistedError.message);
    const persistedRows = (persistedLines ?? []) as any[];
    const persistedMatches = persistedRows.length === finalLines.length &&
      finalLines.every((line) => persistedRows.some((saved) =>
        saved.inventory_item_id === line.inventoryItemId &&
        saved.supplier_product_id === line.supplierProductId &&
        saved.unit_id === line.unitId &&
        saved.stock_unit_id === line.stockUnitId &&
        Number(saved.stock_units_per_purchase_unit) === Number(line.stockUnitsPerPurchaseUnit) &&
        Number(saved.minimum_order_quantity ?? 0) === Number(line.minimumOrderQuantity ?? 0) &&
        Number(saved.order_multiple ?? 1) === Number(line.orderMultiple ?? 1) &&
        Number(saved.quantity) === Number(line.quantity) &&
        Number(saved.unit_price) === Number(line.unitPrice),
      ));
    if (!persistedMatches) {
      throw new Error("Persisted intelligent PO lines do not match the approved recommendation and quantity overrides.");
    }

    created.push({
      id: po.id as string,
      documentNumber: po.document_number as string,
      status: po.status as string,
      supplierName: group.supplierName,
      total: Number(po.total),
      currency: po.currency,
      lineCount: group.lines.length,
    });
  }

  return {
    created,
    total: created.reduce((sum, po) => sum + po.total, 0),
    currency: plan.currency,
    skipped: plan.skipped,
  };
}
export const askLexiBitePurchaseOrderTransitionSchema = z.object({
  tenantId: uuid,
  purchaseOrderId: uuid,
  status: z.enum(["submitted", "approved"]),
});
export type AskLexiBitePurchaseOrderTransitionInput = z.infer<
  typeof askLexiBitePurchaseOrderTransitionSchema
>;

export async function transitionAskLexiBitePurchaseOrder(
  sb: Sb,
  userId: string,
  input: AskLexiBitePurchaseOrderTransitionInput,
) {
  const result = await transitionPurchaseOrder(sb, userId, {
    tenantId: input.tenantId,
    id: input.purchaseOrderId,
    status: input.status,
  });
  return {
    id: result.id,
    status: result.status,
    message:
      input.status === "submitted"
        ? "Purchase order " + result.reference + " submitted."
        : "Purchase order " + result.reference + " approved.",
  };
}

export const receiveAskLexiBitePurchaseOrderSchema = z.object({
  tenantId: uuid,
  purchaseOrderId: uuid,
  confirm: z.boolean(),
});
export type ReceiveAskLexiBitePurchaseOrderInput = z.infer<
  typeof receiveAskLexiBitePurchaseOrderSchema
>;

export async function receiveAskLexiBitePurchaseOrder(
  sb: Sb,
  userId: string,
  input: ReceiveAskLexiBitePurchaseOrderInput,
) {
  const { tenantId, purchaseOrderId } = input;
  await assertCapability(sb, userId, tenantId, "receiving.manage");

  const { data: order, error: orderError } = await sb
    .from("restaurant_purchase_orders")
    .select(
      "id, status, supplier_id, property_id, location_id, currency, reference, document_number",
    )
    .eq("tenant_id", tenantId)
    .eq("id", purchaseOrderId)
    .single();
  if (orderError || !order) throw new Error("Purchase order not found.");
  if (!["approved", "partially_received"].includes(order.status)) {
    throw new Error('Purchase order cannot be received from status "' + order.status + '".');
  }

  const [{ data: lines }, { data: items }] = await Promise.all([
    sb
      .from("restaurant_purchase_order_items")
      .select(
        "id, inventory_item_id, unit_id, description, quantity, received_quantity, unit_price",
      )
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", purchaseOrderId),
    sb
      .from("restaurant_inventory_items")
      .select("id, unit_id, property_id, location_id")
      .eq("tenant_id", tenantId),
  ]);

  const itemById = new Map(((items ?? []) as any[]).map((item) => [item.id, item]));
  const outstanding = ((lines ?? []) as any[])
    .map((line) => {
      const item = itemById.get(line.inventory_item_id);
      const quantity = Math.max(
        0,
        Number(line.quantity ?? 0) - Number(line.received_quantity ?? 0),
      );
      return {
        line,
        item,
        quantity,
        storageLocationId: item?.location_id ?? order.location_id ?? null,
      };
    })
    .filter((entry) => entry.quantity > 0);

  if (outstanding.length === 0) {
    return {
      preview: true,
      lines: [],
      orderStatus: order.status,
      message: "There is no outstanding quantity left to receive on this purchase order.",
    };
  }

  const missing = outstanding.find((entry) => !entry.item?.id || !entry.storageLocationId);
  if (missing) {
    throw new Error(
      '"' +
        missing.line.description +
        '": no inventory item or receiving location is configured, so Ask LexiBite cannot safely post the receipt.',
    );
  }

  const previewLines = outstanding.map((entry) => ({
    purchaseOrderItemId: entry.line.id,
    description: entry.line.description,
    quantity: entry.quantity,
  }));

  if (!input.confirm) {
    return {
      preview: true,
      lines: previewLines,
      orderStatus: order.status,
      message:
        "Review the outstanding quantities. Confirm only when the physical delivery matches.",
    };
  }

  const propertyIds = [
    ...new Set(
      outstanding.map((entry) => entry.item?.property_id ?? order.property_id).filter(Boolean),
    ),
  ];
  if (propertyIds.length > 1) {
    throw new Error(
      "The purchase order spans multiple properties; receive it through the Procurement Centre.",
    );
  }

  const result = await createGoodsReceipt(sb, userId, {
    tenantId,
    purchaseOrderId,
    propertyId: propertyIds[0] ?? order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    currency: order.currency ?? "TZS",
    post: true,
    lines: outstanding.map((entry) => ({
      purchaseOrderItemId: entry.line.id,
      inventoryItemId: entry.item.id,
      unitId: entry.line.unit_id ?? entry.item.unit_id ?? undefined,
      storageLocationId: entry.storageLocationId ?? undefined,
      description: entry.line.description,
      orderedQuantity: Number(entry.line.quantity ?? 0),
      receivedQuantity: entry.quantity,
      acceptedQuantity: entry.quantity,
      rejectedQuantity: 0,
      damagedQuantity: 0,
      orderedUnitCost: Number(entry.line.unit_price ?? 0),
      unitCost: Number(entry.line.unit_price ?? 0),
    })),
  });

  return {
    preview: false,
    lines: previewLines,
    orderStatus: "orderStatus" in result ? result.orderStatus : null,
    receiptDocumentNumber: result.documentNumber,
    message:
      "Goods receipt " +
      result.documentNumber +
      " posted. Purchase order status: " +
      ("orderStatus" in result ? result.orderStatus : "updated") +
      ".",
  };
}
