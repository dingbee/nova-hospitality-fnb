/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * Requisitions Workspace — kitchen / bar / department stock requests.
 *
 * draft → submitted → approved → (partially_issued | fulfilled), with
 * rejected/cancelled terminal branches. Issuing always moves stock through
 * the ledger — nothing here writes a balance directly.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { DocumentActions } from "@/modules/restaurant/documents/ui/DocumentActions";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import { hasRestaurantCapability } from "../../core/permissions";
import { QuantityField, type SearchOption } from "../../ui/forms";
import { listInventoryLocationsFn } from "../../inventory/control.functions";
import { listStockPositionsFn } from "../../inventory/control.functions";
import {
  REQUISITION_KINDS,
  REQUISITION_STATUSES,
  requisitionBadge,
  type RequisitionKind,
  type RequisitionStatus,
} from "../contracts";
import {
  approveRequisitionFn,
  cancelRequisitionFn,
  getRequisitionFn,
  issueRequisitionFn,
  listRequisitionsFn,
  rejectRequisitionFn,
  saveRequisitionDraftFn,
  submitRequisitionFn,
} from "../requisitions.functions";
import { RequisitionSheet } from "./RequisitionSheet";
import { IssueSheet } from "./IssueSheet";

const qty = (n: number) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 3 });

const STATUS_FILTERS: Array<{ id: RequisitionStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  ...REQUISITION_STATUSES.map((s) => ({ id: s, label: requisitionBadge(s).label })),
];

const KIND_FILTERS: Array<{ id: RequisitionKind | "all"; label: string }> = [
  { id: "all", label: "All kinds" },
  ...REQUISITION_KINDS.map((k) => ({ id: k, label: k[0].toUpperCase() + k.slice(1) })),
];

export function RequisitionsWorkspace({ initialStatus }: { initialStatus?: string } = {}) {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const roles = ws.data?.roles ?? [];
  const platformAdmin = Boolean(ws.data?.platformAdmin);

  const canCreate = hasRestaurantCapability(roles, "requisition.create", platformAdmin);
  const canApprove = hasRestaurantCapability(roles, "requisition.approve", platformAdmin);
  const canIssue = hasRestaurantCapability(roles, "requisition.issue", platformAdmin);

  const [status, setStatus] = React.useState<RequisitionStatus | "all">(
    (STATUS_FILTERS.some((s) => s.id === initialStatus) ? (initialStatus as RequisitionStatus) : "all"),
  );
  const [kind, setKind] = React.useState<RequisitionKind | "all">("all");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [issueOpen, setIssueOpen] = React.useState(false);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState("");
  const [approveQty, setApproveQty] = React.useState<Record<string, number>>({});

  const qc = useQueryClient();
  const listFn = useServerFn(listRequisitionsFn);
  const getFn = useServerFn(getRequisitionFn);
  const saveDraftFn = useServerFn(saveRequisitionDraftFn);
  const submitFn = useServerFn(submitRequisitionFn);
  const approveFn = useServerFn(approveRequisitionFn);
  const rejectFn = useServerFn(rejectRequisitionFn);
  const cancelFn = useServerFn(cancelRequisitionFn);
  const issueFn = useServerFn(issueRequisitionFn);
  const locFn = useServerFn(listInventoryLocationsFn);
  const posFn = useServerFn(listStockPositionsFn);

  const list = useQuery({
    queryKey: ["restaurant.requisitions.list", tenantId, status, kind],
    queryFn: () =>
      listFn({
        data: {
          tenantId: tenantId!,
          limit: 100,
          ...(status !== "all" ? { status } : {}),
          ...(kind !== "all" ? { kind } : {}),
        },
      }),
    enabled: Boolean(tenantId),
  });

  const detail = useQuery({
    queryKey: ["restaurant.requisitions.detail", tenantId, openId],
    queryFn: () => getFn({ data: { tenantId: tenantId!, id: openId! } }),
    enabled: Boolean(tenantId && openId),
  });

  const locations = useQuery({
    queryKey: ["restaurant.inventory.locations", tenantId],
    queryFn: () => locFn({ data: { tenantId: tenantId!, storageOnly: false, includeInactive: false } }),
    enabled: Boolean(tenantId),
  });
  const items = useQuery({
    queryKey: ["restaurant.inventory.positions", tenantId, "", false, ""],
    queryFn: () => posFn({ data: { tenantId: tenantId!, lowOnly: false, limit: 300 } }),
    enabled: Boolean(tenantId),
  });

  const locationOptions: SearchOption[] = ((locations.data ?? []) as any[]).map((l) => ({
    value: l.id,
    label: l.name,
  }));
  const itemOptions: SearchOption[] = ((items.data ?? []) as any[]).map((i) => ({
    value: i.itemId,
    label: i.name,
  }));

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.requisitions.list"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.requisitions.detail"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.positions"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.inventory.overview"] });
  };

  const createDraft = useAdminMutation({
    mutationFn: (payload: Parameters<typeof RequisitionSheet>[0]["onSubmit"] extends (p: infer P) => void ? P : never) =>
      saveDraftFn({
        data: {
          tenantId: tenantId!,
          kind: payload.kind,
          department: payload.department,
          sourceLocationId: payload.sourceLocationId,
          destinationLocationId: payload.destinationLocationId,
          requiredDate: payload.requiredDate,
          notes: payload.notes,
          submit: payload.submit,
          lines: payload.lines.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            unitId: l.unitId,
            requestedQuantity: l.requestedQuantity,
            notes: l.notes,
          })),
        },
      }),
    successMessage: "Requisition saved",
    onSuccess: () => {
      setCreateOpen(false);
      invalidate();
    },
  });

  const submitReq = useAdminMutation({
    mutationFn: (id: string) => submitFn({ data: { tenantId: tenantId!, requisitionId: id } }),
    successMessage: "Requisition submitted",
    onSuccess: invalidate,
  });

  const approveReq = useAdminMutation({
    mutationFn: (vars: { id: string; lines: Array<{ lineId: string; approvedQuantity: number }> }) =>
      approveFn({ data: { tenantId: tenantId!, requisitionId: vars.id, lines: vars.lines } }),
    successMessage: "Requisition approved",
    onSuccess: invalidate,
  });

  const rejectReq = useAdminMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      rejectFn({ data: { tenantId: tenantId!, requisitionId: vars.id, reason: vars.reason } }),
    successMessage: "Requisition rejected",
    onSuccess: () => {
      setRejectOpen(false);
      setRejectReason("");
      invalidate();
    },
  });

  const cancelReq = useAdminMutation({
    mutationFn: (id: string) => cancelFn({ data: { tenantId: tenantId!, requisitionId: id } }),
    successMessage: "Requisition cancelled",
    onSuccess: invalidate,
  });

  const issueReq = useAdminMutation({
    mutationFn: (vars: { id: string; lines: Array<{ lineId: string; issueQuantity: number }> }) =>
      issueFn({ data: { tenantId: tenantId!, requisitionId: vars.id, lines: vars.lines } }),
    successMessage: "Requisition issued",
    onSuccess: () => {
      setIssueOpen(false);
      invalidate();
    },
  });

  if (!ws.isLoading && !ws.data?.tenant) {
    return <EmptyState title="No restaurant tenant" description="You are not a member of a Restaurant & Bar OS tenant." />;
  }

  const rows = (list.data ?? []) as any[];
  const d = detail.data as any;

  const openDetail = (id: string) => {
    setOpenId(openId === id ? null : id);
    setApproveQty({});
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Requisitions"
        description="Kitchen, bar and department requests for stock from a store. Approval sets a quantity; issuing moves it through the ledger."
        actions={
          canCreate ? (
            <Button className="h-11" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> New requisition
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap gap-2">
        <nav className="flex flex-wrap gap-1 rounded-lg border bg-card p-1 text-sm">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStatus(s.id)}
              className={`min-h-11 rounded px-3 py-2 ${
                status === s.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <nav className="flex flex-wrap gap-1 rounded-lg border bg-card p-1 text-sm">
          {KIND_FILTERS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKind(k.id)}
              className={`min-h-11 rounded px-3 py-2 ${
                kind === k.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {k.label}
            </button>
          ))}
        </nav>
      </div>

      <SectionCard title="Requisitions" description="Tap a row to review lines and take action.">
        {rows.length === 0 ? (
          <EmptyState title="No requisitions" description="Requests for stock from kitchens, bars and departments show up here." />
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((r) => {
              const b = requisitionBadge(r.status);
              return (
                <li key={r.id} className="py-3">
                  <button
                    type="button"
                    className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 text-left"
                    onClick={() => openDetail(r.id)}
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{r.reference}</span>
                      <span className="ml-2 text-xs uppercase tracking-wide text-muted-foreground">{r.kind}</span>
                      <span className="block text-xs text-muted-foreground">
                        {r.source_name} → {r.destination_name}
                        {r.required_date ? ` · required ${new Date(r.required_date).toLocaleDateString()}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-xs">
                      {r.outstanding_lines > 0 ? (
                        <StatusChip tone="warning">{r.outstanding_lines} outstanding</StatusChip>
                      ) : null}
                      <StatusChip tone={b.tone}>{b.label}</StatusChip>
                    </span>
                  </button>

                  {openId === r.id && d && d.id === r.id && (
                    <div className="mt-3 space-y-3 rounded-md bg-muted/40 p-3">
                      {r.department ? <p className="text-xs text-muted-foreground">Department: {r.department}</p> : null}
                      {r.notes ? <p className="text-xs text-muted-foreground">Notes: {r.notes}</p> : null}
                      <ul className="space-y-1 text-xs">
                        {(d.lines ?? []).map((l: any) => (
                          <li key={l.id} className="space-y-1 rounded border bg-background p-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium">{l.item_name}</span>
                              <span className="text-muted-foreground">
                                requested {qty(l.requested_quantity)}
                                {l.approved_quantity != null ? ` · approved ${qty(l.approved_quantity)}` : ""} · issued{" "}
                                {qty(l.issued_quantity ?? 0)} · outstanding {qty(l.outstanding_quantity)}
                              </span>
                            </div>
                            {r.status === "submitted" && canApprove ? (
                              <QuantityField
                                value={approveQty[l.id] ?? Number(l.requested_quantity)}
                                onChange={(v) => setApproveQty((prev) => ({ ...prev, [l.id]: v }))}
                                step={1}
                                min={0}
                              />
                            ) : null}
                          </li>
                        ))}
                      </ul>

                      <div className="flex flex-wrap gap-2">
                        {r.status === "draft" && canCreate ? (
                          <Button size="sm" className="h-11" disabled={submitReq.isPending} onClick={() => submitReq.mutate(r.id)}>
                            Submit
                          </Button>
                        ) : null}
                        {r.status === "submitted" && canApprove ? (
                          <>
                            <Button
                              size="sm"
                              className="h-11"
                              disabled={approveReq.isPending}
                              onClick={() =>
                                approveReq.mutate({
                                  id: r.id,
                                  lines: (d.lines ?? []).map((l: any) => ({
                                    lineId: l.id,
                                    approvedQuantity: approveQty[l.id] ?? Number(l.requested_quantity),
                                  })),
                                })
                              }
                            >
                              Approve
                            </Button>
                            <Button size="sm" variant="destructive" className="h-11" onClick={() => setRejectOpen(true)}>
                              Reject
                            </Button>
                          </>
                        ) : null}
                        {["approved", "partially_issued"].includes(r.status) && canIssue ? (
                          <Button size="sm" className="h-11" onClick={() => setIssueOpen(true)}>
                            Issue
                          </Button>
                        ) : null}
                        {!["fulfilled", "cancelled", "rejected"].includes(r.status) && canCreate ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-11"
                            disabled={cancelReq.isPending}
                            onClick={() => cancelReq.mutate(r.id)}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <RequisitionSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        locationOptions={locationOptions}
        itemOptions={itemOptions}
        unitOptions={[]}
        pending={createDraft.isPending}
        onSubmit={(payload) => createDraft.mutate(payload)}
      />

      {openId && d && d.id === openId ? (
        <IssueSheet
          open={issueOpen}
          onOpenChange={setIssueOpen}
          reference={d.reference}
          lines={(d.lines ?? []).map((l: any) => ({
            id: l.id,
            itemName: l.item_name,
            requestedQuantity: Number(l.requested_quantity),
            approvedQuantity: Number(l.approved_quantity ?? 0),
            issuedQuantity: Number(l.issued_quantity ?? 0),
            outstandingQuantity: Number(l.outstanding_quantity ?? 0),
          }))}
          pending={issueReq.isPending}
          onSubmit={(payload) => issueReq.mutate({ id: openId, lines: payload.lines })}
        />
      ) : null}

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject requisition</DialogTitle>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection (required)"
            className="min-h-24"
          />
          <DialogFooter>
            <Button variant="ghost" className="h-11" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="h-11"
              disabled={rejectReason.trim().length < 2 || rejectReq.isPending || !openId}
              onClick={() => openId && rejectReq.mutate({ id: openId, reason: rejectReason.trim() })}
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
