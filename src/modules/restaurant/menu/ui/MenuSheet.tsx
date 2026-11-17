/**
 * Create / edit a menu.
 */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EntitySheet, Field, FieldRow } from "../../ui/forms";
import { MENU_STATUSES, type MenuStatus } from "../../core/contracts";

export interface MenuFormValue {
  id?: string;
  name: string;
  slug: string;
  currency: string;
  status: MenuStatus;
  description: string;
}

const EMPTY: MenuFormValue = { name: "", slug: "", currency: "TZS", status: "draft", description: "" };

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function MenuSheet({
  open,
  onOpenChange,
  initial,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial?: MenuFormValue | null;
  onSubmit: (value: MenuFormValue) => void;
  pending?: boolean;
}) {
  const [value, setValue] = React.useState<MenuFormValue>(EMPTY);
  React.useEffect(() => {
    if (open) setValue(initial ?? EMPTY);
  }, [open, initial]);

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={initial?.id ? "Edit menu" : "New menu"}
      description="Menus are versioned per outlet. Publishing makes it the active offer."
      submitLabel={initial?.id ? "Save changes" : "Create menu"}
      pending={pending}
      disabled={!value.name.trim() || !value.slug.trim()}
      onSubmit={() => onSubmit(value)}
    >
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
      <Field label="Slug" required hint="Lowercase, hyphenated identifier.">
        <Input className="h-11" value={value.slug} onChange={(e) => setValue((v) => ({ ...v, slug: e.target.value }))} />
      </Field>
      <FieldRow>
        <Field label="Currency" required>
          <Input className="h-11" value={value.currency} onChange={(e) => setValue((v) => ({ ...v, currency: e.target.value.toUpperCase() }))} />
        </Field>
        <Field label="Status" required>
          <select
            className="h-11 w-full rounded-md border bg-transparent px-2 text-sm"
            value={value.status}
            onChange={(e) => setValue((v) => ({ ...v, status: e.target.value as MenuStatus }))}
          >
            {MENU_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
      </FieldRow>
      <Field label="Description">
        <Textarea rows={3} value={value.description} onChange={(e) => setValue((v) => ({ ...v, description: e.target.value }))} />
      </Field>
    </EntitySheet>
  );
}
