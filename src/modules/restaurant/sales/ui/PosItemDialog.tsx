/* eslint-disable @typescript-eslint/no-explicit-any -- catalogue rows are untyped at this boundary. */
import { useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PosModifierInput } from "../pos.contracts";
import { money, type CartLine } from "./pos-types";
import { PosCompositionPanel } from "./PosCompositionPanel";

/**
 * Choice pad for one item: variant, modifiers, seat and notes.
 * Pure presentation — pricing is re-resolved server-side on send.
 */
export function PosItemDialog({
  item,
  groups,
  currency,
  seats,
  tenantId,
  onClose,
  onAdd,
}: {
  item: any | null;
  groups: any[];
  currency: string;
  seats: number;
  /** Enables the live composition and stock read for composed items. */
  tenantId?: string;
  onClose: () => void;
  onAdd: (line: CartLine) => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const [variantId, setVariantId] = useState<string | undefined>(undefined);
  const [chosen, setChosen] = useState<PosModifierInput[]>([]);
  const [seat, setSeat] = useState<string>("");
  const [kitchenNote, setKitchenNote] = useState("");
  const [guestNote, setGuestNote] = useState("");

  const itemGroups = useMemo(
    () => groups.filter((g) => (item?.modifier_group_ids ?? []).includes(g.id)),
    [groups, item],
  );

  if (!item) return null;

  const variant = (item.variants ?? []).find((v: any) => v.id === variantId);
  const basePrice = Number(item.price ?? 0);
  const unitPrice = variant
    ? variant.price_is_delta
      ? basePrice + Number(variant.price ?? 0)
      : Number(variant.price ?? 0)
    : basePrice;
  const modifierPerUnit = chosen.reduce((s, m) => s + m.priceDelta * m.quantity, 0);

  const toggle = (group: any, mod: any) => {
    setChosen((prev) => {
      const exists = prev.find((m) => m.modifierId === mod.id);
      if (exists) return prev.filter((m) => m.modifierId !== mod.id);
      const single = Number(group.max_select ?? 0) === 1;
      const cleaned = single ? prev.filter((m) => m.groupId !== group.id) : prev;
      return [
        ...cleaned,
        { modifierId: mod.id, groupId: group.id, name: mod.name, priceDelta: Number(mod.price_delta ?? 0), quantity: 1 },
      ];
    });
  };

  const unmetGroup = itemGroups.find(
    (g) => g.required && chosen.filter((m) => m.groupId === g.id).length < Math.max(1, Number(g.min_select ?? 1)),
  );

  const add = () => {
    onAdd({
      key: `${item.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      menuItemId: item.id,
      variantId,
      stationId: item.station_id ?? undefined,
      description: variant ? `${item.name} — ${variant.name}` : item.name,
      quantity,
      unitPrice,
      seatNumber: seat ? Number(seat) : undefined,
      notes: kitchenNote || undefined,
      guestNotes: guestNote || undefined,
      modifiers: chosen,
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>
            {money(unitPrice + modifierPerUnit, currency)} per unit
            {item.allergens?.length ? ` · allergens: ${item.allergens.join(", ")}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="icon" className="size-11" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
              <Minus className="size-4" />
            </Button>
            <span className="w-12 text-center text-lg font-semibold tabular-nums">{quantity}</span>
            <Button type="button" variant="outline" size="icon" className="size-11" onClick={() => setQuantity((q) => q + 1)}>
              <Plus className="size-4" />
            </Button>
            <div className="ml-auto w-28">
              <Label className="text-xs text-muted-foreground">Seat</Label>
              <Input
                inputMode="numeric"
                placeholder={seats > 0 ? `1–${seats}` : "—"}
                value={seat}
                onChange={(e) => setSeat(e.target.value.replace(/\D/g, "").slice(0, 2))}
              />
            </div>
          </div>

          <PosCompositionPanel tenantId={tenantId} menuItemId={item.id} quantity={quantity} />

          {(item.variants ?? []).length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Variant</Label>
              <div className="flex flex-wrap gap-2">
                {(item.variants ?? []).map((v: any) => (
                  <Button
                    key={v.id}
                    type="button"
                    variant={variantId === v.id ? "default" : "outline"}
                    className="min-h-11"
                    onClick={() => setVariantId(variantId === v.id ? undefined : v.id)}
                  >
                    {v.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {itemGroups.map((g) => (
            <div key={g.id} className="space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                {g.name}
                {g.required ? " · required" : ""}
              </Label>
              <div className="flex flex-wrap gap-2">
                {(g.modifiers ?? []).map((m: any) => (
                  <Button
                    key={m.id}
                    type="button"
                    variant={chosen.some((c) => c.modifierId === m.id) ? "default" : "outline"}
                    className="min-h-11"
                    onClick={() => toggle(g, m)}
                  >
                    {m.name}
                    {Number(m.price_delta ?? 0) !== 0 ? ` (+${Number(m.price_delta).toFixed(2)})` : ""}
                  </Button>
                ))}
              </div>
            </div>
          ))}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Kitchen note</Label>
              <Textarea rows={2} value={kitchenNote} onChange={(e) => setKitchenNote(e.target.value)} placeholder="No onions" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Guest note</Label>
              <Textarea rows={2} value={guestNote} onChange={(e) => setGuestNote(e.target.value)} placeholder="Birthday" />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={add} disabled={Boolean(unmetGroup)}>
            {unmetGroup ? `Choose ${unmetGroup.name}` : `Add · ${money((unitPrice + modifierPerUnit) * quantity, currency)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}