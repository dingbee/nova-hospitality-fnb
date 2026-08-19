/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Inventory Centre — multi-location stock control.
 *
 * The screen is organised around the four numbers that matter and are never
 * blended: on hand, reserved, available, incoming. Every mutating surface here
 * writes through the ledger; nothing edits a balance directly.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatCard } from "@/components/os/StatCard";
import { StatusChip } from "@/components/os/StatusChip";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import { BatchSheet } from "./BatchSheet";
import { stocktakeBadge, transferBadge, type StockPosition } from "../contracts";
import {
  approveStockTransferFn,
  createStockTransferFn,
  dispatchStockTransferFn,
  getInventoryOverviewFn,
  getStockTransferFn,
  getStocktakeFn,
  listInventoryBatchesFn,
  listInventoryLocationsFn,
  listInventoryReasonsFn,
  listInventoryReconciliationFn,
  listStockPositionsFn,
  listStockReservationsFn,
  listStockTransfersFn,
  listStocktakesFn,
  postStocktakeFn,
  receiveStockTransferFn,
  recordInventoryAdjustmentFn,
  recordInventoryWasteFn,
  saveStocktakeCountsFn,
  startStocktakeFn,
} from "../control.functions";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "positions", label: "Stock positions" },
  { id: "transfers", label: "Transfers" },
  { id: "waste", label: "Waste & adjustments" },
  { id: "stocktake", label: "Stocktakes" },
  { id: "batches", label: "Batches & expiry" },
  { id: "locations", label: "Locations" },
  { id: "reconciliation", label: "Reconciliation" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const money = (n: number, currency = "TZS") =>
  `${currency} ${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const qty = (n: number) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 3 });

function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-3">{children}</li>;
}

export function InventoryCentre({ initialTab }: { initialTab?: string } = {}) {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const [tab, setTab] = useState<TabId>(
    (TABS.some((t) => t.id === initialTab) ? (initialTab as TabId) : "overview"),
  );

  if (!ws.isLoading && !ws.data?.tenant) {
    return <EmptyState title="No restaurant tenant" description="You are not a member of a Restaurant & Bar OS tenant." />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inventory Centre"
        description="Item → location → position → ledger → transfer → waste → stocktake → valuation. On hand, reserved, available and incoming are tracked as four separate numbers."
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
        <SectionCard title="Loading">
          <p className="text-sm text-muted-foreground">Resolving workspace…</p>
        </SectionCard>
      ) : (
        <>
          {tab === "overview" && <OverviewTab tenantId={tenantId} />}
          {tab === "positions" && <PositionsTab tenantId={tenantId} />}
          {tab === "transfers" && <TransfersTab tenantId={tenantId} />}
          {tab === "waste" && <WasteTab tenantId={tenantId} />}
          {tab === "stocktake" && <StocktakeTab tenantId={tenantId} />}
          {tab === "batches" && <BatchesTab tenantId={tenantId} />}
          {tab === "locations" && <LocationsTab tenantId={tenantId} />}
          {tab === "reconciliation" && <ReconciliationTab tenantId={tenantId} />}
        </>
      )}
    </div>
  );
}

/* ---------------- Overview ---------------- */

function OverviewTab({ tenantId }: { tenantId: string }) {
  const fn = useServerFn(getInventoryOverviewFn);
  const q = useQuery({
    queryKey: ["restaurant.inventory.overview", tenantId],
    queryFn: () => fn({ data: { tenantId } }),
  });
  const o = q.data;
  if (!o) return <SectionCard title="Inventory position"><p className="text-sm text-muted-foreground">Loading…</p></SectionCard>;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Stock value" value={money(o.totalStockValue, o.currency)} />
        <StatCard label="Below reorder" value={String(o.itemsBelowReorder)} tone={o.itemsBelowReorder > 0 ? "warn" : "green"} />
        <StatCard label="Out of stock" value={String(o.criticalItems)} tone={o.criticalItems > 0 ? "warn" : "green"} />
        <StatCard label="Storage locations" value={String(o.locations)} />
        <StatCard label="Transfers in flight" value={String(o.transfersPending)} />
        <StatCard label="Incoming units" value={qty(o.incomingToday)} />
        <StatCard label="Expiring within 7 days" value={String(o.expiringSoon)} tone={o.expiringSoon > 0 ? "warn" : "green"} />
        <StatCard label="Waste (7 days)" value={money(o.recentWasteValue, o.currency)} tone={o.recentWasteValue > 0 ? "warn" : "green"} />
      </div>
      <SectionCard
        title="How stock changes here"
        description="Balances are derived from the movement ledger. Transfers, waste, adjustments and stocktakes all post movements — none of them writes a balance directly, which is why the reconciliation tab should always read clean."
      >
        <p className="text-sm text-muted-foreground">
          {o.stocktakeVariances > 0
            ? `${o.stocktakeVariances} stocktake(s) in the last 7 days recorded a variance.`
            : "No stocktake variances recorded in the last 7 days."}
        </p>
      </SectionCard>
    </>
  );
}

/* ---------------- Positions ---------------- */

function PositionsTab({ tenantId }: { tenantId: string }) {
  const fn = useServerFn(listStockPositionsFn);
  const locFn = useServerFn(listInventoryLocationsFn);
  const [search, setSearch] = useState("");
  const [locationId, setLocationId] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const locations = useQuery({
    queryKey: ["restaurant.inventory.locations", tenantId],
    queryFn: () => locFn({ data: { tenantId, storageOnly: false, includeInactive: true } }),
  });
  const q = useQuery({
    queryKey: ["restaurant.inventory.positions", tenantId, locationId, lowOnly, search],
    queryFn: () =>
      fn({
        data: {
          tenantId,
          lowOnly,
          limit: 300,
          ...(locationId ? { locationId } : {}),
          ...(search ? { search } : {}),
        },
      }),
  });
  const rows = (q.data ?? []) as StockPosition[];

  return (
    <SectionCard
      title="Stock positions"
      description="On hand is physical. Reserved is committed. Available is what an operation can actually use. Incoming is approved procurement not yet received."
    >
      <div className="mb-3 grid gap-2 sm:grid-cols-4">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item or SKU" />
        <select
          className="min-h-11 rounded-md border bg-transparent px-2 text-sm"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          <option value="">All locations</option>
          {((locations.data ?? []) as any[]).map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          Below reorder only
        </label>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No stock items" description="Add inventory items or adjust the filters." />
      ) : (
        <ul className="divide-y text-sm">
          {rows.map((p) => (
            <li key={p.itemId} className="py-3">
              <button
                type="button"
                className="flex w-full flex-wrap items-center justify-between gap-3 text-left"
                onClick={() => setExpanded(expanded === p.itemId ? null : p.itemId)}
              >
                <span className="min-w-0">
                  <span className={`font-medium ${p.critical ? "text-destructive" : ""}`}>{p.name}</span>
                  {p.sku && <span className="ml-2 text-xs text-muted-foreground">{p.sku}</span>}
                  <span className="block text-xs text-muted-foreground">
                    on hand {qty(p.onHand)} · reserved {qty(p.reserved)} · available {qty(p.available)} · incoming {qty(p.incoming)}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-xs">
                  {p.critical ? <StatusChip tone="danger">out of stock</StatusChip> : p.low ? <StatusChip tone="warning">low</StatusChip> : null}
                  <span className="text-muted-foreground">{money(p.value, p.currency)}</span>
                </span>
              </button>
              {expanded === p.itemId && (
                <ul className="mt-2 space-y-1 rounded-md bg-muted/40 p-3 text-xs">
                  {p.locations.length === 0 ? (
                    <li className="text-muted-foreground">No location-level movements recorded yet.</li>
                  ) : (
                    p.locations.map((l) => (
                      <li key={`${p.itemId}:${l.locationId ?? "none"}`} className="flex justify-between gap-3">
                        <span>{l.locationName}</span>
                        <span className="text-muted-foreground">
                          on hand {qty(l.onHand)} · reserved {qty(l.reserved)} · available {qty(l.available)}
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ---------------- Transfers ---------------- */

function TransfersTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listStockTransfersFn);
  const getFn = useServerFn(getStockTransferFn);
  const createFn = useServerFn(createStockTransferFn);
  const approveFn = useServerFn(approveStockTransferFn);
  const dispatchFn = useServerFn(dispatchStockTransferFn);
  const receiveFn = useServerFn(receiveStockTransferFn);
  const locFn = useServerFn(listInventoryLocationsFn);
  const posFn = useServerFn(listStockPositionsFn);

  const [openId, setOpenId] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");

  const locations = useQuery({
    queryKey: ["restaurant.inventory.locations", tenantId],
    queryFn: () => locFn({ data: { tenantId, storageOnly: false, includeInactive: false } }),
  });
  const items = useQuery({
    queryKey: ["restaurant.inventory.positions", tenantId, "", false, ""],
    queryFn: () => posFn({ data: { tenantId, lowOnly: false, limit: 300 } }),
  });
  const transfers = useQuery({
    queryKey: ["restaurant.inventory.transfers", tenantId],
    queryFn: () => listFn({ data: { tenantId, limit: 50 } }),
  });
  const detail = useQuery({
    queryKey: ["restaurant.inventory.transfer", tenantId, openId],
    queryFn: () => getFn({ data: { tenantId, id: openId! } }),
    enabled: Boolean(openId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.transfers"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.transfer"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.positions"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.overview"] });
  };

  const create = useAdminMutation({
    mutationFn: () =>
      createFn({
        data: {
          tenantId,
          sourceLocationId: source,
          destinationLocationId: destination,
          requiresApproval: false,
          submit: true,
          notes: notes || undefined,
          lines: [{ inventoryItemId: itemId, requestedQuantity: Number(quantity) }],
        },
      }),
    successMessage: "Transfer requested",
    onSuccess: () => {
      setNotes("");
      invalidate();
    },
  });

  const approve = useAdminMutation({
    mutationFn: (vars: { transferId: string; approve: boolean }) =>
      approveFn({ data: { tenantId, transferId: vars.transferId, approve: vars.approve } }),
    successMessage: "Transfer updated",
    onSuccess: invalidate,
  });

  const dispatch = useAdminMutation({
    mutationFn: (vars: { transferId: string; lines: Array<{ lineId: string; dispatchedQuantity: number }> }) =>
      dispatchFn({ data: { tenantId, transferId: vars.transferId, lines: vars.lines } }),
    successMessage: "Dispatched — stock left the source location",
    onSuccess: invalidate,
  });

  const receive = useAdminMutation({
    mutationFn: (vars: {
      transferId: string;
      lines: Array<{ lineId: string; receivedQuantity: number; rejectedQuantity: number; damagedQuantity: number }>;
    }) => receiveFn({ data: { tenantId, transferId: vars.transferId, lines: vars.lines } }),
    successMessage: "Received — stock entered the destination",
    onSuccess: invalidate,
  });

  const rows = (transfers.data ?? []) as any[];
  const d = detail.data as any;

  return (
    <>
      <SectionCard
        title="New transfer"
        description="Stock leaves the source at dispatch and enters the destination at receipt — never both at once, so goods in transit are visible."
      >
        <div className="grid gap-2 sm:grid-cols-5">
          <select className="min-h-11 rounded-md border bg-transparent px-2 text-sm" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">From location…</option>
            {((locations.data ?? []) as any[]).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select className="min-h-11 rounded-md border bg-transparent px-2 text-sm" value={destination} onChange={(e) => setDestination(e.target.value)}>
            <option value="">To location…</option>
            {((locations.data ?? []) as any[]).filter((l) => l.id !== source).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select className="min-h-11 rounded-md border bg-transparent px-2 text-sm" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">Item…</option>
            {((items.data ?? []) as StockPosition[]).map((i) => (
              <option key={i.itemId} value={i.itemId}>{i.name} ({qty(i.available)} available)</option>
            ))}
          </select>
          <Input type="number" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Quantity" />
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" />
        </div>
        <div className="mt-3">
          <Button
            size="sm"
            disabled={!source || !destination || !itemId || Number(quantity) <= 0 || create.isPending}
            onClick={() => create.mutate(undefined)}
          >
            Request transfer
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Transfers" description="Requested → approved → dispatched → received.">
        {rows.length === 0 ? (
          <EmptyState title="No transfers" description="Move stock between outlets and stores to see them here." />
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((t) => {
              const b = transferBadge(t.status);
              return (
                <li key={t.id} className="py-3">
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center justify-between gap-3 text-left"
                    onClick={() => setOpenId(openId === t.id ? null : t.id)}
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{t.transfer_number ?? "Transfer"}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t.source_location_name ?? "Source"} → {t.destination_location_name ?? "Destination"} ·{" "}
                        {new Date(t.created_at).toLocaleString()}
                      </span>
                    </span>
                    <StatusChip tone={b.tone}>{b.label}</StatusChip>
                  </button>

                  {openId === t.id && d && (
                    <div className="mt-3 space-y-3 rounded-md bg-muted/40 p-3">
                      <ul className="space-y-1 text-xs">
                        {(d.lines ?? []).map((l: any) => (
                          <li key={l.id} className="flex justify-between gap-3">
                            <span>{l.item_name ?? "Item"}</span>
                            <span className="text-muted-foreground">
                              requested {qty(l.requested_quantity)} · dispatched {qty(l.dispatched_quantity)} · received {qty(l.received_quantity)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="flex flex-wrap gap-2">
                        {d.status === "requested" && (
                          <>
                            <Button size="sm" onClick={() => approve.mutate({ transferId: d.id, approve: true })}>Approve</Button>
                            <Button size="sm" variant="outline" onClick={() => approve.mutate({ transferId: d.id, approve: false })}>Reject</Button>
                          </>
                        )}
                        {(d.status === "approved" || d.status === "requested") && (
                          <Button
                            size="sm"
                            onClick={() =>
                              dispatch.mutate({
                                transferId: d.id,
                                lines: (d.lines ?? []).map((l: any) => ({
                                  lineId: l.id,
                                  dispatchedQuantity: Number(l.requested_quantity),
                                })),
                              })
                            }
                          >
                            Dispatch all
                          </Button>
                        )}
                        {(d.status === "dispatched" || d.status === "partially_received") && (
                          <Button
                            size="sm"
                            onClick={() =>
                              receive.mutate({
                                transferId: d.id,
                                lines: (d.lines ?? []).map((l: any) => ({
                                  lineId: l.id,
                                  receivedQuantity: Number(l.dispatched_quantity),
                                  rejectedQuantity: 0,
                                  damagedQuantity: 0,
                                })),
                              })
                            }
                          >
                            Receive all
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </>
  );
}

/* ---------------- Waste & adjustments ---------------- */

function WasteTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const posFn = useServerFn(listStockPositionsFn);
  const locFn = useServerFn(listInventoryLocationsFn);
  const reasonFn = useServerFn(listInventoryReasonsFn);
  const wasteFn = useServerFn(recordInventoryWasteFn);
  const adjustFn = useServerFn(recordInventoryAdjustmentFn);
  const resFn = useServerFn(listStockReservationsFn);

  const [mode, setMode] = useState<"waste" | "adjustment">("waste");
  const [itemId, setItemId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [direction, setDirection] = useState<"increase" | "decrease">("decrease");
  const [reasonCode, setReasonCode] = useState("");
  const [notes, setNotes] = useState("");

  const items = useQuery({
    queryKey: ["restaurant.inventory.positions", tenantId, "", false, ""],
    queryFn: () => posFn({ data: { tenantId, lowOnly: false, limit: 300 } }),
  });
  const locations = useQuery({
    queryKey: ["restaurant.inventory.locations", tenantId],
    queryFn: () => locFn({ data: { tenantId, storageOnly: false, includeInactive: false } }),
  });
  const reasons = useQuery({
    queryKey: ["restaurant.inventory.reasons", tenantId, mode],
    queryFn: () => reasonFn({ data: { tenantId, kind: mode } }),
  });
  const reservations = useQuery({
    queryKey: ["restaurant.inventory.reservations", tenantId],
    queryFn: () => resFn({ data: { tenantId, status: "active", limit: 50 } }),
  });

  const selectedReason = ((reasons.data ?? []) as any[]).find((r) => r.code === reasonCode);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.positions"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.overview"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.movements"] });
  };

  const submit = useAdminMutation({
    mutationFn: () => {
      const magnitude = Math.abs(Number(quantity));
      if (mode === "waste") {
        return wasteFn({
          data: {
            tenantId,
            inventoryItemId: itemId,
            quantity: magnitude,
            reasonCode,
            ...(locationId ? { locationId } : {}),
            ...(notes ? { notes } : {}),
          },
        });
      }
      return adjustFn({
        data: {
          tenantId,
          inventoryItemId: itemId,
          quantity: direction === "increase" ? magnitude : -magnitude,
          reasonCode,
          ...(locationId ? { locationId } : {}),
          ...(notes ? { notes } : {}),
        },
      });
    },
    successMessage: mode === "waste" ? "Waste recorded" : "Adjustment posted",
    onSuccess: () => {
      setNotes("");
      invalidate();
    },
  });

  return (
    <>
      <SectionCard
        title="Record waste or adjustment"
        description="A balance never changes without a reason and an actor. Waste always reduces stock; adjustments are explicitly signed."
      >
        <div className="mb-3 flex gap-1 rounded-lg border bg-card p-1 text-sm">
          {(["waste", "adjustment"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setReasonCode(""); }}
              className={`min-h-11 rounded px-4 py-2 capitalize ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="grid gap-2 sm:grid-cols-5">
          <select className="min-h-11 rounded-md border bg-transparent px-2 text-sm sm:col-span-2" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">Item…</option>
            {((items.data ?? []) as StockPosition[]).map((i) => (
              <option key={i.itemId} value={i.itemId}>{i.name} ({qty(i.onHand)} on hand)</option>
            ))}
          </select>
          <select className="min-h-11 rounded-md border bg-transparent px-2 text-sm" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Default location</option>
            {((locations.data ?? []) as any[]).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {mode === "adjustment" && (
            <select
              className="min-h-11 rounded-md border bg-transparent px-2 text-sm"
              value={direction}
              onChange={(e) => setDirection(e.target.value as "increase" | "decrease")}
            >
              <option value="decrease">Decrease stock</option>
              <option value="increase">Increase stock</option>
            </select>
          )}
          <Input type="number" step="0.001" min="0" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Quantity" />
          <select className="min-h-11 rounded-md border bg-transparent px-2 text-sm" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            <option value="">Reason…</option>
            {((reasons.data ?? []) as any[]).map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
        </div>
        <div className="mt-2">
          <Label htmlFor="inv-notes" className="text-xs text-muted-foreground">
            {selectedReason?.requires_note ? "Note (required for this reason)" : "Note (optional)"}
          </Label>
          <Textarea id="inv-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>
        <div className="mt-3">
          <Button
            size="sm"
            disabled={
              !itemId ||
              !reasonCode ||
              Number(quantity) <= 0 ||
              submit.isPending ||
              Boolean(selectedReason?.requires_note && !notes)
            }
            onClick={() => submit.mutate(undefined)}
          >
            {mode === "waste" ? "Record waste" : "Post adjustment"}
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Active reservations" description="Stock committed to an operation but not yet consumed. Reservations reduce availability, never the balance.">
        {((reservations.data ?? []) as any[]).length === 0 ? (
          <EmptyState title="No active reservations" description="Nothing is currently committed against stock." />
        ) : (
          <ul className="divide-y text-sm">
            {((reservations.data ?? []) as any[]).map((r) => (
              <Row key={r.id}>
                <span className="min-w-0">
                  <span className="font-medium capitalize">{String(r.purpose).replace(/_/g, " ")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {qty(r.quantity)} units{r.needed_at ? ` · needed ${new Date(r.needed_at).toLocaleDateString()}` : ""}
                  </span>
                </span>
                <StatusChip tone="info">{r.status}</StatusChip>
              </Row>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}

/* ---------------- Stocktake ---------------- */

function StocktakeTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listStocktakesFn);
  const getFn = useServerFn(getStocktakeFn);
  const startFn = useServerFn(startStocktakeFn);
  const saveFn = useServerFn(saveStocktakeCountsFn);
  const postFn = useServerFn(postStocktakeFn);
  const locFn = useServerFn(listInventoryLocationsFn);

  const [openId, setOpenId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});

  const locations = useQuery({
    queryKey: ["restaurant.inventory.locations", tenantId],
    queryFn: () => locFn({ data: { tenantId, storageOnly: true, includeInactive: false } }),
  });
  const list = useQuery({
    queryKey: ["restaurant.inventory.stocktakes", tenantId],
    queryFn: () => listFn({ data: { tenantId, limit: 30 } }),
  });
  const detail = useQuery({
    queryKey: ["restaurant.inventory.stocktake", tenantId, openId],
    queryFn: () => getFn({ data: { tenantId, id: openId! } }),
    enabled: Boolean(openId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.stocktakes"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.stocktake"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.positions"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.overview"] });
  };

  const start = useAdminMutation({
    mutationFn: () =>
      startFn({
        data: {
          tenantId,
          scope: locationId ? "location" : "full",
          itemIds: [],
          ...(locationId ? { locationId } : {}),
        },
      }),
    successMessage: "Stocktake started",
    onSuccess: invalidate,
  });

  const d = detail.data as any;
  const dirtyLines = useMemo(
    () =>
      Object.entries(counts)
        .filter(([, v]) => v !== "")
        .map(([lineId, v]) => ({ lineId, countedQuantity: Number(v) })),
    [counts],
  );

  const save = useAdminMutation({
    mutationFn: (vars: { submit: boolean }) =>
      saveFn({ data: { tenantId, stocktakeId: openId!, submitForReview: vars.submit, lines: dirtyLines } }),
    successMessage: "Counts saved",
    onSuccess: () => { setCounts({}); invalidate(); },
  });

  const post = useAdminMutation({
    mutationFn: (vars: { approve: boolean }) =>
      postFn({ data: { tenantId, stocktakeId: openId!, approve: vars.approve } }),
    successMessage: "Stocktake posted — variances became ledger adjustments",
    onSuccess: invalidate,
  });

  return (
    <>
      <SectionCard title="Start a stocktake" description="Expected quantities are snapshotted from the ledger the moment counting starts.">
        <div className="grid gap-2 sm:grid-cols-3">
          <select className="min-h-11 rounded-md border bg-transparent px-2 text-sm" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Full inventory</option>
            {((locations.data ?? []) as any[]).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <Button size="sm" disabled={start.isPending} onClick={() => start.mutate(undefined)}>Start counting</Button>
        </div>
      </SectionCard>

      <SectionCard title="Stocktakes" description="Count → review → approve → post. Approval is what writes adjustments.">
        {((list.data ?? []) as any[]).length === 0 ? (
          <EmptyState title="No stocktakes yet" description="Start a count to reconcile physical stock against the ledger." />
        ) : (
          <ul className="divide-y text-sm">
            {((list.data ?? []) as any[]).map((s) => {
              const b = stocktakeBadge(s.status);
              return (
                <li key={s.id} className="py-3">
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center justify-between gap-3 text-left"
                    onClick={() => { setOpenId(openId === s.id ? null : s.id); setCounts({}); }}
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{s.stocktake_number}</span>
                      <span className="block text-xs text-muted-foreground">
                        {s.location_name} · {new Date(s.created_at).toLocaleString()}
                        {Number(s.variance_value ?? 0) > 0 ? ` · variance ${money(Number(s.variance_value))}` : ""}
                      </span>
                    </span>
                    <StatusChip tone={b.tone}>{b.label}</StatusChip>
                  </button>

                  {openId === s.id && d && (
                    <div className="mt-3 space-y-3 rounded-md bg-muted/40 p-3">
                      <ul className="space-y-2 text-xs">
                        {(d.lines ?? []).map((l: any) => {
                          const counted = counts[l.id] ?? (l.counted_quantity != null ? String(l.counted_quantity) : "");
                          const variance = counted === "" ? null : Number(counted) - Number(l.expected_quantity ?? 0);
                          return (
                            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2">
                              <span className="min-w-0">
                                {l.item_name}
                                <span className="block text-muted-foreground">
                                  expected {qty(l.expected_quantity)} · {l.location_name}
                                </span>
                              </span>
                              <span className="flex items-center gap-2">
                                <Input
                                  className="h-10 w-28"
                                  type="number"
                                  step="0.001"
                                  value={counted}
                                  disabled={d.status === "posted" || d.status === "cancelled"}
                                  onChange={(e) => setCounts((c) => ({ ...c, [l.id]: e.target.value }))}
                                  placeholder="Counted"
                                />
                                {variance != null && Math.abs(variance) > 1e-9 && (
                                  <StatusChip tone={variance > 0 ? "info" : "warning"}>
                                    {variance > 0 ? "+" : ""}{qty(variance)}
                                  </StatusChip>
                                )}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="flex flex-wrap gap-2">
                        {["draft", "counting", "review"].includes(d.status) && (
                          <>
                            <Button size="sm" variant="outline" disabled={dirtyLines.length === 0} onClick={() => save.mutate({ submit: false })}>
                              Save counts
                            </Button>
                            <Button size="sm" variant="outline" disabled={dirtyLines.length === 0} onClick={() => save.mutate({ submit: true })}>
                              Submit for review
                            </Button>
                          </>
                        )}
                        {["counting", "review", "approved"].includes(d.status) && (
                          <>
                            <Button size="sm" onClick={() => post.mutate({ approve: true })}>Approve & post</Button>
                            <Button size="sm" variant="outline" onClick={() => post.mutate({ approve: false })}>Cancel stocktake</Button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </>
  );
}

/* ---------------- Batches ---------------- */

function BatchesTab({ tenantId }: { tenantId: string }) {
  const fn = useServerFn(listInventoryBatchesFn);
  const q = useQuery({
    queryKey: ["restaurant.inventory.batches", tenantId],
    queryFn: () => fn({ data: { tenantId, limit: 200 } }),
  });
  const rows = (q.data ?? []) as any[];
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  return (
    <SectionCard
      title="Batches & expiry"
      description="Lot tracking is opt-in per item. Expiring stock is a cost that has not been recognised yet."
      actions={
        <Button
          size="sm"
          className="h-10"
          onClick={() => {
            setEditing(null);
            setSheetOpen(true);
          }}
        >
          Record batch
        </Button>
      }
    >
      {rows.length === 0 ? (
        <EmptyState title="No tracked batches" description="Enable batch tracking on an item and record lots at receiving." />
      ) : (
        <ul className="divide-y text-sm">
          {rows.map((b) => (
            <Row key={b.id}>
              <button
                type="button"
                className="min-w-0 text-left"
                onClick={() => {
                  setEditing(b);
                  setSheetOpen(true);
                }}
              >
                <span className="font-medium">{b.item_name}</span>
                <span className="block text-xs text-muted-foreground">
                  {b.batch_number} · {b.location_name} · {qty(b.quantity)} units · {money(b.value)}
                </span>
              </button>
              <span className="flex items-center gap-2 text-xs">
                {b.expired ? (
                  <StatusChip tone="danger">expired</StatusChip>
                ) : b.expiring_soon ? (
                  <StatusChip tone="warning">{b.days_to_expiry}d left</StatusChip>
                ) : (
                  <span className="text-muted-foreground">{b.expiry_date ?? "no expiry"}</span>
                )}
              </span>
            </Row>
          ))}
        </ul>
      )}
      <BatchSheet open={sheetOpen} onOpenChange={setSheetOpen} tenantId={tenantId} batch={editing} />
    </SectionCard>
  );
}

/* ---------------- Locations ---------------- */

function LocationsTab({ tenantId }: { tenantId: string }) {
  const fn = useServerFn(listInventoryLocationsFn);
  const q = useQuery({
    queryKey: ["restaurant.inventory.locations.all", tenantId],
    queryFn: () => fn({ data: { tenantId, storageOnly: false, includeInactive: true } }),
  });
  const rows = (q.data ?? []) as any[];
  const tree = useMemo(() => {
    const roots = rows.filter((r) => !r.parent_id);
    const children = (id: string) => rows.filter((r) => r.parent_id === id);
    return roots.map((r) => ({ node: r, children: children(r.id) }));
  }, [rows]);

  return (
    <SectionCard
      title="Storage locations"
      description="One location tree per property. Service outlets and storage rooms differ only by whether they hold stock."
    >
      {rows.length === 0 ? (
        <EmptyState title="No locations" description="Add outlets and storage rooms to track stock by place." />
      ) : (
        <ul className="divide-y text-sm">
          {tree.map(({ node, children }) => (
            <li key={node.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="font-medium">{node.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {node.code ? `${node.code} · ` : ""}{String(node.location_type).replace(/_/g, " ")}
                  </span>
                </span>
                <span className="flex gap-2">
                  {node.is_storage && <StatusChip tone="info">storage</StatusChip>}
                  <StatusChip tone={node.status === "active" ? "success" : "neutral"}>{node.status}</StatusChip>
                </span>
              </div>
              {children.length > 0 && (
                <ul className="mt-2 space-y-1 border-l pl-4 text-xs text-muted-foreground">
                  {children.map((c) => (
                    <li key={c.id}>{c.name} · {String(c.location_type).replace(/_/g, " ")}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ---------------- Reconciliation ---------------- */

function ReconciliationTab({ tenantId }: { tenantId: string }) {
  const fn = useServerFn(listInventoryReconciliationFn);
  const q = useQuery({
    queryKey: ["restaurant.inventory.reconciliation", tenantId],
    queryFn: () => fn({ data: { tenantId, limit: 200 } }),
  });
  const data = q.data as any;

  return (
    <SectionCard
      title="Ledger reconciliation"
      description="The sum of the movement ledger must equal the stored item balance. Any drift means something bypassed the ledger."
    >
      {!data ? (
        <p className="text-sm text-muted-foreground">Checking…</p>
      ) : data.drifting === 0 ? (
        <EmptyState title="Ledger is clean" description={`${data.clean} item balances match the movement ledger exactly.`} />
      ) : (
        <ul className="divide-y text-sm">
          {(data.rows as any[]).filter((r) => Math.abs(r.drift) > 1e-6).map((r) => (
            <Row key={`${r.inventory_item_id}:${r.location_id ?? "all"}`}>
              <span className="min-w-0">
                <span className="font-medium">{r.item_name ?? "Item"}</span>
                <span className="block text-xs text-muted-foreground">
                  {r.location_name} · ledger {qty(r.ledger_quantity)} vs stored {qty(r.item_quantity)}
                </span>
              </span>
              <StatusChip tone="danger">drift {qty(r.drift)}</StatusChip>
            </Row>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}