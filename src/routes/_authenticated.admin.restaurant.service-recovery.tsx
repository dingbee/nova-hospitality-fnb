/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AlertTriangle, ClipboardCheck } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { listRestaurantOrdersFn, getRestaurantOrderFn } from "@/modules/restaurant/sales/sales.functions";
import { recordServiceRecoveryFn, listServiceRecoveryCasesFn } from "@/modules/restaurant/sales/service-recovery.functions";

export const Route = createFileRoute("/_authenticated/admin/restaurant/service-recovery")({
  head: () => ({ meta: [{ title: "Service Recovery — LexiBite" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: ServiceRecoveryPage,
});

function ServiceRecoveryPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const propertyId = ws.data?.activePropertyId ?? undefined;
  const qc = useQueryClient();
  const [orderId, setOrderId] = useState("");
  const [lineId, setLineId] = useState("");
  const [category, setCategory] = useState("quality");
  const [complaint, setComplaint] = useState("");
  const [reason, setReason] = useState("");
  const [disposition, setDisposition] = useState("wastage_review");
  const ordersFn = useServerFn(listRestaurantOrdersFn);
  const detailFn = useServerFn(getRestaurantOrderFn);
  const listCasesFn = useServerFn(listServiceRecoveryCasesFn);
  const recordFn = useServerFn(recordServiceRecoveryFn);
  const orders = useQuery({
    queryKey: ["service-recovery.orders", tenantId, propertyId],
    queryFn: () => ordersFn({ data: { tenantId: tenantId!, propertyId, limit: 100 } }),
    enabled: Boolean(tenantId),
  });
  const detail = useQuery({
    queryKey: ["service-recovery.order", tenantId, orderId],
    queryFn: () => detailFn({ data: { tenantId: tenantId!, orderId } }),
    enabled: Boolean(tenantId && orderId),
  });
  const cases = useQuery({
    queryKey: ["service-recovery.cases", tenantId, propertyId],
    queryFn: () => listCasesFn({ data: { tenantId: tenantId!, propertyId, limit: 100 } }),
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
  });
  const submit = useAdminMutation({
    mutationFn: () => {
      const line = (detail.data?.items ?? []).find((x: any) => x.id === lineId);
      const isPrepared = ["fired", "sent", "preparing", "ready", "served"].includes(String(line?.status));
      return recordFn({ data: {
        tenantId: tenantId!, orderId, originalOrderItemId: lineId,
        clientRequestId: crypto.randomUUID(),
        complaintCategory: category as any, complaint, resolution: "pending",
        resolutionReason: reason, stockDisposition: (isPrepared ? "preserve_consumption" : disposition) as any,
      }});
    },
    successMessage: "Complaint recorded for follow-up",
    onSuccess: () => {
      setComplaint(""); setReason(""); setLineId("");
      void qc.invalidateQueries({ queryKey: ["service-recovery.cases"] });
    },
  });
  const selectedLine = (detail.data?.items ?? []).find((x: any) => x.id === lineId);
  const prepared = ["fired", "sent", "preparing", "ready", "served"].includes(String(selectedLine?.status));
  const caseRows = cases.data ?? [];

  if (!ws.isLoading && !tenantId) return <EmptyState title="No restaurant tenant" description="You are not a member of a Restaurant & Bar OS tenant." />;

  return <div className="space-y-4">
    <PageHeader title="Service recovery" description="Log guest complaints, preserve stock truth, and track cases that need supervisor follow-up." />
    <SectionCard title="Record a complaint" description="This records the incident only. Process replacement, comp, refund, or void through the existing POS/bill workflow before recording any completed financial outcome.">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm"><span>Order</span>
          <select className="w-full rounded-md border bg-background p-2" value={orderId} onChange={e => { setOrderId(e.target.value); setLineId(""); }}>
            <option value="">Select order…</option>
            {(orders.data ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.order_number} · {o.status} · {o.currency} {o.total}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm"><span>Order item</span>
          <select className="w-full rounded-md border bg-background p-2" value={lineId} onChange={e => setLineId(e.target.value)} disabled={!orderId}>
            <option value="">Select affected item…</option>
            {(detail.data?.items ?? []).filter((x: any) => x.status !== "voided").map((x: any) => <option key={x.id} value={x.id}>{x.description} × {x.quantity} · {x.status}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm"><span>Complaint category</span>
          <select className="w-full rounded-md border bg-background p-2" value={category} onChange={e => setCategory(e.target.value)}>
            <option value="wrong_item">Wrong item</option><option value="quality">Quality</option><option value="temperature">Temperature</option><option value="delay">Delay</option><option value="allergy_safety">Allergy / safety</option><option value="guest_changed_mind">Guest changed mind</option><option value="missing_item">Missing item</option><option value="other">Other</option>
          </select>
        </label>
        <label className="space-y-1 text-sm"><span>Stock disposition</span>
          <select className="w-full rounded-md border bg-background p-2" value={prepared ? "preserve_consumption" : disposition} onChange={e => setDisposition(e.target.value)} disabled={prepared}>
            <option value="preserve_consumption">Preserve consumption (prepared/served)</option><option value="reverse_unprepared">Reverse unprepared stock</option><option value="wastage_review">Supervisor wastage review</option><option value="not_applicable">Not applicable</option>
          </select>
          {prepared && <span className="block text-xs text-amber-700">This item reached production/service. Stock consumption is preserved; it will not be restored automatically.</span>}
        </label>
        <label className="space-y-1 text-sm md:col-span-2"><span>What happened?</span>
          <textarea className="min-h-20 w-full rounded-md border bg-background p-2" value={complaint} onChange={e => setComplaint(e.target.value)} maxLength={2000} placeholder="Record the guest's complaint factually…" />
        </label>
        <label className="space-y-1 text-sm md:col-span-2"><span>Immediate follow-up / reason</span>
          <Input value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} placeholder="e.g. Supervisor to assess replacement and wastage" />
        </label>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">New cases remain OPEN until a supervisor confirms the outcome.</p>
        <Button disabled={!tenantId || !orderId || !lineId || complaint.trim().length < 3 || reason.trim().length < 3 || submit.isPending} onClick={() => submit.mutate()}><AlertTriangle className="mr-2 h-4 w-4" /> Record case</Button>
      </div>
    </SectionCard>
    <SectionCard title="Recovery case register" description="Most recent incidents for the active property/tenant.">
      {caseRows.length === 0 ? <EmptyState title="No service-recovery cases" description="Reported complaints will appear here." /> : <div className="divide-y">
        {caseRows.map((c: any) => <div key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><strong>{c.complaint_category.replaceAll("_", " ")}</strong><StatusChip>{c.status}</StatusChip><StatusChip>{c.stock_disposition.replaceAll("_", " ")}</StatusChip></div>
            <p className="mt-1">{c.complaint}</p><p className="text-xs text-muted-foreground">Order {c.order_id} · {new Date(c.created_at).toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">Follow-up: {c.resolution_reason}</p>
          </div>
          <ClipboardCheck className="h-5 w-5 text-muted-foreground" />
        </div>)}
      </div>}
    </SectionCard>
  </div>;
}
