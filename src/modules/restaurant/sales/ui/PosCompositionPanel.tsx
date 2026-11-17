/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * What is actually in this drink, and how many are left.
 *
 * A composed beverage is stock in several places at once. Showing the exploded
 * components — and the ingredient that runs out first — stops the bar selling a
 * cocktail it can no longer make.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge } from "@/components/ui/badge";
import { menuItemCompositionFn } from "@/modules/restaurant/products/composition.functions";

export function PosCompositionPanel({
  tenantId,
  menuItemId,
  quantity,
}: {
  tenantId?: string;
  menuItemId?: string;
  quantity: number;
}) {
  const fn = useServerFn(menuItemCompositionFn);
  const q = useQuery({
    queryKey: ["restaurant.pos.composition", tenantId, menuItemId],
    queryFn: () => fn({ data: { tenantId: tenantId!, menuItemId: menuItemId! } }),
    enabled: Boolean(tenantId && menuItemId),
    staleTime: 60_000,
  });

  const data = q.data as any;
  if (!data?.composed) return null;
  const servings = data.servings as number | null;
  const short = servings != null && servings < quantity;

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Composition · recipe v{data.recipeVersion}
        </p>
        {servings != null && (
          <Badge variant={short ? "destructive" : "outline"}>
            {servings} {servings === 1 ? "serving" : "servings"} in stock
          </Badge>
        )}
      </div>
      {data.error ? (
        <p className="text-xs text-destructive">{data.error}</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {data.components.map((c: any) => (
            <li key={c.inventoryItemId} className="flex items-center justify-between gap-2">
              <span className={c.limiting ? "font-medium text-destructive" : ""}>
                {c.name}
                {c.optional ? " (optional)" : ""}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {(c.quantityPerServing * quantity).toFixed(3)} · {c.onHand} on hand
              </span>
            </li>
          ))}
        </ul>
      )}
      {short && (
        <p className="text-xs text-destructive">
          Not enough stock for {quantity}. Requisition the limiting ingredient before selling.
        </p>
      )}
    </div>
  );
}
