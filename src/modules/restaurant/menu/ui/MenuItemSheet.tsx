/**
 * Create / edit a menu item — always attached to a menu, optionally to a category.
 */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { EntitySheet, Field, FieldRow, SearchSelect, QuantityField, type SearchOption } from "../../ui/forms";

export interface MenuItemFormValue {
  id?: string;
  menuId: string;
  categoryId: string | null;
  name: string;
  slug: string;
  description: string;
  price: number;
  currency: string;
  available: boolean;
  sortOrder: number;
}

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function MenuItemSheet({
  open,
  onOpenChange,
  initial,
  menus,
  categories,
  defaultMenuId,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial?: MenuItemFormValue | null;
  menus: SearchOption[];
  categories: SearchOption[];
  defaultMenuId?: string;
  onSubmit: (value: MenuItemFormValue) => void;
  pending?: boolean;
}) {
  const empty: MenuItemFormValue = {
    menuId: defaultMenuId ?? "",
    categoryId: null,
    name: "",
    slug: "",
    description: "",
    price: 0,
    currency: "TZS",
    available: true,
    sortOrder: 0,
  };
  const [value, setValue] = React.useState<MenuItemFormValue>(empty);
  React.useEffect(() => {
    if (open) setValue(initial ?? empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={initial?.id ? "Edit menu item" : "New menu item"}
      description="Items belong to a menu and, optionally, a section/category."
      submitLabel={initial?.id ? "Save changes" : "Add item"}
      pending={pending}
      disabled={!value.name.trim() || !value.slug.trim() || !value.menuId}
      onSubmit={() => onSubmit(value)}
    >
      <Field label="Menu" required>
        <SearchSelect
          options={menus}
          value={value.menuId || null}
          onChange={(v) => setValue((s) => ({ ...s, menuId: v ?? "" }))}
          placeholder="Choose a menu…"
          allowClear={false}
        />
      </Field>
      <Field label="Section / category" hint="Optional grouping shown to guests.">
        <SearchSelect
          options={categories}
          value={value.categoryId}
          onChange={(v) => setValue((s) => ({ ...s, categoryId: v }))}
          placeholder="No section"
        />
      </Field>
      <Field label="Name" required>
        <Input
          className="h-11"
          value={value.name}
          onChange={(e) => {
            const name = e.target.value;
            setValue((v) => ({ ...v, name, slug: v.slug && initial?.id ? v.slug : slugify(name) }));
          }}
        />
      </Field>
      <Field label="Slug" required>
        <Input className="h-11" value={value.slug} onChange={(e) => setValue((v) => ({ ...v, slug: e.target.value }))} />
      </Field>
      <FieldRow>
        <Field label="Price" required>
          <QuantityField value={value.price} onChange={(n) => setValue((v) => ({ ...v, price: n }))} step={100} suffix={value.currency} />
        </Field>
        <Field label="Sort order">
          <QuantityField value={value.sortOrder} onChange={(n) => setValue((v) => ({ ...v, sortOrder: n }))} step={1} />
        </Field>
      </FieldRow>
      <Field label="Description">
        <Textarea rows={3} value={value.description} onChange={(e) => setValue((v) => ({ ...v, description: e.target.value }))} />
      </Field>
      <Field label="Available for sale">
        <div className="flex h-11 items-center gap-3">
          <Switch checked={value.available} onCheckedChange={(c) => setValue((v) => ({ ...v, available: c }))} />
          <span className="text-sm text-muted-foreground">{value.available ? "On menu" : "Off menu"}</span>
        </div>
      </Field>
    </EntitySheet>
  );
}
