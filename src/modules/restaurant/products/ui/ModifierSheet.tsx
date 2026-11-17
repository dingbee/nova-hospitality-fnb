/**
 * Create/edit an individual modifier within a group.
 */
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EntitySheet, Field, FieldRow, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantModifierFn } from "../catalog.functions";
import { listRestaurantInventoryFn } from "@/modules/restaurant/inventory/inventory.functions";
import { MODIFIER_EFFECTS } from "../contracts";

interface ModifierSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  groupId: string;
  modifier?: any | null;
}

export function ModifierSheet({ open, onOpenChange, tenantId, groupId, modifier }: ModifierSheetProps) {
  const qc = useQueryClient();
  const upsertFn = useServerFn(upsertRestaurantModifierFn);
  const inventoryFn = useServerFn(listRestaurantInventoryFn);

  const [name, setName] = useState("");
  const [priceDelta, setPriceDelta] = useState("0");
  const [effect, setEffect] = useState<(typeof MODIFIER_EFFECTS)[number]>("none");
  const [inventoryItemId, setInventoryItemId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("0");
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!open) return;
    setName(modifier?.name ?? "");
    setPriceDelta(String(modifier?.price_delta ?? 0));
    setEffect(modifier?.effect ?? "none");
    setInventoryItemId(modifier?.inventory_item_id ?? null);
    setQuantity(String(modifier?.quantity ?? 0));
    setActive(modifier?.active ?? true);
  }, [open, modifier]);

  const items = useQuery({
    queryKey: ["restaurant.inventory.items", tenantId],
    queryFn: () => inventoryFn({ data: { tenantId, lowOnly: false, limit: 500 } }),
    enabled: open && effect === "inventory",
  });

  const save = useAdminMutation({
    mutationFn: () =>
      upsertFn({
        data: {
          tenantId,
          id: modifier?.id,
          groupId,
          name,
          priceDelta: Number(priceDelta) || 0,
          effect,
          inventoryItemId: effect === "inventory" ? inventoryItemId ?? undefined : undefined,
          quantity: Number(quantity) || 0,
          active,
        },
      }),
    successMessage: modifier?.id ? "Modifier updated" : "Modifier created",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.modifier-groups", tenantId] });
      onOpenChange(false);
    },
  });

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={modifier?.id ? "Edit modifier" : "New modifier"}
      description="A single choice inside a group — e.g. 'Extra cheese' inside Toppings."
      submitLabel={modifier?.id ? "Save changes" : "Create modifier"}
      onSubmit={() => save.mutate(undefined)}
      pending={save.isPending}
      disabled={!name}
    >
      <FieldRow>
        <Field label="Name" required>
          <Input className="h-11" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Price delta">
          <Input className="h-11" inputMode="decimal" value={priceDelta} onChange={(e) => setPriceDelta(e.target.value)} />
        </Field>
      </FieldRow>
      <Field label="Effect" hint="Whether choosing this modifier also touches stock.">
        <select
          className="h-11 w-full rounded-md border bg-transparent px-2 text-sm"
          value={effect}
          onChange={(e) => setEffect(e.target.value as (typeof MODIFIER_EFFECTS)[number])}
        >
          {MODIFIER_EFFECTS.map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
      </Field>
      {effect === "inventory" ? (
        <FieldRow>
          <Field label="Inventory item">
            <SearchSelect
              options={((items.data ?? []) as any[]).map((i) => ({ value: i.id, label: i.name, hint: i.sku }))}
              value={inventoryItemId}
              onChange={setInventoryItemId}
              placeholder="Select item"
            />
          </Field>
          <Field label="Quantity consumed">
            <Input className="h-11" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
        </FieldRow>
      ) : null}
      <Field label="Active">
        <div className="flex h-11 items-center">
          <Switch checked={active} onCheckedChange={setActive} />
        </div>
      </Field>
    </EntitySheet>
  );
}
