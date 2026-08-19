/**
 * Create/edit a sellable product.
 */
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { EntitySheet, Field, FieldRow, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantProductFn, listRestaurantRecipesFn } from "../catalog.functions";
import { PRODUCT_TYPES } from "../contracts";

interface ProductSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  product?: any | null;
}

export function ProductSheet({ open, onOpenChange, tenantId, product }: ProductSheetProps) {
  const qc = useQueryClient();
  const upsertFn = useServerFn(upsertRestaurantProductFn);
  const recipesFn = useServerFn(listRestaurantRecipesFn);

  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [productType, setProductType] = useState<(typeof PRODUCT_TYPES)[number]>("standard");
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [price, setPrice] = useState("0");
  const [taxRate, setTaxRate] = useState("0");
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!open) return;
    setSku(product?.sku ?? "");
    setName(product?.name ?? "");
    setDescription(product?.description ?? "");
    setProductType(product?.product_type ?? "standard");
    setRecipeId(product?.recipe_id ?? null);
    setPrice(String(product?.price ?? 0));
    setTaxRate(String(product?.tax_rate ?? 0));
    setActive(product?.active ?? true);
  }, [open, product]);

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
          id: product?.id,
          sku,
          name,
          description: description || undefined,
          productType,
          recipeId: recipeId ?? undefined,
          price: Number(price) || 0,
          taxRate: Number(taxRate) || 0,
          active,
        },
      }),
    successMessage: product?.id ? "Product updated" : "Product created",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.products", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.product-evidence", tenantId] });
      onOpenChange(false);
    },
  });

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={product?.id ? "Edit product" : "New product"}
      description="Products are what the POS sells. A recipe is optional — retail lines and bottled drinks need none."
      submitLabel={product?.id ? "Save changes" : "Create product"}
      onSubmit={() => save.mutate(undefined)}
      pending={save.isPending}
      disabled={!name || !sku}
    >
      <FieldRow>
        <Field label="SKU" required>
          <Input className="h-11" value={sku} onChange={(e) => setSku(e.target.value)} />
        </Field>
        <Field label="Name" required>
          <Input className="h-11" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </FieldRow>
      <Field label="Description">
        <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <FieldRow>
        <Field label="Product type">
          <select
            className="h-11 w-full rounded-md border bg-transparent px-2 text-sm"
            value={productType}
            onChange={(e) => setProductType(e.target.value as (typeof PRODUCT_TYPES)[number])}
          >
            {PRODUCT_TYPES.map((t) => (
              <option key={t} value={t}>{t.replace("_", " ")}</option>
            ))}
          </select>
        </Field>
        <Field label="Recipe (optional)" hint="Leave blank for retail lines with no recipe.">
          <SearchSelect
            options={((recipes.data ?? []) as any[]).map((r) => ({ value: r.id, label: r.name, hint: r.code }))}
            value={recipeId}
            onChange={setRecipeId}
            placeholder="No recipe"
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Price">
          <Input className="h-11" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Tax rate %">
          <Input className="h-11" inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
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
