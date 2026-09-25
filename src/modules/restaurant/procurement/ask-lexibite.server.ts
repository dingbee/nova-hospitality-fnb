/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import { assertCapability, getTenantScope, resolveMultiPropertyScope } from "../core/access.server";
import type { NovaIntentContract } from "../understand/intent.contracts";
import { getPurchasingIntelligence } from "../intelligence/purchasing.server";
import { resolveTenantCurrency } from "../prepare/resolve.server";
import { createPurchaseOrder, transitionPurchaseOrder } from "../purchasing/purchasing.server";
import { createGoodsReceipt } from "./receiving.server";

type Sb = any;
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
    throw new Error("A specific supplier is required before Ask LexiBite can create a purchase order.");
  }
  if (contract.supplier.status !== "exact" && contract.supplier.status !== "high") {
    throw new Error("The supplier could not be resolved confidently enough to create the order.");
  }

  await assertCapability(sb, userId, tenantId, "purchasing.manage");
  await assertCapability(sb, userId, tenantId, "purchasing.approve");

  const entities = contract.entities.filter(
    (entity) =>
      (entity.status === "exact" || entity.status === "high") &&
      Boolean(entity.resolvedId),
  );
  if (entities.length === 0) throw new Error("At least one identified inventory item is required.");

  const itemIds = entities.map((entity) => entity.resolvedId!);
  const [{ data: items }, { data: products }] = await Promise.all([
    sb
      .from("restaurant_inventory_items")
      .select("id, name, unit_id, property_id, location_id, currency")
      .eq("tenant_id", tenantId)
      .in("id", itemIds),
    sb
      .from("restaurant_supplier_products")
      .select("id, supplier_id, inventory_item_id, unit_id, unit_price, active")
      .eq("tenant_id", tenantId)
      .eq("supplier_id", contract.supplier.resolvedId)
      .in("inventory_item_id", itemIds),
  ]);

  const itemById = new Map(((items ?? []) as any[]).map((item) => [item.id, item]));
  const productByItem = new Map<string, any>();
  for (const product of (products ?? []) as any[]) {
    if (product.active === false) continue;
    const previous = productByItem.get(product.inventory_item_id);
    if (!previous || Number(product.unit_price ?? 0) < Number(previous.unit_price ?? 0)) {
      productByItem.set(product.inventory_item_id, product);
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
    if (!item) throw new Error("Inventory item was not found: " + (entity.resolvedName ?? entity.raw) + ".");
    const quantity = entity.quantity?.quantity ?? null;
    if (quantity == null || quantity <= 0) {
      throw new Error("Quantity is required for " + item.name + " before creating the purchase order.");
    }

    const product = productByItem.get(item.id);
    if (!product) {
      throw new Error("No active supplier price is configured for " + item.name + " from the selected supplier.");
    }

    const requestedUnitId = entity.quantity?.resolvedUnitId ?? null;
    const purchaseUnitId = product.unit_id ?? item.unit_id ?? null;
    if (requestedUnitId && purchaseUnitId && requestedUnitId !== purchaseUnitId) {
      throw new Error("The requested unit for " + item.name + " does not match the supplier's configured purchase unit.");
    }
    if (!purchaseUnitId) throw new Error("No purchase unit is configured for " + item.name + ".");

    lines.push({
      inventoryItemId: item.id,
      supplierProductId: product.id,
      unitId: purchaseUnitId,
      description: item.name,
      quantity,
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
  supplierId: uuid.nullable().optional(),
  idempotencyKey: uuid,
  lineOverrides: z
    .array(z.object({ inventoryItemId: uuid, quantity: z.number().positive().max(100000) }))
    .max(25)
    .default([]),
});
export type IntelligentPurchaseOrderPlanInput = z.infer<typeof intelligentPurchaseOrderPlanInputSchema>;

export interface IntelligentPurchaseOrderLine {
  inventoryItemId: string;
  supplierProductId: string;
  unitId: string;
  description: string;
  quantity: number;
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
  const propertyId = await resolveMultiPropertyScope(sb, tenantId, scope, null);
  const intelligence = await getPurchasingIntelligence(sb, userId, {
    tenantId, windowDays: 30, propertyId,
  });

  const requestedIds = new Set(input.inventoryItemIds);
  let suggestions = intelligence.suggestions;
  if (requestedIds.size > 0) suggestions = suggestions.filter((x) => requestedIds.has(x.inventoryItemId));
  if (input.supplierId) suggestions = suggestions.filter((x) => x.supplierId === input.supplierId);

  const itemIds = suggestions.map((x) => x.inventoryItemId);
  if (itemIds.length === 0) return {
    generatedAt: intelligence.generatedAt, windowDays: intelligence.windowDays, currency: intelligence.currency,
    groups: [], skipped: [], suggestionCount: 0, totalEstimatedSpend: 0,
  };

  const [{ data: items, error: itemError }, { data: products, error: productError }, { data: suppliers, error: supplierError }] = await Promise.all([
    sb.from("restaurant_inventory_items").select("id, name, unit_id, property_id, location_id, currency").eq("tenant_id", tenantId).in("id", itemIds),
    sb.from("restaurant_supplier_products").select("id, supplier_id, inventory_item_id, unit_id, unit_price, active").eq("tenant_id", tenantId).in("inventory_item_id", itemIds),
    sb.from("restaurant_suppliers").select("id, name").eq("tenant_id", tenantId),
  ]);
  if (itemError) throw new Error("Unable to validate replenishment inventory: " + itemError.message);
  if (productError) throw new Error("Unable to validate supplier pricing: " + productError.message);
  if (supplierError) throw new Error("Unable to validate suppliers: " + supplierError.message);

  const itemById = new Map(((items ?? []) as any[]).map((x) => [x.id, x]));
  const supplierById = new Map(((suppliers ?? []) as any[]).map((x) => [x.id, x]));
  const productByKey = new Map<string, any>();
  for (const product of (products ?? []) as any[]) {
    if (product.active === false || !product.supplier_id || !product.inventory_item_id) continue;
    const key = product.supplier_id + ":" + product.inventory_item_id;
    const previous = productByKey.get(key);
    if (!previous || Number(product.unit_price ?? 0) < Number(previous.unit_price ?? 0)) productByKey.set(key, product);
  }

  const skipped: string[] = [];
  const groups = new Map<string, IntelligentPurchaseOrderGroup>();
  for (const suggestion of suggestions) {
    if (!suggestion.supplierId) { skipped.push(suggestion.name + ": Purchasing Intelligence has no supplier selected."); continue; }
    const item = itemById.get(suggestion.inventoryItemId);
    if (!item) { skipped.push(suggestion.name + ": inventory item could not be revalidated."); continue; }
    const product = productByKey.get(suggestion.supplierId + ":" + suggestion.inventoryItemId);
    if (!product) { skipped.push(suggestion.name + ": no active supplier price is currently configured."); continue; }
    const unitId = product.unit_id ?? item.unit_id ?? null;
    if (!unitId) { skipped.push(suggestion.name + ": no purchase unit is configured."); continue; }
    const supplier = supplierById.get(suggestion.supplierId);
    if (!supplier) { skipped.push(suggestion.name + ": selected supplier could not be revalidated."); continue; }

    const groupKey = suggestion.supplierId + ":" + (item.property_id ?? "tenant") + ":" + (item.location_id ?? "unassigned");
    const currency = item.currency ?? intelligence.currency;
    const existing = groups.get(groupKey);
    const line: IntelligentPurchaseOrderLine = {
      inventoryItemId: item.id, supplierProductId: product.id, unitId, description: item.name,
      quantity: Number(suggestion.recommendedQuantity), unitPrice: Number(product.unit_price ?? 0),
      estimatedCost: Number((Number(suggestion.recommendedQuantity) * Number(product.unit_price ?? 0)).toFixed(2)),
      currentQuantity: Number(suggestion.currentQuantity), dailyVelocity: Number(suggestion.dailyVelocity),
      leadTimeDays: Number(suggestion.leadTimeDays), coverDays: Number(suggestion.coverDays),
    };
    if (!existing) groups.set(groupKey, {
      key: groupKey, supplierId: supplier.id, supplierName: supplier.name,
      propertyId: item.property_id ?? null, locationId: item.location_id ?? null, currency,
      lines: [line], subtotal: line.estimatedCost,
    });
    else { existing.lines.push(line); existing.subtotal = Number((existing.subtotal + line.estimatedCost).toFixed(2)); }
  }

  const groupList = [...groups.values()].map((group) => ({
    ...group, lines: group.lines.sort((a, b) => b.estimatedCost - a.estimatedCost), subtotal: Number(group.subtotal.toFixed(2)),
  }));
  return {
    generatedAt: intelligence.generatedAt, windowDays: intelligence.windowDays, currency: intelligence.currency,
    groups: groupList, skipped, suggestionCount: suggestions.length,
    totalEstimatedSpend: Number(groupList.reduce((sum, group) => sum + group.subtotal, 0).toFixed(2)),
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

export async function createIntelligentPurchaseOrders(sb: Sb, userId: string, input: IntelligentPurchaseOrderPlanInput) {
  const plan = await previewIntelligentPurchaseOrders(sb, userId, input);
  if (plan.groups.length === 0) {
    throw new Error(
      plan.skipped.length > 0
        ? "No safe purchase-order draft can be created from the current replenishment recommendations."
        : "Purchasing Intelligence has no current replenishment recommendations.",
    );
  }

  const created = [];
  for (const group of plan.groups) {
    const reference = intelligentPurchaseOrderReference(input.idempotencyKey, group.key);
    const { data: existing } = await sb
      .from("restaurant_purchase_orders")
      .select("id, document_number, reference, status, supplier_id, property_id, location_id, total, currency")
      .eq("tenant_id", input.tenantId)
      .eq("reference", reference)
      .maybeSingle();

    if (existing) {
      const { data: existingLines } = await sb
        .from("restaurant_purchase_order_items")
        .select("id")
        .eq("tenant_id", input.tenantId)
        .eq("purchase_order_id", existing.id);

      if ((existingLines ?? []).length !== group.lines.length || existing.supplier_id !== group.supplierId) {
        throw new Error(
          "An incomplete intelligent PO already exists for this request. Review the Procurement Centre before retrying.",
        );
      }

      created.push({
        id: existing.id as string,
        documentNumber: existing.document_number as string,
        status: existing.status as string,
        supplierName: group.supplierName,
        total: Number(existing.total),
        currency: existing.currency,
        lineCount: group.lines.length,
      });
      continue;
    }

    const override = input.lineOverrides.find((item) => item.inventoryItemId === line.inventoryItemId);
    const finalQuantity = override?.quantity ?? line.quantity;
    if (!Number.isFinite(finalQuantity) || finalQuantity <= 0) {
      throw new Error("Every intelligent PO line must have a positive quantity.");
    }

    const po = await createPurchaseOrder(sb, userId, {
      tenantId: input.tenantId,
      propertyId: group.propertyId ?? undefined,
      locationId: group.locationId ?? undefined,
      supplierId: group.supplierId,
      reference,
      currency: group.currency,
      directReason: "Prepared by Ask LexiBite from Purchasing Intelligence replenishment recommendations.",
      notes: "Draft generated from live Purchasing Intelligence. Quantities come from its replenishment recommendation; supplier prices were revalidated against the live supplier catalogue.",
      lines: group.lines.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        supplierProductId: line.supplierProductId,
        unitId: line.unitId,
        description: line.description,
        quantity: finalQuantity,
        unitPrice: line.unitPrice,
      })),
    });

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
export type AskLexiBitePurchaseOrderTransitionInput = z.infer<typeof askLexiBitePurchaseOrderTransitionSchema>;

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
export type ReceiveAskLexiBitePurchaseOrderInput = z.infer<typeof receiveAskLexiBitePurchaseOrderSchema>;

export async function receiveAskLexiBitePurchaseOrder(
  sb: Sb,
  userId: string,
  input: ReceiveAskLexiBitePurchaseOrderInput,
) {
  const { tenantId, purchaseOrderId } = input;
  await assertCapability(sb, userId, tenantId, "receiving.manage");

  const { data: order, error: orderError } = await sb
    .from("restaurant_purchase_orders")
    .select("id, status, supplier_id, property_id, location_id, currency, reference, document_number")
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
      .select("id, inventory_item_id, unit_id, description, quantity, received_quantity, unit_price")
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
      '"' + missing.line.description + '": no inventory item or receiving location is configured, so Ask LexiBite cannot safely post the receipt.',
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
      message: "Review the outstanding quantities. Confirm only when the physical delivery matches.",
    };
  }

  const propertyIds = [
    ...new Set(
      outstanding
        .map((entry) => entry.item?.property_id ?? order.property_id)
        .filter(Boolean),
    ),
  ];
  if (propertyIds.length > 1) {
    throw new Error("The purchase order spans multiple properties; receive it through the Procurement Centre.");
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
    orderStatus: result.orderStatus,
    receiptDocumentNumber: result.documentNumber,
    message: "Goods receipt " + result.documentNumber + " posted. Purchase order status: " + result.orderStatus + ".",
  };
}
