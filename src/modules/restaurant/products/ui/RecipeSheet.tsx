/**
 * Recipe builder: header fields plus component lines (ingredient or
 * sub-recipe), each with quantity, unit and yield %. Shows the computed
 * cost from the costing engine right after save.
 */
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { EntitySheet, Field, FieldRow, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import {
  upsertRestaurantRecipeFn,
  listRestaurantRecipesFn,
  computeRestaurantRecipeCostV2Fn,
} from "../catalog.functions";
import { listRestaurantInventoryFn, listRestaurantUnitsFn } from "@/modules/restaurant/inventory/inventory.functions";
import { RECIPE_KINDS, RECIPE_COMPONENT_KINDS, type RecipeLineInput } from "../contracts";

interface RecipeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  recipe?: any | null;
  lines?: RecipeLineInput[];
}

const money = (v: number, currency = "TZS") =>
  `${currency} ${Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function RecipeSheet({ open, onOpenChange, tenantId, recipe, lines: initialLines }: RecipeSheetProps) {
  const qc = useQueryClient();
  const upsertFn = useServerFn(upsertRestaurantRecipeFn);
  const costFn = useServerFn(computeRestaurantRecipeCostV2Fn);
  const recipesFn = useServerFn(listRestaurantRecipesFn);
  const inventoryFn = useServerFn(listRestaurantInventoryFn);
  const unitsFn = useServerFn(listRestaurantUnitsFn);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof RECIPE_KINDS)[number]>("menu");
  const [yieldQuantity, setYieldQuantity] = useState("1");
  const [yieldUnitId, setYieldUnitId] = useState<string | null>(null);
  const [targetCost, setTargetCost] = useState("");
  const [instructions, setInstructions] = useState("");
  const [lines, setLines] = useState<RecipeLineInput[]>([]);
  const [savedResult, setSavedResult] = useState<any | null>(null);

  useEffect(() => {
    if (!open) return;
    setCode(recipe?.code ?? "");
    setName(recipe?.name ?? "");
    setKind(recipe?.kind ?? "menu");
    setYieldQuantity(String(recipe?.yield_quantity ?? 1));
    setYieldUnitId(recipe?.yield_unit_id ?? null);
    setTargetCost(recipe?.target_cost != null ? String(recipe.target_cost) : "");
    setInstructions(recipe?.instructions ?? "");
    setLines(
      (initialLines ?? []).map((l) => ({
        ...l,
        componentKind: l.componentKind ?? "inventory_item",
        yieldPercent: l.yieldPercent ?? 100,
      })),
    );
    setSavedResult(null);
  }, [open, recipe, initialLines]);

  const inventory = useQuery({
    queryKey: ["restaurant.inventory.items", tenantId],
    queryFn: () => inventoryFn({ data: { tenantId, lowOnly: false, limit: 500 } }),
    enabled: open,
  });
  const units = useQuery({
    queryKey: ["restaurant.units", tenantId],
    queryFn: () => unitsFn({ data: { tenantId } }),
    enabled: open,
  });
  const subRecipes = useQuery({
    queryKey: ["restaurant.recipes.subrecipe-candidates", tenantId],
    queryFn: () => recipesFn({ data: { tenantId, latestOnly: true, limit: 300 } }),
    enabled: open,
  });

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      {
        componentKind: "inventory_item",
        inventoryItemId: null,
        subRecipeId: null,
        quantity: 0,
        unitId: null,
        yieldPercent: 100,
        isOptional: false,
        sortOrder: prev.length,
        notes: null,
      },
    ]);
  };
  const updateLine = (idx: number, patch: Partial<RecipeLineInput>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));

  const save = useAdminMutation({
    mutationFn: async () => {
      const res = await upsertFn({
        data: {
          tenantId,
          id: recipe?.id,
          code,
          name,
          kind,
          status: recipe?.status ?? "draft",
          yieldQuantity: Number(yieldQuantity) || 1,
          yieldUnitId: yieldUnitId ?? undefined,
          targetCost: targetCost ? Number(targetCost) : undefined,
          instructions: instructions || undefined,
          lines: lines.map((l, i) => ({ ...l, sortOrder: i })),
        },
      });
      const cost = await costFn({ data: { tenantId, recipeId: (res as any).id, persist: true } }).catch(
        (e: Error) => ({ error: e.message }) as any,
      );
      return { res, cost };
    },
    successMessage: recipe?.id ? "Recipe updated" : "Recipe created",
    onSuccess: (data: any) => {
      void qc.invalidateQueries({ queryKey: ["restaurant.recipes", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.recipe", tenantId] });
      setSavedResult(data.cost);
    },
  });

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={recipe?.id ? "Edit recipe" : "New recipe"}
      description="Recipe components can be inventory ingredients or reusable sub-recipes. Published recipes are versioned, never rewritten."
      submitLabel={recipe?.id ? "Save changes" : "Create recipe"}
      onSubmit={() => save.mutate(undefined)}
      pending={save.isPending}
      disabled={!name || !code}
      wide
    >
      <FieldRow>
        <Field label="Code" required>
          <Input className="h-11" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Name" required>
          <Input className="h-11" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Kind">
          <select className="h-11 w-full rounded-md border bg-transparent px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value as (typeof RECIPE_KINDS)[number])}>
            {RECIPE_KINDS.map((k) => (
              <option key={k} value={k}>{k.replace("_", " ")}</option>
            ))}
          </select>
        </Field>
        <Field label="Target cost (optional)">
          <Input className="h-11" inputMode="decimal" value={targetCost} onChange={(e) => setTargetCost(e.target.value)} />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Yield quantity" required>
          <Input className="h-11" inputMode="decimal" value={yieldQuantity} onChange={(e) => setYieldQuantity(e.target.value)} />
        </Field>
        <Field label="Yield unit">
          <SearchSelect
            options={((units.data ?? []) as any[]).map((u) => ({ value: u.id, label: `${u.name} (${u.code})` }))}
            value={yieldUnitId}
            onChange={setYieldUnitId}
            placeholder="Select unit"
          />
        </Field>
      </FieldRow>
      <Field label="Instructions">
        <Textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </Field>

      <div className="space-y-3 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Components</p>
          <Button type="button" size="sm" variant="outline" className="h-9" onClick={addLine}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add line
          </Button>
        </div>
        {lines.length === 0 ? (
          <p className="text-xs text-muted-foreground">No components yet. Add an ingredient or a sub-recipe.</p>
        ) : (
          <ul className="space-y-3">
            {lines.map((l, idx) => (
              <li key={idx} className="grid gap-2 rounded-md bg-muted/40 p-3 sm:grid-cols-6">
                <select
                  className="h-11 rounded-md border bg-transparent px-2 text-sm sm:col-span-1"
                  value={l.componentKind}
                  onChange={(e) =>
                    updateLine(idx, {
                      componentKind: e.target.value as (typeof RECIPE_COMPONENT_KINDS)[number],
                      inventoryItemId: null,
                      subRecipeId: null,
                    })
                  }
                >
                  {RECIPE_COMPONENT_KINDS.map((k) => (
                    <option key={k} value={k}>{k === "inventory_item" ? "Ingredient" : "Sub-recipe"}</option>
                  ))}
                </select>
                <div className="sm:col-span-2">
                  {l.componentKind === "inventory_item" ? (
                    <SearchSelect
                      options={((inventory.data ?? []) as any[]).map((i) => ({ value: i.id, label: i.name, hint: i.sku }))}
                      value={l.inventoryItemId ?? null}
                      onChange={(v) => updateLine(idx, { inventoryItemId: v })}
                      placeholder="Select ingredient"
                    />
                  ) : (
                    <SearchSelect
                      options={((subRecipes.data ?? []) as any[])
                        .filter((r) => r.id !== recipe?.id)
                        .map((r) => ({ value: r.id, label: r.name, hint: r.code }))}
                      value={l.subRecipeId ?? null}
                      onChange={(v) => updateLine(idx, { subRecipeId: v })}
                      placeholder="Select sub-recipe"
                    />
                  )}
                </div>
                <Input
                  className="h-11 sm:col-span-1"
                  inputMode="decimal"
                  placeholder="Qty"
                  value={l.quantity}
                  onChange={(e) => updateLine(idx, { quantity: Number(e.target.value) || 0 })}
                />
                <SearchSelect
                  className="sm:col-span-1"
                  options={((units.data ?? []) as any[]).map((u) => ({ value: u.id, label: u.code }))}
                  value={l.unitId ?? null}
                  onChange={(v) => updateLine(idx, { unitId: v })}
                  placeholder="Unit"
                />
                <div className="flex items-center gap-1 sm:col-span-1">
                  <Input
                    className="h-11"
                    inputMode="decimal"
                    placeholder="Yield %"
                    value={l.yieldPercent}
                    onChange={(e) => updateLine(idx, { yieldPercent: Number(e.target.value) || 100 })}
                  />
                  <Button type="button" size="icon" variant="ghost" className="h-11 w-11 shrink-0" onClick={() => removeLine(idx)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {savedResult ? (
        <div className="rounded-md border p-3 text-sm">
          <p className="font-medium">Computed cost</p>
          {savedResult.error ? (
            <p className="text-destructive">{savedResult.error}</p>
          ) : (
            <p className="text-muted-foreground">
              {money(savedResult.totalCost, savedResult.currency)} total ·{" "}
              {money(savedResult.costPerYieldUnit, savedResult.currency)} per yield unit
            </p>
          )}
        </div>
      ) : null}
    </EntitySheet>
  );
}
