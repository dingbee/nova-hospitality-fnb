/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { listRestaurantRecipeCostsFn } from "@/modules/restaurant/costing/costing.functions";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";

export const Route = createFileRoute("/_authenticated/admin/restaurant/costing")({
  head: () => ({
    meta: [
      { title: "Recipe Costing — Restaurant & Bar OS" },
      { name: "description", content: "Ingredient cost, food cost percentage and suggested pricing per menu item." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: CostingPage,
});

function CostingPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const fn = useServerFn(listRestaurantRecipeCostsFn);
  const q = useQuery({
    queryKey: ["restaurant.recipe-costs", tenantId],
    queryFn: () => fn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Recipe Costing"
        description="Deterministic costing: Σ (quantity ÷ yield) × average unit cost, plus overhead. No estimates."
      />
      <SectionCard title="Latest costings">
        {(q.data ?? []).length === 0 ? (
          <EmptyState title="Nothing costed yet" description="Add recipe components to a menu item, then compute its cost." />
        ) : (
          <ul className="divide-y text-sm">
            {(q.data ?? []).map((c: any) => (
              <li key={c.id} className="flex items-center justify-between py-2">
                <span className="text-muted-foreground">{new Date(c.computed_at).toLocaleString()}</span>
                <span className="text-xs text-muted-foreground">
                  cost {c.currency} {Number(c.total_cost).toLocaleString()}
                  {c.food_cost_percent != null ? ` · ${c.food_cost_percent}% food cost` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}