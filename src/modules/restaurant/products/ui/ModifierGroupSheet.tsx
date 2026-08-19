/**
 * Create/edit a modifier group (e.g. "Toppings", "Spice level").
 */
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EntitySheet, Field, FieldRow } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantModifierGroupFn } from "../catalog.functions";

interface ModifierGroupSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  group?: any | null;
}

export function ModifierGroupSheet({ open, onOpenChange, tenantId, group }: ModifierGroupSheetProps) {
  const qc = useQueryClient();
  const upsertFn = useServerFn(upsertRestaurantModifierGroupFn);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [minSelect, setMinSelect] = useState("0");
  const [maxSelect, setMaxSelect] = useState("1");
  const [required, setRequired] = useState(false);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!open) return;
    setCode(group?.code ?? "");
    setName(group?.name ?? "");
    setMinSelect(String(group?.min_select ?? 0));
    setMaxSelect(String(group?.max_select ?? 1));
    setRequired(group?.required ?? false);
    setActive(group?.active ?? true);
  }, [open, group]);

  const save = useAdminMutation({
    mutationFn: () =>
      upsertFn({
        data: {
          tenantId,
          id: group?.id,
          code,
          name,
          minSelect: Number(minSelect) || 0,
          maxSelect: Number(maxSelect) || 1,
          required,
          active,
        },
      }),
    successMessage: group?.id ? "Modifier group updated" : "Modifier group created",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.modifier-groups", tenantId] });
      onOpenChange(false);
    },
  });

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={group?.id ? "Edit modifier group" : "New modifier group"}
      description="A group like Toppings or Spice level, with individual modifiers inside it."
      submitLabel={group?.id ? "Save changes" : "Create group"}
      onSubmit={() => save.mutate(undefined)}
      pending={save.isPending}
      disabled={!name || !code}
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
        <Field label="Min select">
          <Input className="h-11" inputMode="numeric" value={minSelect} onChange={(e) => setMinSelect(e.target.value)} />
        </Field>
        <Field label="Max select">
          <Input className="h-11" inputMode="numeric" value={maxSelect} onChange={(e) => setMaxSelect(e.target.value)} />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Required">
          <div className="flex h-11 items-center">
            <Switch checked={required} onCheckedChange={setRequired} />
          </div>
        </Field>
        <Field label="Active">
          <div className="flex h-11 items-center">
            <Switch checked={active} onCheckedChange={setActive} />
          </div>
        </Field>
      </FieldRow>
    </EntitySheet>
  );
}
