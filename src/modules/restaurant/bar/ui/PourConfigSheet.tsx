/**
 * Pour configuration — the only genuinely new write in the bar lens.
 * A beverage's serving size plus serving unit is what turns a bottle into
 * pours; everything downstream (pour cost, margin, variance) derives from it.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { QuantityField } from "@/modules/restaurant/ui/forms/QuantityField";
import { SearchSelect } from "@/modules/restaurant/ui/forms/SearchSelect";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { listRestaurantUnitsFn } from "@/modules/restaurant/inventory/inventory.functions";
import { saveBarPourConfigFn } from "../bar.functions";
import { pourCost, pourMaths, poursAvailable } from "../pour";
import type { BarBeverage } from "../contracts";

export function PourConfigSheet({
  tenantId,
  beverage,
  open,
  onOpenChange,
}: {
  tenantId: string;
  beverage: BarBeverage | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const unitsFn = useServerFn(listRestaurantUnitsFn);
  const saveFn = useServerFn(saveBarPourConfigFn);

  const [isBeverage, setIsBeverage] = React.useState(true);
  const [servingSize, setServingSize] = React.useState(0);
  const [servingUnitId, setServingUnitId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!beverage) return;
    setIsBeverage(true);
    setServingSize(Number(beverage.servingSize ?? 0));
    setServingUnitId(beverage.servingUnitId ?? null);
  }, [beverage]);

  const units = useQuery({
    queryKey: ["restaurant.units", tenantId],
    queryFn: () => unitsFn({ data: { tenantId } }),
    enabled: open && Boolean(tenantId),
  });

  const unitRows = (units.data ?? []) as Array<{ id: string; code: string; name: string; dimension: string; factor: number }>;
  const stockUnit = unitRows.find((u) => u.code === beverage?.stockUnitCode);
  const servingUnit = unitRows.find((u) => u.id === servingUnitId);

  const preview = React.useMemo(() => {
    if (!beverage || !servingSize) return null;
    const maths = pourMaths({ servingSize, servingUnit, stockUnit });
    return {
      ...maths,
      pourCost: pourCost(beverage.averageCost, maths),
      poursAvailable: poursAvailable(beverage.onHand, maths),
    };
  }, [beverage, servingSize, servingUnit, stockUnit]);

  const save = useAdminMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          inventoryItemId: beverage!.itemId,
          isBeverage,
          servingSize: servingSize > 0 ? servingSize : null,
          servingUnitId: servingSize > 0 ? servingUnitId : null,
        },
      }),
    successMessage: "Pour configuration saved",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bar.beverages"] });
      void qc.invalidateQueries({ queryKey: ["bar.snapshot"] });
      onOpenChange(false);
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full space-y-5 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{beverage?.name ?? "Pour configuration"}</SheetTitle>
          <SheetDescription>
            Stock is held in {beverage?.stockUnitCode ?? "stock units"}. Define one serving and every pour cost, margin and
            variance figure derives from it.
          </SheetDescription>
        </SheetHeader>

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <Label className="text-sm">Treat as beverage</Label>
            <p className="text-xs text-muted-foreground">Includes this item in bar stock, pour cost and variance.</p>
          </div>
          <Switch checked={isBeverage} onCheckedChange={setIsBeverage} />
        </div>

        <div className="space-y-2">
          <Label className="text-sm">Serving size</Label>
          <QuantityField value={servingSize} onChange={setServingSize} step={5} suffix={servingUnit?.code ?? ""} />
        </div>

        <div className="space-y-2">
          <Label className="text-sm">Serving unit</Label>
          <SearchSelect
            options={unitRows.map((u) => ({ value: u.id, label: `${u.name} (${u.code})`, hint: u.dimension }))}
            value={servingUnitId}
            onChange={setServingUnitId}
            placeholder="Select serving unit…"
          />
        </div>

        {preview ? (
          <div className="rounded-lg border p-3 text-sm">
            {!preview.exact ? (
              <p className="text-[color:var(--os-warn)]">{preview.reason}</p>
            ) : (
              <ul className="space-y-1 text-muted-foreground">
                <li>
                  Pours per {beverage?.stockUnitCode ?? "unit"}:{" "}
                  <span className="font-medium text-foreground">{preview.poursPerStockUnit?.toFixed(2) ?? "—"}</span>
                </li>
                <li>
                  Cost per pour:{" "}
                  <span className="font-medium text-foreground">
                    {beverage?.currency} {preview.pourCost?.toFixed(2) ?? "—"}
                  </span>
                </li>
                <li>
                  Pours available now:{" "}
                  <span className="font-medium text-foreground">{preview.poursAvailable?.toFixed(0) ?? "—"}</span>
                </li>
              </ul>
            )}
          </div>
        ) : null}

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!beverage || save.isPending} onClick={() => save.mutate(undefined)}>
            Save pour
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}