/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import { assertCapability, getTenantScope, resolveMultiPropertyScope } from "../core/access.server";
import type { NovaIntentContract } from "../understand/intent.contracts";
import { resolveTenantCurrency } from "../prepare/resolve.server";
import { createPurchaseOrder, transitionPurchaseOrder } from "./purchasing.server";
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
