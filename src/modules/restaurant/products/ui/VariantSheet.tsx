/**
 * Create/edit a product variant (size/option).
 */
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EntitySheet, Field, FieldRow, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantVariantFn, listRestaurantRecipesFn } from "../catalog.functions";

interface VariantSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  productId: string;
  variant?: any | null;
}

export function VariantSheet({ open, onOpenChange, tenantId, productId, variant }: VariantSheetProps) {
  const qc = useQueryClient();
  const upsertFn = useServerFn(upsertRestaurantVariantFn);
  const recipesFn = useServerFn(listRestaurantRecipesFn);

  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("0");
  const [priceIsDelta, setPriceIsDelta] = useState(false);
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [yieldFactor, setYieldFactor] = useState("1");
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!open) return;
    setName(variant?.name ?? "");
    setSku(variant?.sku ?? "");
    setPrice(String(variant?.price ?? 0));
    setPriceIsDelta(variant?.price_is_delta ?? false);
    setRecipeId(variant?.recipe_id ?? null);
    setYieldFactor(String(variant?.yield_factor ?? 1));
    setActive(variant?.active ?? true);
  }, [open, variant]);

  const recipes = useQuery({
    queryKey: ["restaurant.recipes", tenantId],
    queryFn: () => recipesFn({ data: { tenantId, latestOnly: true, limit: 200 } }),
    enabled: open,
  });

  const save = useAdminMutation({
    mutationFn: () =>
      upsertFn({
        data: {
          tenantId,
          id: variant?.id,
          productId,
          sku: sku || undefined,
          name,
          price: Number(price) || 0,
          priceIsDelta,
          recipeId: recipeId ?? undefined,
          yieldFactor: Number(yieldFactor) || 1,
          active,
        },
      }),
    successMessage: variant?.id ? "Variant updated" : "Variant created",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.products", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.product-variants", tenantId, productId] });
      onOpenChange(false);
    },
  });

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={variant?.id ? "Edit variant" : "New variant"}
      description="Variants are sizes or options of a single product — a Large, a double, a size 32."
      submitLabel={variant?.id ? "Save changes" : "Create variant"}
      onSubmit={() => save.mutate(undefined)}
      pending={save.isPending}
      disabled={!name}
    >
      <FieldRow>
        <Field label="Name" required>
          <Input className="h-11" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="SKU">
          <Input className="h-11" value={sku} onChange={(e) => setSku(e.target.value)} />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Price" hint={priceIsDelta ? "Added to base product price" : "Absolute price"}>
          <Input className="h-11" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Price is a delta">
          <div className="flex h-11 items-center">
            <Switch checked={priceIsDelta} onCheckedChange={setPriceIsDelta} />
          </div>
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Recipe (optional)" hint="If the variant is produced differently than the base product.">
          <SearchSelect
            options={((recipes.data ?? []) as any[]).map((r) => ({ value: r.id, label: r.name, hint: r.code }))}
            value={recipeId}
            onChange={setRecipeId}
            placeholder="Same as product"
          />
        </Field>
        <Field label="Yield factor" hint="Multiplier against the recipe yield (e.g. double = 2).">
          <Input className="h-11" inputMode="decimal" value={yieldFactor} onChange={(e) => setYieldFactor(e.target.value)} />
        </Field>
      </FieldRow>
      <Field label="Active">
        <div className="flex h-11 items-center">
          <Switch checked={active} onCheckedChange={setActive} />
        </div>
      </Field>
    </EntitySheet>
  );
}
