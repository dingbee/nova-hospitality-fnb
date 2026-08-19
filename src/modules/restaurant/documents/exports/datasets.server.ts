/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Dataset exports. These are analysis surfaces, not printable documents: one
 * clean raw-data sheet plus a metadata sheet stating exactly which filters
 * produced it, so a spreadsheet can never be misread as a different period.
 */
import { assertCapability } from "../../core/access.server";
import { nameMap } from "../builders/context.server";
import { fileStem } from "../core/format";
import { documentType, type DocumentTypeId } from "../core/registry";
import type { ExportWorkbook } from "./model";

type Sb = any;
const num = (v: unknown) => Number(v ?? 0);

export interface DatasetInput {
  tenantId: string;
  type: DocumentTypeId;
  propertyId?: string;
  locationId?: string;
  from?: string;
  to?: string;
  limit: number;
}

function range(input: DatasetInput) {
  const to = input.to ?? new Date().toISOString().slice(0, 10);
  const from = input.from ?? new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  return { from, to, fromTs: `${from}T00:00:00.000Z`, toTs: `${to}T23:59:59.999Z` };
}

export async function buildDataset(sb: Sb, userId: string, input: DatasetInput): Promise<ExportWorkbook> {
  const def = documentType(input.type);
  if (!def) throw new Error(`Unknown export "${input.type}".`);
  await assertCapability(sb, userId, input.tenantId, def.capability);

  const { from, to, fromTs, toTs } = range(input);
  const [tenantName, locations] = await Promise.all([
    sb
      .from("restaurant_tenants")
      .select("name")
      .eq("id", input.tenantId)
      .maybeSingle()
      .then((r: any) => r.data?.name ?? null),
    nameMap(sb, "restaurant_locations", input.tenantId),
  ]);

  const base = {
    type: input.type,
    title: def.label,
    metadata: {
      generatedAt: new Date().toISOString(),
      tenant: tenantName,
      outlet: input.locationId ? (locations.get(input.locationId) ?? null) : null,
      dateRange: `${from} to ${to}`,
      source: def.sourceTable ?? null,
      filters: { From: from, To: to, Location: input.locationId ? (locations.get(input.locationId) ?? "") : "All" },
    },
  };

  if (input.type === "stock_ledger" || input.type === "waste_report") {
    const items = await nameMap(sb, "restaurant_inventory_items", input.tenantId);
    let q = sb
      .from("restaurant_stock_movements")
      .select(
        "occurred_at, movement_type, inventory_item_id, location_id, destination_location_id, quantity, unit_cost, total_cost, currency, balance_after, reason, reason_code, reference_type, reference_id, notes",
      )
      .eq("tenant_id", input.tenantId)
      .gte("occurred_at", fromTs)
      .lte("occurred_at", toTs)
      .order("occurred_at", { ascending: false })
      .limit(input.limit);
    if (input.locationId) q = q.eq("location_id", input.locationId);
    if (input.type === "waste_report") q = q.eq("movement_type", "waste");
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as any[]).map((m) => ({
      occurred_at: m.occurred_at,
      movement_type: m.movement_type,
      item: items.get(m.inventory_item_id) ?? "",
      location: locations.get(m.location_id) ?? "",
      destination: m.destination_location_id ? (locations.get(m.destination_location_id) ?? "") : "",
      quantity: num(m.quantity),
      unit_cost: num(m.unit_cost),
      total_cost: num(m.total_cost),
      currency: m.currency ?? "",
      balance_after: m.balance_after == null ? null : num(m.balance_after),
      reason: m.reason_code ?? m.reason ?? "",
      reference_type: m.reference_type ?? "",
      reference_id: m.reference_id ?? "",
      notes: m.notes ?? "",
    }));
    return {
      ...base,
      fileStem: fileStem([input.type, from, to]),
      metadata: { ...base.metadata, rowCount: rows.length },
      sheets: [
        {
          name: input.type === "waste_report" ? "Waste" : "Ledger",
          columns: [
            { key: "occurred_at", label: "Occurred At", format: "datetime" },
            { key: "movement_type", label: "Movement Type" },
            { key: "item", label: "Item" },
            { key: "location", label: "Location" },
            { key: "destination", label: "Destination" },
            { key: "quantity", label: "Quantity", format: "number" },
            { key: "unit_cost", label: "Unit Cost", format: "money" },
            { key: "total_cost", label: "Total Cost", format: "money" },
            { key: "currency", label: "Currency" },
            { key: "balance_after", label: "Balance After", format: "number" },
            { key: "reason", label: "Reason" },
            { key: "reference_type", label: "Reference Type" },
            { key: "reference_id", label: "Reference ID" },
            { key: "notes", label: "Notes" },
          ],
          rows,
        },
      ],
    };
  }

  if (input.type === "inventory_valuation") {
    let q = sb
      .from("restaurant_inventory_items")
      .select("sku, name, item_type, location_id, current_quantity, par_level, reorder_point, average_cost, currency, status")
      .eq("tenant_id", input.tenantId)
      .order("name")
      .limit(input.limit);
    if (input.locationId) q = q.eq("location_id", input.locationId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as any[]).map((i) => ({
      sku: i.sku ?? "",
      name: i.name,
      item_type: i.item_type ?? "",
      location: locations.get(i.location_id) ?? "Unassigned",
      quantity: num(i.current_quantity),
      par_level: i.par_level == null ? null : num(i.par_level),
      reorder_point: i.reorder_point == null ? null : num(i.reorder_point),
      average_cost: num(i.average_cost),
      value: num(i.current_quantity) * num(i.average_cost),
      currency: i.currency ?? "",
      status: i.status ?? "",
    }));
    return {
      ...base,
      fileStem: fileStem(["inventory-valuation", to]),
      metadata: { ...base.metadata, dateRange: `As at ${to}`, rowCount: rows.length },
      sheets: [
        {
          name: "Valuation",
          columns: [
            { key: "sku", label: "SKU" },
            { key: "name", label: "Item" },
            { key: "item_type", label: "Type" },
            { key: "location", label: "Location" },
            { key: "quantity", label: "Quantity", format: "number" },
            { key: "par_level", label: "Par Level", format: "number" },
            { key: "reorder_point", label: "Reorder Point", format: "number" },
            { key: "average_cost", label: "Average Cost", format: "money" },
            { key: "value", label: "Stock Value", format: "money" },
            { key: "currency", label: "Currency" },
            { key: "status", label: "Status" },
          ],
          rows,
        },
      ],
    };
  }

  if (input.type === "sales_report") {
    let ordersQ = sb
      .from("restaurant_orders")
      .select("id, order_number, order_type, status, opened_at, closed_at, currency, location_id")
      .eq("tenant_id", input.tenantId)
      .gte("opened_at", fromTs)
      .lte("opened_at", toTs)
      .limit(input.limit);
    if (input.locationId) ordersQ = ordersQ.eq("location_id", input.locationId);
    const { data: orders, error } = await ordersQ;
    if (error) throw new Error(error.message);
    const list = (orders ?? []) as any[];
    const byId = new Map(list.map((o) => [o.id, o]));
    const { data: items } = list.length
      ? await sb
          .from("restaurant_order_items")
          .select(
            "order_id, description, quantity, unit_price, discount, service_charge_amount, tax_amount, line_total, line_cost, status, is_comp, price_source, channel, seat_number, created_at",
          )
          .eq("tenant_id", input.tenantId)
          .in("order_id", [...byId.keys()])
      : { data: [] };
    const rows = ((items ?? []) as any[]).map((l) => {
      const o = byId.get(l.order_id) ?? {};
      return {
        order_number: o.order_number ?? "",
        order_type: o.order_type ?? "",
        opened_at: o.opened_at ?? l.created_at,
        location: locations.get(o.location_id) ?? "",
        description: l.description,
        quantity: num(l.quantity),
        unit_price: num(l.unit_price),
        gross: num(l.quantity) * num(l.unit_price),
        discount: num(l.discount),
        service_charge: num(l.service_charge_amount),
        tax: num(l.tax_amount),
        net: num(l.line_total),
        cost: num(l.line_cost),
        margin: num(l.line_total) - num(l.line_cost),
        status: l.status ?? "",
        comp: l.is_comp ? "YES" : "NO",
        price_source: l.price_source ?? "",
        channel: l.channel ?? "",
        currency: o.currency ?? "",
      };
    });
    return {
      ...base,
      fileStem: fileStem(["sales", from, to]),
      metadata: { ...base.metadata, rowCount: rows.length },
      sheets: [
        {
          name: "Sales Lines",
          columns: [
            { key: "order_number", label: "Order" },
            { key: "order_type", label: "Order Type" },
            { key: "opened_at", label: "Opened At", format: "datetime" },
            { key: "location", label: "Location" },
            { key: "description", label: "Item" },
            { key: "quantity", label: "Quantity", format: "number" },
            { key: "unit_price", label: "Unit Price", format: "money" },
            { key: "gross", label: "Gross", format: "money" },
            { key: "discount", label: "Discount", format: "money" },
            { key: "service_charge", label: "Service Charge", format: "money" },
            { key: "tax", label: "Tax", format: "money" },
            { key: "net", label: "Net", format: "money" },
            { key: "cost", label: "Cost", format: "money" },
            { key: "margin", label: "Margin", format: "money" },
            { key: "status", label: "Status" },
            { key: "comp", label: "Comp" },
            { key: "price_source", label: "Price Source" },
            { key: "channel", label: "Channel" },
            { key: "currency", label: "Currency" },
          ],
          rows,
        },
      ],
    };
  }

  if (input.type === "payment_reconciliation") {
    let ordersQ = sb
      .from("restaurant_orders")
      .select("id, order_number, total, paid_total, payment_state, currency, location_id, closed_at")
      .eq("tenant_id", input.tenantId)
      .gte("opened_at", fromTs)
      .lte("opened_at", toTs)
      .limit(input.limit);
    if (input.locationId) ordersQ = ordersQ.eq("location_id", input.locationId);
    const { data: orders, error } = await ordersQ;
    if (error) throw new Error(error.message);
    const list = (orders ?? []) as any[];
    const byId = new Map(list.map((o) => [o.id, o]));
    const { data: payments } = list.length
      ? await sb
          .from("restaurant_payments")
          .select("order_id, method, state, amount, tendered, change_due, currency, reference, captured_at")
          .eq("tenant_id", input.tenantId)
          .in("order_id", [...byId.keys()])
      : { data: [] };

    const tender = ((payments ?? []) as any[]).map((p) => {
      const o = byId.get(p.order_id) ?? {};
      return {
        captured_at: p.captured_at ?? "",
        order_number: o.order_number ?? "",
        method: p.method,
        state: p.state,
        amount: num(p.amount),
        tendered: num(p.tendered),
        change_due: num(p.change_due),
        reference: p.reference ?? "",
        currency: p.currency ?? o.currency ?? "",
      };
    });

    const summary = new Map<string, { count: number; amount: number }>();
    for (const t of tender.filter((t) => t.state !== "voided")) {
      const e = summary.get(t.method) ?? { count: 0, amount: 0 };
      summary.set(t.method, { count: e.count + 1, amount: e.amount + t.amount });
    }

    const outstanding = list
      .filter((o) => num(o.paid_total) + 0.001 < num(o.total))
      .map((o) => ({
        order_number: o.order_number,
        total: num(o.total),
        paid: num(o.paid_total),
        outstanding: num(o.total) - num(o.paid_total),
        payment_state: o.payment_state,
        currency: o.currency ?? "",
      }));

    return {
      ...base,
      fileStem: fileStem(["payments", from, to]),
      metadata: { ...base.metadata, rowCount: tender.length },
      sheets: [
        {
          name: "By Method",
          columns: [
            { key: "method", label: "Method" },
            { key: "count", label: "Payments", format: "integer" },
            { key: "amount", label: "Amount", format: "money" },
          ],
          rows: [...summary.entries()].map(([method, v]) => ({ method, count: v.count, amount: v.amount })),
        },
        {
          name: "Payments",
          columns: [
            { key: "captured_at", label: "Captured At", format: "datetime" },
            { key: "order_number", label: "Order" },
            { key: "method", label: "Method" },
            { key: "state", label: "State" },
            { key: "amount", label: "Amount", format: "money" },
            { key: "tendered", label: "Tendered", format: "money" },
            { key: "change_due", label: "Change", format: "money" },
            { key: "reference", label: "Reference" },
            { key: "currency", label: "Currency" },
          ],
          rows: tender,
        },
        {
          name: "Outstanding",
          columns: [
            { key: "order_number", label: "Order" },
            { key: "total", label: "Total", format: "money" },
            { key: "paid", label: "Paid", format: "money" },
            { key: "outstanding", label: "Outstanding", format: "money" },
            { key: "payment_state", label: "Payment State" },
            { key: "currency", label: "Currency" },
          ],
          rows: outstanding,
        },
      ],
    };
  }

  throw new Error(
    `${def.label} has no dataset exporter yet. Open ${def.workflowRoute ?? "the workflow screen"} to work with the records directly.`,
  );
}