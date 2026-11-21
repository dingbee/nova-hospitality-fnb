/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Main Store Management workspace.
 *
 * Shown when the tenant's central store is configured and active. Every
 * figure comes from the canonical ledger and procurement records via
 * getMainStoreOverviewFn; every action calls the existing governed services
 * (goods receiving, transfer receipt/close). There is no separate store
 * inventory here.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatCard } from "@/components/os/StatCard";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import { hasRestaurantCapability } from "../../core/permissions";
import { formatDateTime, formatMoney, formatQuantity } from "../../ui/presentation";
import { getMainStoreOverviewFn } from "../control.functions";
import { TransferReceiveForm } from "./TransferReceiveForm";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "stock", label: "Stock position" },
  { id: "incoming", label: "Incoming orders" },
  { id: "receiving", label: "Goods receiving" },
  { id: "transfers", label: "Transfers" },
  { id: "movements", label: "Movement history" },
  { id: "suppliers", label: "Supplier deliveries" },
  { id: "exceptions", label: "Exceptions" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const SEVERITY_TONE: Record<string, StatusTone> = { high: "danger", medium: "warning", low: "info" };

export function MainStoreWorkspace() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const roles = ws.data?.roles ?? [];
  const platformAdmin = Boolean(ws.data?.platformAdmin);
  const canTransfer = hasRestaurantCapability(roles, "transfer.manage", platformAdmin);
  const canApproveTransfers = hasRestaurantCapability(roles, "transfer.approve", platformAdmin);
  const canAdjust = hasRestaurantCapability(roles, "inventory.manage", platformAdmin);
  const [tab, setTab] = useState<TabId>("overview");
  const [receivingTransfer, setReceivingTransfer] = useState<string | null>(null);

  const fn = useServerFn(getMainStoreOverviewFn);
  const q = useQuery({
    queryKey: ["restaurant.main-store", tenantId],
    queryFn: () => fn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
  });
  const data = q.data as any;

  if (q.isError) {
    return (
      <SectionCard title="Main Store unavailable">
        <p className="text-sm text-muted-foreground">{(q.error as Error).message}</p>
      </SectionCard>
    );
  }
  if (!data) return <p className="text-sm text-muted-foreground">Loading Main Store…</p>;
  if (!data.active) {
    return (
      <div className="space-y-4">
        <PageHeader title="Main Store" description="Tenant central store management." />
        <EmptyState
          title={
            data.status.resolution === "not_configured"
              ? "No Main Store configured"
              : `Main Store is ${data.status.resolution}`
          }
          description={
            data.status.detail ??
            "Configure an active tenant-wide main store in Setup to enable central purchasing."
          }
        />
      </div>
    );
  }

  const currency = data.stock[0]?.currency ?? "TZS";
  const highExceptions = (data.exceptions as any[]).filter((e) => e.severity === "high").length;
  const inTransitIn = (data.incomingTransfers as any[]).reduce(
    (s: number, t: any) => s + t.lines.reduce((a: number, l: any) => a + l.inTransit, 0),
    0,
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Main Store — ${data.status.name}`}
        description="Tenant central store: procurement destination for every property, allocated to properties through stock transfers."
      />

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Main Store sections">
        {TABS.map((t) => (
          <Button
            key={t.id}
            size="sm"
            role="tab"
            aria-selected={tab === t.id}
            variant={tab === t.id ? "default" : "outline"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "exceptions" && data.exceptions.length > 0 ? ` (${data.exceptions.length})` : ""}
          </Button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Stock value" value={formatMoney(data.valuation, currency)} />
            <StatCard label="Open purchase orders" value={String(data.incomingOrders.length)} />
            <StatCard label="Units in transit to store" value={formatQuantity(inTransitIn)} />
            <StatCard label="High-severity exceptions" value={String(highExceptions)} />
          </div>
          <SectionCard
            title="Reconciliation"
            description="Posted goods-receipt value against the stock-ledger purchase receipts at this store."
          >
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <StatusChip tone={data.reconciliation.reconciled ? "success" : "danger"}>
                {data.reconciliation.reconciled ? "Reconciled" : "Mismatch"}
              </StatusChip>
              <span>
                {data.reconciliation.postedReceipts} posted receipts · GRN accepted{" "}
                {formatMoney(data.reconciliation.grnAcceptedValue, currency)} · ledger{" "}
                {formatMoney(data.reconciliation.ledgerReceiptValue, currency)}
              </span>
            </div>
          </SectionCard>
          <SectionCard title="Property allocation" description="Stock sent from the Main Store, by destination.">
            {data.allocation.length === 0 ? (
              <EmptyState title="No allocations yet" description="Dispatch a transfer from the Main Store to a property store." />
            ) : (
              <ul className="divide-y text-sm">
                {data.allocation.map((a: any) => (
                  <li key={a.destination} className="flex justify-between py-2">
                    <span>{a.destination}</span>
                    <span className="text-muted-foreground">
                      {a.transfers} transfer(s) · {formatMoney(a.value, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      )}

      {tab === "stock" && (
        <SectionCard
          title="Stock position"
          description="On hand at the Main Store from the stock ledger. Adjustments are made through the authorised adjustment workflow."
          actions={
            canAdjust ? (
              <Link to="/admin/restaurant/inventory-control" search={{ tab: "waste" }} className="text-sm underline">
                Record an authorised adjustment
              </Link>
            ) : undefined
          }
        >
          {data.stock.length === 0 ? (
            <EmptyState title="No stock at the Main Store" description="Receive a purchase order or a transfer into the Main Store." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2">Item</th>
                    <th className="py-2 text-right">On hand</th>
                    <th className="py-2 text-right">Available</th>
                    <th className="py-2 text-right">Avg cost</th>
                    <th className="py-2 text-right">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.stock.map((p: any) => (
                    <tr key={p.itemId}>
                      <td className="py-2">
                        {p.name} {p.low && <StatusChip tone="warning">Low</StatusChip>}
                      </td>
                      <td className="py-2 text-right">{formatQuantity(p.onHand)}</td>
                      <td className="py-2 text-right">{formatQuantity(p.available)}</td>
                      <td className="py-2 text-right">{formatMoney(p.averageCost, p.currency)}</td>
                      <td className="py-2 text-right">{formatMoney(p.value, p.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}

      {tab === "incoming" && (
        <SectionCard
          title="Incoming purchase orders"
          description="Orders destined for the Main Store. Only approved orders can be received."
          actions={
            <Link to="/admin/restaurant/purchasing" className="text-sm underline">
              Open purchasing
            </Link>
          }
        >
          {data.incomingOrders.length === 0 ? (
            <EmptyState title="No open orders" description="Raise a purchase order; it is delivered to the Main Store by default." />
          ) : (
            <ul className="divide-y text-sm">
              {data.incomingOrders.map((o: any) => (
                <li key={o.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{o.reference}</span>
                    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <StatusChip tone={o.status === "submitted" ? "warning" : "info"}>
                        {o.status === "submitted" ? "Submitted — awaiting approval" : o.status}
                      </StatusChip>
                      {o.supplier ?? "No supplier"}
                      {o.supplierStatus && o.supplierStatus !== "active" ? ` (${o.supplierStatus})` : ""} ·{" "}
                      {formatMoney(o.total, o.currency)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Raised by {o.raisedBy ?? "—"}
                    {o.approvedBy ? ` · approved by ${o.approvedBy}` : ""}
                    {o.expectedAt ? ` · expected ${o.expectedAt}` : ""}
                  </p>
                  <ul className="text-xs">
                    {o.lines.map((l: any) => (
                      <li key={l.id} className="flex justify-between gap-2">
                        <span>{l.description}</span>
                        <span className="text-muted-foreground">
                          ordered {formatQuantity(l.ordered)} · received {formatQuantity(l.received)} · accepted{" "}
                          {formatQuantity(l.accepted)} · rejected {formatQuantity(l.rejected)} · outstanding{" "}
                          {formatQuantity(l.outstanding)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "receiving" && (
        <SectionCard
          title="Goods receiving"
          description="Supplier deliveries received at the Main Store. Accepted quantities post to the ledger once; rejected and damaged quantities never enter stock."
          actions={
            <Link to="/admin/restaurant/procurement" search={{ tab: "receiving" }} className="text-sm underline">
              Receive a delivery
            </Link>
          }
        >
          {data.receipts.length === 0 ? (
            <EmptyState title="No receipts yet" description="Receive an approved order from the Procurement Centre." />
          ) : (
            <ul className="divide-y text-sm">
              {data.receipts.map((r: any) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium">{r.reference}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r.supplier ?? "Supplier"} · received {r.receivedAt ? formatDateTime(r.receivedAt) : "—"} by{" "}
                      {r.receivedBy ?? "—"}
                      {r.postedBy ? ` · posted by ${r.postedBy}` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-xs">
                    <StatusChip tone={r.status === "posted" ? "success" : "warning"}>{r.status}</StatusChip>
                    {formatMoney(r.acceptedValue, r.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "transfers" && (
        <>
          <SectionCard
            title="Incoming transfers"
            description="Stock dispatched to the Main Store. It is credited only when an authorised receiver verifies what arrived."
          >
            {data.incomingTransfers.length === 0 ? (
              <EmptyState title="Nothing in transit to the Main Store" description="Transfers dispatched to the Main Store appear here." />
            ) : (
              <ul className="divide-y text-sm">
                {data.incomingTransfers.map((t: any) => (
                  <li key={t.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {t.reference} · {t.source} → {t.destination}
                      </span>
                      <StatusChip tone="warning">{t.status}</StatusChip>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Dispatched {t.dispatchedAt ? formatDateTime(t.dispatchedAt) : "—"} by {t.dispatchedBy ?? "—"}
                    </p>
                    <ul className="text-xs">
                      {t.lines.map((l: any) => (
                        <li key={l.id} className="flex justify-between gap-2">
                          <span>{l.item}</span>
                          <span className="text-muted-foreground">
                            dispatched {formatQuantity(l.dispatched)} · received {formatQuantity(l.received)} · rejected{" "}
                            {formatQuantity(l.rejected)} · damaged {formatQuantity(l.damaged)} · in transit{" "}
                            {formatQuantity(l.inTransit)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {canTransfer && ["dispatched", "partially_received"].includes(t.status) && (
                      receivingTransfer === t.id ? (
                        <TransferReceiveForm
                          tenantId={tenantId!}
                          transferId={t.id}
                          canClose={canApproveTransfers}
                          invalidateKeys={[["restaurant.main-store", tenantId]]}
                          onDone={() => setReceivingTransfer(null)}
                          lines={t.lines.map((l: any) => ({
                            id: l.id,
                            label: l.item,
                            dispatched: l.dispatched,
                            received: l.received,
                            rejected: l.rejected,
                            damaged: l.damaged,
                          }))}
                        />
                      ) : (
                        <Button size="sm" onClick={() => setReceivingTransfer(t.id)}>
                          Receive & verify
                        </Button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          <SectionCard
            title="Outgoing transfers"
            description="Allocations from the Main Store to property stores."
            actions={
              <Link to="/admin/restaurant/inventory-control" search={{ tab: "transfers" }} className="text-sm underline">
                New transfer
              </Link>
            }
          >
            {data.outgoingTransfers.length === 0 ? (
              <EmptyState title="No open outgoing transfers" description="Create a transfer from the Main Store to a property store." />
            ) : (
              <ul className="divide-y text-sm">
                {data.outgoingTransfers.map((t: any) => (
                  <li key={t.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>
                      {t.reference} · {t.source} → {t.destination}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      <StatusChip tone="info">{t.status}</StatusChip>{" "}
                      in transit {formatQuantity(t.lines.reduce((s: number, l: any) => s + l.inTransit, 0))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          {data.recentTransfers.length > 0 && (
            <SectionCard title="Closed transfers">
              <ul className="divide-y text-sm">
                {data.recentTransfers.map((t: any) => (
                  <li key={t.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>
                      {t.reference} · {t.source} → {t.destination}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t.status} · received by {t.receivedBy ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}
        </>
      )}

      {tab === "movements" && (
        <SectionCard title="Stock movement history" description="The latest ledger entries at the Main Store.">
          {data.movements.length === 0 ? (
            <EmptyState title="No movements yet" description="Ledger entries at the Main Store appear here." />
          ) : (
            <ul className="divide-y text-sm">
              {data.movements.map((m: any) => (
                <li key={m.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>
                    {m.item} · {m.type}
                    <span className="block text-xs text-muted-foreground">
                      {m.reason ?? ""} · {formatDateTime(m.occurredAt)} · by {m.by ?? "—"}
                      {m.approvedBy ? ` · approved by ${m.approvedBy}` : ""}
                    </span>
                  </span>
                  <span className={m.quantity < 0 ? "text-[color:var(--os-danger)]" : ""}>
                    {m.quantity > 0 ? "+" : ""}
                    {formatQuantity(m.quantity)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "suppliers" && (
        <SectionCard title="Supplier delivery performance" description="Posted deliveries into the Main Store.">
          {data.supplierPerformance.length === 0 ? (
            <EmptyState title="No supplier deliveries yet" description="Posted receipts build supplier performance." />
          ) : (
            <ul className="divide-y text-sm">
              {data.supplierPerformance.map((p: any) => (
                <li key={p.supplier} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>{p.supplier}</span>
                  <span className="text-xs text-muted-foreground">
                    {p.deliveries} deliveries ·{" "}
                    {p.dated > 0 ? `${Math.round((p.onTime / p.dated) * 100)}% on time` : "no expected dates"} ·{" "}
                    {formatMoney(p.acceptedValue, currency)} accepted · {p.openVariances} open variance(s)
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "exceptions" && (
        <SectionCard title="Exceptions & unresolved discrepancies">
          {data.exceptions.length === 0 ? (
            <EmptyState title="No exceptions" description="Procurement, transfers and the ledger are consistent." />
          ) : (
            <ul className="divide-y text-sm">
              {data.exceptions.map((e: any, i: number) => (
                <li key={`${e.kind}:${e.entityId ?? i}:${i}`} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium">{e.reference}</span>
                    <span className="block text-xs text-muted-foreground">{e.message}</span>
                  </span>
                  <StatusChip tone={SEVERITY_TONE[e.severity] ?? "neutral"}>{e.kind.replaceAll("_", " ")}</StatusChip>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
    </div>
  );
}
