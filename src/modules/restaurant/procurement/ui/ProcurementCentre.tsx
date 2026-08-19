/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Procurement Centre — the lifecycle, stage by stage.
 *
 * Each stage is its own surface because they are different questions:
 * what we need, what was ordered, what arrived, what we were billed for,
 * and where reality diverged.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatCard } from "@/components/os/StatCard";
import { StatusChip } from "@/components/os/StatusChip";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import { SupplierInvoiceSheet } from "./SupplierInvoiceSheet";
import { DocumentActions } from "../../documents/ui/DocumentActions";
import { formatMoney, formatQty, lifecycleBadge, VARIANCE_LABELS } from "../lifecycle";
import {
  convertRestaurantRequestToOrderFn,
  createRestaurantGoodsReceiptFn,
  listRestaurantGoodsReceiptsFn,
  listRestaurantProcurementAuditFn,
  listRestaurantProcurementVariancesFn,
  listRestaurantPurchaseRequestsFn,
  listRestaurantSupplierInvoicesFn,
  matchRestaurantSupplierInvoiceFn,
  postRestaurantGoodsReceiptFn,
  resolveRestaurantProcurementVarianceFn,
  restaurantProcurementOverviewFn,
  restaurantSupplierPerformanceFn,
  saveRestaurantPurchaseRequestFn,
  setRestaurantInvoicePaymentStatusFn,
  transitionRestaurantPurchaseRequestFn,
} from "../procurement.functions";
import {
  getRestaurantPurchaseOrderDetailFn,
  listRestaurantPurchaseOrdersFn,
} from "../../purchasing/purchasing.functions";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "requests", label: "Requests" },
  { id: "receiving", label: "Receiving" },
  { id: "invoices", label: "Invoices" },
  { id: "variances", label: "Variances" },
  { id: "suppliers", label: "Supplier performance" },
  { id: "audit", label: "Audit trail" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Chip({ status }: { status?: string | null }) {
  const b = lifecycleBadge(status);
  return <StatusChip tone={b.tone}>{b.label}</StatusChip>;
}

/** Touch-first row: generous target height, no hover-only affordances. */
function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex flex-wrap items-center justify-between gap-3 py-3 min-h-14">{children}</li>;
}

export function ProcurementCentre({ initialTab }: { initialTab?: string } = {}) {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const [tab, setTab] = useState<TabId>(
    (TABS.some((t) => t.id === initialTab) ? (initialTab as TabId) : "overview"),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Procurement Centre"
        description="Need → request → approval → order → supplier confirmation → delivery → acceptance → inventory → invoice → payment. Each stage is recorded separately."
      />
      <nav className="flex flex-wrap gap-1 rounded-lg border bg-card p-1 text-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`min-h-11 rounded px-4 py-2 ${
              tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {!tenantId ? (
        <SectionCard title="No restaurant workspace">
          <EmptyState title="No tenant" description="Set up a restaurant tenant to use procurement." />
        </SectionCard>
      ) : tab === "overview" ? (
        <OverviewTab tenantId={tenantId} />
      ) : tab === "requests" ? (
        <RequestsTab tenantId={tenantId} />
      ) : tab === "receiving" ? (
        <ReceivingTab tenantId={tenantId} />
      ) : tab === "invoices" ? (
        <InvoicesTab tenantId={tenantId} />
      ) : tab === "variances" ? (
        <VariancesTab tenantId={tenantId} />
      ) : tab === "suppliers" ? (
        <SuppliersTab tenantId={tenantId} />
      ) : (
        <AuditTab tenantId={tenantId} />
      )}
    </div>
  );
}

/* ---------------- Overview ---------------- */

function OverviewTab({ tenantId }: { tenantId: string }) {
  const fn = useServerFn(restaurantProcurementOverviewFn);
  const q = useQuery({
    queryKey: ["restaurant.procurement.overview", tenantId],
    queryFn: () => fn({ data: { tenantId } }),
  });
  const o = q.data as any;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Awaiting approval" value={String(o?.needed?.awaitingApproval ?? 0)} hint={`${o?.needed?.draft ?? 0} draft requests`} />
        <StatCard label="Open orders" value={String(o?.ordered?.open ?? 0)} hint={`${o?.ordered?.overdue ?? 0} past expected date`} />
        <StatCard label="Accepted into stock" value={formatMoney(o?.received?.acceptedValue ?? 0)} hint={`${o?.received?.draft ?? 0} receipts not posted`} />
        <StatCard label="Outstanding to suppliers" value={formatMoney(o?.invoiced?.outstandingValue ?? 0)} hint={`${o?.invoiced?.overdue ?? 0} overdue invoices`} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <SectionCard title="Lifecycle position" description="Distinct stages, deliberately not collapsed into one status.">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[
              ["Needed (approved, not ordered)", `${o?.needed?.approved ?? 0} · ${formatMoney(o?.needed?.approvedValue ?? 0)}`],
              ["Awaiting supplier confirmation", String(o?.ordered?.awaitingConfirmation ?? 0)],
              ["Open order value", formatMoney(o?.ordered?.openValue ?? 0)],
              ["Receipts posted", String(o?.received?.posted ?? 0)],
              ["Invoices matched", String(o?.invoiced?.matched ?? 0)],
              ["Invoices mismatched", String(o?.invoiced?.mismatched ?? 0)],
            ].map(([k, v]) => (
              <div key={k as string} className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="mt-1 font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>
        <SectionCard title="Control" description="Discrepancies are recorded and resolved by a person, never auto-approved.">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Open variances</div>
              <div className="mt-1 text-2xl font-semibold">{o?.variances?.open ?? 0}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">High severity</div>
              <div className="mt-1 text-2xl font-semibold">{o?.variances?.high ?? 0}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Escalated</div>
              <div className="mt-1 text-2xl font-semibold">{o?.variances?.escalated ?? 0}</div>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

/* ---------------- Requests ---------------- */

function RequestsTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listRestaurantPurchaseRequestsFn);
  const saveFn = useServerFn(saveRestaurantPurchaseRequestFn);
  const transitionFn = useServerFn(transitionRestaurantPurchaseRequestFn);
  const convertFn = useServerFn(convertRestaurantRequestToOrderFn);

  const q = useQuery({
    queryKey: ["restaurant.procurement.requests", tenantId],
    queryFn: () => listFn({ data: { tenantId, limit: 100 } }),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.procurement.requests", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.procurement.overview", tenantId] });
  };

  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitCost, setUnitCost] = useState("0");
  const [reason, setReason] = useState("");

  const save = useAdminMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          priority: "normal",
          currency: "TZS",
          reason: reason || undefined,
          lines: [
            {
              description,
              quantity: Number(quantity) || 0,
              estimatedUnitCost: Number(unitCost) || 0,
            },
          ],
        },
      }),
    successMessage: "Purchase request drafted",
    loadingMessage: "Creating request…",
    onSuccess: () => {
      setDescription("");
      setQuantity("1");
      setUnitCost("0");
      setReason("");
      invalidate();
    },
  });

  const transition = useAdminMutation({
    mutationFn: (vars: { id: string; action: "submit" | "approve" | "reject" | "cancel"; reason?: string }) =>
      transitionFn({ data: { tenantId, ...vars } }),
    successMessage: "Request updated",
    onSuccess: invalidate,
  });

  const convert = useAdminMutation({
    mutationFn: (vars: { requestId: string; supplierId: string }) =>
      convertFn({ data: { tenantId, ...vars } }),
    successMessage: "Purchase order created from request",
    onSuccess: invalidate,
  });

  // Converting a request needs a supplier; the performance list is the tenant's supplier set.
  const fnPerf = useServerFn(restaurantSupplierPerformanceFn);
  const suppliersQuery = useQuery({
    queryKey: ["restaurant.procurement.performance", tenantId, 90],
    queryFn: () => fnPerf({ data: { tenantId, sinceDays: 90 } }),
  });
  const firstSupplier = (suppliersQuery.data as any[] | undefined)?.[0]?.supplierId as string | undefined;

  return (
    <div className="space-y-4">
      <SectionCard title="Raise a need" description="A request records what the business needs. It is not an order.">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="md:col-span-2">
            <Label htmlFor="pr-desc">What is needed</Label>
            <Input id="pr-desc" className="mt-1 h-11" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Beef fillet, 5kg boxes" />
          </div>
          <div>
            <Label htmlFor="pr-qty">Quantity</Label>
            <Input id="pr-qty" className="mt-1 h-11" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pr-cost">Est. unit cost</Label>
            <Input id="pr-cost" className="mt-1 h-11" inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
          </div>
          <div className="md:col-span-3">
            <Label htmlFor="pr-reason">Why</Label>
            <Textarea id="pr-reason" className="mt-1" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Operational justification" />
          </div>
          <div className="flex items-end">
            <Button className="h-11 w-full" disabled={!description || save.isPending} onClick={() => save.mutate()}>
              Create draft
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Purchase requests">
        {(q.data as any[] | undefined)?.length ? (
          <ul className="divide-y text-sm">
            {(q.data as any[]).map((r) => (
              <Row key={r.id}>
                <div className="min-w-0">
                  <div className="font-medium">{r.document_number}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatMoney(r.estimated_total, r.currency)} · {r.priority} · {r.reason ?? "no reason given"}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip status={r.status} />
                  {r.status === "draft" && (
                    <Button size="sm" className="h-10" onClick={() => transition.mutate({ id: r.id, action: "submit" })}>
                      Submit
                    </Button>
                  )}
                  {r.status === "submitted" && (
                    <>
                      <Button size="sm" className="h-10" onClick={() => transition.mutate({ id: r.id, action: "approve" })}>
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-10"
                        onClick={() => {
                          const why = window.prompt("Reason for rejection");
                          if (why) transition.mutate({ id: r.id, action: "reject", reason: why });
                        }}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                  {r.status === "approved" && firstSupplier && (
                    <Button size="sm" className="h-10" onClick={() => convert.mutate({ requestId: r.id, supplierId: firstSupplier })}>
                      Create order
                    </Button>
                  )}
                </div>
              </Row>
            ))}
          </ul>
        ) : (
          <EmptyState title="No purchase requests" description="Raise a need above to start the procurement lifecycle." />
        )}
      </SectionCard>
    </div>
  );
}

/* ---------------- Receiving ---------------- */

interface LineEdit {
  received: string;
  accepted: string;
  rejected: string;
  unitCost: string;
  batchCode: string;
  expiryDate: string;
}

function ReceivingTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listRestaurantGoodsReceiptsFn);
  const postFn = useServerFn(postRestaurantGoodsReceiptFn);
  const createFn = useServerFn(createRestaurantGoodsReceiptFn);
  const listOrdersFn = useServerFn(listRestaurantPurchaseOrdersFn);
  const orderDetailFn = useServerFn(getRestaurantPurchaseOrderDetailFn);

  const q = useQuery({
    queryKey: ["restaurant.procurement.receipts", tenantId],
    queryFn: () => listFn({ data: { tenantId, limit: 100 } }),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.procurement.receipts", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.procurement.overview", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.procurement.variances", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.purchasing.orders", tenantId] });
  };

  const post = useAdminMutation({
    mutationFn: (id: string) => postFn({ data: { tenantId, id } }),
    successMessage: "Receipt posted — accepted quantities entered stock",
    onSuccess: invalidate,
  });

  /* --- Receiving against a purchase order (the three-way match chain) --- */
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [edits, setEdits] = useState<Record<string, LineEdit>>({});
  const [overReceiptReason, setOverReceiptReason] = useState("");

  const ordersQ = useQuery({
    queryKey: ["restaurant.purchasing.orders", tenantId, "receivable"],
    queryFn: () => listOrdersFn({ data: { tenantId, limit: 100 } }),
  });
  const receivableOrders = useMemo(
    () =>
      ((ordersQ.data as any[]) ?? []).filter((o) =>
        ["submitted", "approved", "partially_received"].includes(String(o.status)),
      ),
    [ordersQ.data],
  );

  const detailQ = useQuery({
    queryKey: ["restaurant.purchasing.order", tenantId, purchaseOrderId],
    queryFn: () => orderDetailFn({ data: { tenantId, id: purchaseOrderId } }),
    enabled: Boolean(purchaseOrderId),
  });
  const detail = detailQ.data as any | undefined;
  const orderLines: any[] = useMemo(() => (detail?.items as any[]) ?? [], [detail]);

  const lineEdit = (item: any): LineEdit =>
    edits[item.id] ?? {
      received: String(item.quantity ?? 0),
      accepted: String(item.quantity ?? 0),
      rejected: "0",
      unitCost: String(item.unit_price ?? 0),
      batchCode: "",
      expiryDate: "",
    };
  const setLineEdit = (id: string, patch: Partial<LineEdit>, base: LineEdit) =>
    setEdits((prev) => ({ ...prev, [id]: { ...base, ...patch } }));

  const hasOverReceipt = orderLines.some(
    (i) => (Number(lineEdit(i).received) || 0) > Number(i.quantity ?? 0) + 0.0001,
  );

  const receiveAgainstOrder = useAdminMutation({
    mutationFn: () =>
      createFn({
        data: {
          tenantId,
          purchaseOrderId,
          supplierId: detail?.order?.supplier_id ?? undefined,
          propertyId: detail?.order?.property_id ?? undefined,
          locationId: detail?.order?.location_id ?? undefined,
          deliveryNoteRef: deliveryNote || undefined,
          currency: detail?.order?.currency ?? "TZS",
          post: false,
          overReceiptReason: hasOverReceipt ? overReceiptReason : undefined,
          lines: orderLines.map((i) => {
            const e = lineEdit(i);
            return {
              purchaseOrderItemId: i.id,
              inventoryItemId: i.inventory_item_id ?? undefined,
              unitId: i.unit_id ?? undefined,
              description: i.description,
              orderedQuantity: Number(i.quantity ?? 0),
              receivedQuantity: Number(e.received) || 0,
              acceptedQuantity: Number(e.accepted) || 0,
              rejectedQuantity: Number(e.rejected) || 0,
              damagedQuantity: 0,
              orderedUnitCost: Number(i.unit_price ?? 0),
              unitCost: Number(e.unitCost) || 0,
              batchCode: e.batchCode || undefined,
              expiryDate: e.expiryDate || undefined,
            };
          }),
        },
      }),
    successMessage: "Delivery recorded against the purchase order",
    onSuccess: () => {
      setEdits({});
      setOverReceiptReason("");
      setDeliveryNote("");
      invalidate();
    },
  });

  const [description, setDescription] = useState("");
  const [received, setReceived] = useState("0");
  const [accepted, setAccepted] = useState("0");
  const [rejected, setRejected] = useState("0");
  const [unitCost, setUnitCost] = useState("0");
  const [rejectionReason, setRejectionReason] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");

  const create = useAdminMutation({
    mutationFn: () =>
      createFn({
        data: {
          tenantId,
          deliveryNoteRef: deliveryNote || undefined,
          currency: "TZS",
          post: false,
          lines: [
            {
              description,
              orderedQuantity: 0,
              receivedQuantity: Number(received) || 0,
              acceptedQuantity: Number(accepted) || 0,
              rejectedQuantity: Number(rejected) || 0,
              damagedQuantity: 0,
              orderedUnitCost: 0,
              unitCost: Number(unitCost) || 0,
              rejectionReason: rejectionReason || undefined,
            },
          ],
        },
      }),
    successMessage: "Delivery recorded",
    onSuccess: () => {
      setDescription("");
      setReceived("0");
      setAccepted("0");
      setRejected("0");
      setUnitCost("0");
      setRejectionReason("");
      setDeliveryNote("");
      invalidate();
    },
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="Receive against a purchase order"
        description="Receiving a delivery against its order is what makes the three-way match possible. Ordered quantities and prices come from the order; what actually arrived is yours to enter."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label htmlFor="gr-po">Purchase order</Label>
            <select
              id="gr-po"
              className="mt-1 h-11 w-full rounded-md border bg-background px-3 text-sm"
              value={purchaseOrderId}
              onChange={(e) => {
                setPurchaseOrderId(e.target.value);
                setEdits({});
              }}
            >
              <option value="">Select an issued order…</option>
              {receivableOrders.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.document_number ?? o.reference} · {o.supplier_name ?? "Supplier"} · {o.status}
                </option>
              ))}
            </select>
            {!receivableOrders.length && (
              <p className="mt-1 text-xs text-muted-foreground">
                No issued orders awaiting delivery. Issue an order from Purchasing first.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="gr-po-note">Delivery note ref</Label>
            <Input
              id="gr-po-note"
              className="mt-1 h-11"
              value={deliveryNote}
              onChange={(e) => setDeliveryNote(e.target.value)}
            />
          </div>
        </div>

        {purchaseOrderId && orderLines.length > 0 && (
          <div className="mt-4 space-y-3">
            {orderLines.map((i) => {
              const e = lineEdit(i);
              const over = (Number(e.received) || 0) > Number(i.quantity ?? 0) + 0.0001;
              return (
                <div key={i.id} className="rounded-lg border p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{i.description}</span>
                    <span className="text-xs text-muted-foreground">
                      Ordered {formatQty(i.quantity)} @ {formatMoney(i.unit_price, detail?.order?.currency)}
                    </span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
                    <div>
                      <Label htmlFor={`r-${i.id}`}>Received</Label>
                      <Input
                        id={`r-${i.id}`}
                        className="mt-1 h-11"
                        inputMode="decimal"
                        value={e.received}
                        onChange={(ev) => setLineEdit(i.id, { received: ev.target.value }, e)}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`a-${i.id}`}>Accepted</Label>
                      <Input
                        id={`a-${i.id}`}
                        className="mt-1 h-11"
                        inputMode="decimal"
                        value={e.accepted}
                        onChange={(ev) => setLineEdit(i.id, { accepted: ev.target.value }, e)}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`x-${i.id}`}>Rejected</Label>
                      <Input
                        id={`x-${i.id}`}
                        className="mt-1 h-11"
                        inputMode="decimal"
                        value={e.rejected}
                        onChange={(ev) => setLineEdit(i.id, { rejected: ev.target.value }, e)}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`c-${i.id}`}>Invoiced unit cost</Label>
                      <Input
                        id={`c-${i.id}`}
                        className="mt-1 h-11"
                        inputMode="decimal"
                        value={e.unitCost}
                        onChange={(ev) => setLineEdit(i.id, { unitCost: ev.target.value }, e)}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`b-${i.id}`}>Lot / batch code</Label>
                      <Input
                        id={`b-${i.id}`}
                        className="mt-1 h-11"
                        value={e.batchCode}
                        onChange={(ev) => setLineEdit(i.id, { batchCode: ev.target.value }, e)}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`e-${i.id}`}>Expiry</Label>
                      <Input
                        id={`e-${i.id}`}
                        type="date"
                        className="mt-1 h-11"
                        value={e.expiryDate}
                        onChange={(ev) => setLineEdit(i.id, { expiryDate: ev.target.value }, e)}
                      />
                    </div>
                  </div>
                  {over && (
                    <p className="mt-2 text-xs text-destructive">
                      More than ordered — this needs purchasing approval and a written reason.
                    </p>
                  )}
                </div>
              );
            })}

            {hasOverReceipt && (
              <div>
                <Label htmlFor="gr-over">Over-receipt reason (required, min 10 characters)</Label>
                <Textarea
                  id="gr-over"
                  className="mt-1"
                  value={overReceiptReason}
                  onChange={(ev) => setOverReceiptReason(ev.target.value)}
                />
              </div>
            )}

            <Button
              className="h-11"
              disabled={receiveAgainstOrder.isPending || (hasOverReceipt && overReceiptReason.trim().length < 10)}
              onClick={() => receiveAgainstOrder.mutate()}
            >
              Record delivery against order
            </Button>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Record a delivery"
        description="Unlinked delivery, for goods that arrived without a purchase order. Received, accepted and rejected are separate facts. Only accepted quantities enter inventory, and only when you post."
      >
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          <div className="lg:col-span-2">
            <Label htmlFor="gr-desc">Item delivered</Label>
            <Input id="gr-desc" className="mt-1 h-11" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="gr-recv">Received</Label>
            <Input id="gr-recv" className="mt-1 h-11" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="gr-acc">Accepted</Label>
            <Input id="gr-acc" className="mt-1 h-11" inputMode="decimal" value={accepted} onChange={(e) => setAccepted(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="gr-rej">Rejected</Label>
            <Input id="gr-rej" className="mt-1 h-11" inputMode="decimal" value={rejected} onChange={(e) => setRejected(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="gr-cost">Unit cost</Label>
            <Input id="gr-cost" className="mt-1 h-11" inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
          </div>
          <div className="lg:col-span-2">
            <Label htmlFor="gr-note">Delivery note ref</Label>
            <Input id="gr-note" className="mt-1 h-11" value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} />
          </div>
          <div className="lg:col-span-3">
            <Label htmlFor="gr-why">Rejection reason (required if anything is refused)</Label>
            <Input id="gr-why" className="mt-1 h-11" value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button className="h-11 w-full" disabled={!description || create.isPending} onClick={() => create.mutate()}>
              Save delivery
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Goods receipts">
        {(q.data as any[] | undefined)?.length ? (
          <ul className="divide-y text-sm">
            {(q.data as any[]).map((r) => (
              <Row key={r.id}>
                <div className="min-w-0">
                  <div className="font-medium">{r.document_number}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(r.received_at).toLocaleDateString()} · accepted {formatMoney(r.accepted_value, r.currency)}
                    {r.delivery_note_ref ? ` · DN ${r.delivery_note_ref}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Chip status={r.status} />
                  {r.status === "draft" && (
                    <Button size="sm" className="h-10" disabled={post.isPending} onClick={() => post.mutate(r.id)}>
                      Post to stock
                    </Button>
                  )}
                  <DocumentActions tenantId={tenantId} type="goods_receipt" recordId={r.id} documentNumber={r.document_number} />
                </div>
              </Row>
            ))}
          </ul>
        ) : (
          <EmptyState title="No deliveries recorded" description="Record a delivery when goods physically arrive." />
        )}
      </SectionCard>
    </div>
  );
}

/* ---------------- Invoices ---------------- */

function InvoicesTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listRestaurantSupplierInvoicesFn);
  const matchFn = useServerFn(matchRestaurantSupplierInvoiceFn);
  const payFn = useServerFn(setRestaurantInvoicePaymentStatusFn);

  const q = useQuery({
    queryKey: ["restaurant.procurement.invoices", tenantId],
    queryFn: () => listFn({ data: { tenantId, limit: 100 } }),
  });
  const [entryOpen, setEntryOpen] = useState(false);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.procurement.invoices", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.procurement.overview", tenantId] });
  };

  const match = useAdminMutation({
    mutationFn: (invoiceId: string) => matchFn({ data: { tenantId, invoiceId } }),
    onSuccessToast: (d: any) => `Three-way match: ${String(d?.matchStatus ?? "checked").replace(/_/g, " ")}`,
    onSuccess: invalidate,
  });
  const pay = useAdminMutation({
    mutationFn: (vars: { invoiceId: string; paymentStatus: "paid" | "partially_paid" | "disputed"; reason?: string }) =>
      payFn({ data: { tenantId, ...vars } }),
    successMessage: "Payment status updated",
    onSuccess: invalidate,
  });

  return (
    <SectionCard
      title="Supplier invoices"
      description="Matched against the order and the goods actually accepted."
      actions={
        <Button size="sm" className="h-10" onClick={() => setEntryOpen(true)}>
          Record invoice
        </Button>
      }
    >
      {(q.data as any[] | undefined)?.length ? (
        <ul className="divide-y text-sm">
          {(q.data as any[]).map((i) => (
            <Row key={i.id}>
              <div className="min-w-0">
                <div className="font-medium">
                  {i.supplier_invoice_number} <span className="text-muted-foreground">· {i.supplier_name}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatMoney(i.total, i.currency)} · due {i.due_date ?? "—"} · paid {formatMoney(i.amount_paid, i.currency)}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Chip status={i.match_status} />
                <Chip status={i.payment_status} />
                <Button size="sm" variant="outline" className="h-10" onClick={() => match.mutate(i.id)}>
                  Re-match
                </Button>
                {i.payment_status !== "paid" && (
                  <Button
                    size="sm"
                    className="h-10"
                    onClick={() => {
                      const reason =
                        i.match_status === "mismatched"
                          ? window.prompt("This invoice does not match. Reason for paying anyway?") ?? undefined
                          : undefined;
                      if (i.match_status === "mismatched" && !reason) return;
                      pay.mutate({ invoiceId: i.id, paymentStatus: "paid", reason });
                    }}
                  >
                    Mark paid
                  </Button>
                )}
              </div>
            </Row>
          ))}
        </ul>
      ) : (
        <EmptyState title="No supplier invoices" description="Invoices appear here once recorded against a supplier." />
      )}
      <SupplierInvoiceSheet open={entryOpen} onOpenChange={setEntryOpen} tenantId={tenantId} />
    </SectionCard>
  );
}

/* ---------------- Variances ---------------- */

function VariancesTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listRestaurantProcurementVariancesFn);
  const resolveFn = useServerFn(resolveRestaurantProcurementVarianceFn);
  const q = useQuery({
    queryKey: ["restaurant.procurement.variances", tenantId],
    queryFn: () => listFn({ data: { tenantId, limit: 100 } }),
  });
  const resolve = useAdminMutation({
    mutationFn: (vars: { id: string; status: "accepted" | "resolved" | "escalated"; notes?: string }) =>
      resolveFn({ data: { tenantId, ...vars } }),
    successMessage: "Variance decision recorded",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.variances", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.overview", tenantId] });
    },
  });

  return (
    <SectionCard title="Variance control" description="Every discrepancy is recorded. A person decides what happens next.">
      {(q.data as any[] | undefined)?.length ? (
        <ul className="divide-y text-sm">
          {(q.data as any[]).map((v) => (
            <Row key={v.id}>
              <div className="min-w-0">
                <div className="font-medium">{v.label}</div>
                <div className="text-xs text-muted-foreground">
                  {VARIANCE_LABELS[v.variance_type] ?? v.variance_type} · expected {formatQty(v.expected_value)} · actual{" "}
                  {formatQty(v.actual_value)}
                  {v.variance_pct != null ? ` · ${Number(v.variance_pct).toFixed(1)}%` : ""}
                  {v.supplier_name ? ` · ${v.supplier_name}` : ""}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Chip status={v.severity} />
                <Chip status={v.status} />
                {v.status === "open" && (
                  <>
                    <Button size="sm" variant="outline" className="h-10" onClick={() => resolve.mutate({ id: v.id, status: "accepted" })}>
                      Accept
                    </Button>
                    <Button size="sm" className="h-10" onClick={() => resolve.mutate({ id: v.id, status: "resolved" })}>
                      Resolve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-10"
                      onClick={() => {
                        const notes = window.prompt("Escalation note") ?? undefined;
                        resolve.mutate({ id: v.id, status: "escalated", notes });
                      }}
                    >
                      Escalate
                    </Button>
                  </>
                )}
              </div>
            </Row>
          ))}
        </ul>
      ) : (
        <EmptyState title="No variances" description="Orders, deliveries and invoices currently agree." />
      )}
    </SectionCard>
  );
}

/* ---------------- Supplier performance ---------------- */

function SuppliersTab({ tenantId }: { tenantId: string }) {
  const fn = useServerFn(restaurantSupplierPerformanceFn);
  const q = useQuery({
    queryKey: ["restaurant.procurement.performance", tenantId, 90],
    queryFn: () => fn({ data: { tenantId, sinceDays: 90 } }),
  });
  const rows = useMemo(() => ((q.data as any[]) ?? []).filter((r) => r.orders > 0 || r.receipts > 0), [q.data]);

  return (
    <SectionCard
      title="Supplier performance"
      description="Evidence from the last 90 days. The Intelligence Core interprets this; procurement only reports it."
    >
      {rows.length === 0 ? (
        <EmptyState title="No supplier history yet" description="Performance builds up as orders are received." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2">Supplier</th>
                <th>Orders</th>
                <th>Fulfilment</th>
                <th>Rejected</th>
                <th>Price drift</th>
                <th>On time</th>
                <th>Open variances</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.supplierId} className="h-14">
                  <td className="py-2 font-medium">{r.supplierName}</td>
                  <td>{r.orders}</td>
                  <td>{r.fulfilmentRate == null ? "—" : `${(r.fulfilmentRate * 100).toFixed(0)}%`}</td>
                  <td>{r.rejectionRate == null ? "—" : `${(r.rejectionRate * 100).toFixed(1)}%`}</td>
                  <td>{r.averagePriceVariancePct == null ? "—" : `${r.averagePriceVariancePct}%`}</td>
                  <td>
                    {r.onTimeReceipts}/{r.receipts}
                  </td>
                  <td>{r.openVariances}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

/* ---------------- Audit ---------------- */

function AuditTab({ tenantId }: { tenantId: string }) {
  const fn = useServerFn(listRestaurantProcurementAuditFn);
  const q = useQuery({
    queryKey: ["restaurant.procurement.audit", tenantId],
    queryFn: () => fn({ data: { tenantId, limit: 150 } }),
  });

  return (
    <SectionCard title="Audit trail" description="Append-only. Procurement history is added to, never rewritten.">
      {(q.data as any[] | undefined)?.length ? (
        <ul className="divide-y text-sm">
          {(q.data as any[]).map((a) => (
            <Row key={a.id}>
              <div className="min-w-0">
                <div className="font-medium">
                  {a.document_number ?? a.document_type} · {a.action.replace(/_/g, " ")}
                </div>
                <div className="text-xs text-muted-foreground">
                  {a.previous_state ? `${a.previous_state} → ` : ""}
                  {a.new_state ?? "—"}
                  {a.reason ? ` · ${a.reason}` : ""}
                </div>
              </div>
              <span className="text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString()}</span>
            </Row>
          ))}
        </ul>
      ) : (
        <EmptyState title="No activity yet" description="Procurement actions will be recorded here." />
      )}
    </SectionCard>
  );
}
