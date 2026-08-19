/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus } from "lucide-react";
import { DocumentActions } from "@/modules/restaurant/documents/ui/DocumentActions";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { hasRestaurantCapability } from "@/modules/restaurant/core/permissions";
import {
  listRestaurantPurchaseOrdersFn,
  createRestaurantPurchaseOrderFn,
  transitionRestaurantPurchaseOrderFn,
} from "@/modules/restaurant/purchasing/purchasing.functions";
import { PO_TRANSITIONS, PO_MANUAL_STATUSES } from "@/modules/restaurant/purchasing/state-machine";
import { listRestaurantSuppliersFn } from "@/modules/restaurant/suppliers/suppliers.functions";
import { listRestaurantInventoryFn } from "@/modules/restaurant/inventory/inventory.functions";
import { PurchaseOrderSheet, type PurchaseOrderFormValue } from "@/modules/restaurant/purchasing/ui/PurchaseOrderSheet";
import { SupplierConfirmationSheet } from "@/modules/restaurant/procurement/ui/SupplierConfirmationSheet";
import { SupplierInvoiceSheet } from "@/modules/restaurant/procurement/ui/SupplierInvoiceSheet";

export const Route = createFileRoute("/_authenticated/admin/restaurant/purchasing")({
  head: () => ({
    meta: [
      { title: "Purchasing — Restaurant & Bar OS" },
      { name: "description", content: "Purchase orders, approvals and receiving for restaurant supply." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PurchasingPage,
});

const PO_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  submitted: "warning",
  approved: "info",
  partially_received: "info",
  received: "success",
  cancelled: "danger",
};

function PurchasingPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const roles = ws.data?.roles ?? [];
  const platformAdmin = Boolean(ws.data?.platformAdmin);
  const canManage = hasRestaurantCapability(roles, "purchasing.manage", platformAdmin);
  const qc = useQueryClient();

  const fn = useServerFn(listRestaurantPurchaseOrdersFn);
  const createFn = useServerFn(createRestaurantPurchaseOrderFn);
  const transitionFn = useServerFn(transitionRestaurantPurchaseOrderFn);
  const suppliersFn = useServerFn(listRestaurantSuppliersFn);
  const itemsFn = useServerFn(listRestaurantInventoryFn);

  const q = useQuery({
    queryKey: ["restaurant.purchase-orders", tenantId],
    queryFn: () => fn({ data: { tenantId: tenantId!, limit: 50 } }),
    enabled: Boolean(tenantId),
  });
  const suppliers = useQuery({
    queryKey: ["restaurant.suppliers", tenantId],
    queryFn: () => suppliersFn({ data: { tenantId: tenantId!, limit: 200 } }),
    enabled: Boolean(tenantId),
  });
  const items = useQuery({
    queryKey: ["restaurant.inventory", tenantId],
    queryFn: () => itemsFn({ data: { tenantId: tenantId!, lowOnly: false, limit: 300 } }),
    enabled: Boolean(tenantId),
  });

  const [open, setOpen] = useState(false);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [invoiceFor, setInvoiceFor] = useState<string | null>(null);

  const transition = useAdminMutation({
    mutationFn: (v: { id: string; status: "submitted" | "approved" | "cancelled"; reason?: string }) =>
      transitionFn({ data: { tenantId: tenantId!, id: v.id, status: v.status, reason: v.reason } }),
    successMessage: "Purchase order updated",
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["restaurant.purchase-orders", tenantId] }),
  });

  const create = useAdminMutation({
    mutationFn: (v: PurchaseOrderFormValue) =>
      createFn({
        data: {
          tenantId: tenantId!,
          supplierId: v.supplierId ?? undefined,
          reference: v.reference || undefined,
          expectedAt: v.expectedAt || undefined,
          currency: v.currency,
          notes: v.notes || undefined,
          directReason: v.directReason,
          lines: v.lines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            inventoryItemId: l.inventoryItemId ?? undefined,
          })),
        },
      }),
    successMessage: "Purchase order created",
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["restaurant.purchase-orders", tenantId] });
    },
  });

  const supplierOptions = ((suppliers.data ?? []) as any[]).map((s) => ({ value: s.id, label: s.name }));
  const itemOptions = ((items.data ?? []) as any[]).map((i) => ({ value: i.id, label: i.name, hint: i.sku ?? undefined }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Purchasing"
        description="Draft → submitted → approved → received. Every transition is an event the Intelligence Core can observe."
      />
      <SectionCard
        title="Purchase orders"
        actions={
          canManage ? (
            <Button size="sm" className="h-10" onClick={() => setOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> New order
            </Button>
          ) : undefined
        }
      >
        <p className="mb-3 text-xs text-muted-foreground">
          Need to negotiate against a request first? Use the{" "}
          <Link to="/admin/restaurant/procurement" search={{ tab: "requests" }} className="underline">
            Procurement Centre
          </Link>{" "}
          for the request → approval → conversion lifecycle.
        </p>
        {(q.data ?? []).length === 0 ? (
          <EmptyState title="No purchase orders" description="Create a purchase order from a supplier catalogue." />
        ) : (
          <ul className="divide-y text-sm">
            {(q.data ?? []).map((o: any) => (
              <li key={o.id} className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-2">
                <span>{o.document_number ?? o.reference ?? o.id.slice(0, 8)}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <StatusChip tone={PO_TONE[o.status] ?? "neutral"}>{o.status}</StatusChip>
                  {o.currency} {Number(o.total ?? 0).toLocaleString()}
                  {canManage ? (
                    <>
                      {((PO_TRANSITIONS[o.status as keyof typeof PO_TRANSITIONS] ?? []) as readonly string[])
                        .filter((s): s is "submitted" | "approved" | "cancelled" =>
                          (PO_MANUAL_STATUSES as readonly string[]).includes(s),
                        )
                        .map((s) => (
                          <Button
                            key={s}
                            size="sm"
                            variant={s === "cancelled" ? "ghost" : "secondary"}
                            className="h-10"
                            disabled={transition.isPending}
                            onClick={() => {
                              if (s === "cancelled") {
                                const reason = window.prompt("Reason for cancelling this purchase order?");
                                if (!reason) return;
                                transition.mutate({ id: o.id, status: s, reason });
                                return;
                              }
                              transition.mutate({ id: o.id, status: s });
                            }}
                          >
                            {s === "submitted" ? "Issue to supplier" : s === "approved" ? "Approve" : "Cancel"}
                          </Button>
                        ))}
                      <Button size="sm" variant="outline" className="h-10" onClick={() => setConfirmFor(o.id)}>
                        Supplier confirmation
                      </Button>
                      <Button size="sm" variant="outline" className="h-10" onClick={() => setInvoiceFor(o.id)}>
                        Record invoice
                      </Button>
                      <DocumentActions tenantId={tenantId!} type="purchase_order" recordId={o.id} documentNumber={o.document_number} />
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <PurchaseOrderSheet
        open={open}
        onOpenChange={setOpen}
        suppliers={supplierOptions}
        items={itemOptions}
        pending={create.isPending}
        onSubmit={(v) => create.mutate(v)}
      />

      {tenantId ? (
        <>
          <SupplierConfirmationSheet
            open={Boolean(confirmFor)}
            onOpenChange={(v) => !v && setConfirmFor(null)}
            tenantId={tenantId}
            purchaseOrderId={confirmFor}
          />
          <SupplierInvoiceSheet
            open={Boolean(invoiceFor)}
            onOpenChange={(v) => !v && setInvoiceFor(null)}
            tenantId={tenantId}
            purchaseOrderId={invoiceFor}
          />
        </>
      ) : null}
    </div>
  );
}
