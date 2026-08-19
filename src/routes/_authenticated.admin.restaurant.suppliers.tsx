/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { listRestaurantSuppliersFn } from "@/modules/restaurant/suppliers/suppliers.functions";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";

export const Route = createFileRoute("/_authenticated/admin/restaurant/suppliers")({
  head: () => ({
    meta: [
      { title: "Suppliers — Restaurant & Bar OS" },
      { name: "description", content: "Supplier directory, terms and lead times for restaurant purchasing." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SuppliersPage,
});

function SuppliersPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const fn = useServerFn(listRestaurantSuppliersFn);
  const q = useQuery({
    queryKey: ["restaurant.suppliers", tenantId],
    queryFn: () => fn({ data: { tenantId: tenantId!, limit: 100 } }),
    enabled: Boolean(tenantId),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Suppliers" description="Who supplies this operation, on what terms and lead times." />
      <SectionCard title="Directory">
        {(q.data ?? []).length === 0 ? (
          <EmptyState title="No suppliers" description="Add suppliers to enable purchase orders." />
        ) : (
          <ul className="divide-y text-sm">
            {(q.data ?? []).map((s: any) => (
              <li key={s.id} className="flex items-center justify-between py-2">
                <span>{s.name}</span>
                <span className="text-xs text-muted-foreground">
                  {s.payment_terms ?? "terms n/a"}
                  {s.lead_time_days != null ? ` · ${s.lead_time_days}d lead` : ""} · {s.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}