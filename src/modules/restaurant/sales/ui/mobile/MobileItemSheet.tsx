/* eslint-disable @typescript-eslint/no-explicit-any -- catalogue rows are untyped at this boundary, matching PosItemDialog. */
import { useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PosModifierInput } from "../../pos.contracts";
import { money, type CartLine } from "../pos-types";
import { firstUnmetRequiredGroup, modifierTotalPerUnit, resolveUnitPrice } from "../pos-money";
import { PosCompositionPanel } from "../PosCompositionPanel";
import { cn } from "@/lib/utils";

/**
 * Screen "Item configuration" — a full-height bottom sheet, not a
 * desktop-style modal dialog. Same pricing/validation as PosItemDialog (see
 * pos-money.ts), a mobile-appropriate presentation: one scroll region, one
 * pinned "Add to order" CTA that's always reachable without scrolling.
 */
export function MobileItemSheet({
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
  tenantId?: string;
  onClose: () => void;
  onAdd: (line: CartLine) => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const [variantId, setVariantId] = useState<string | undefined>(undefined);
  const [chosen, setChosen] = useState<PosModifierInput[]>([]);
  const [seat, setSeat] = useState("");
  const [kitchenNote, setKitchenNote] = useState("");
  const [guestNote, setGuestNote] = useState("");

  const itemGroups = useMemo(
    () => groups.filter((g) => (item?.modifier_group_ids ?? []).includes(g.id)),
    [groups, item],
  );

  const open = Boolean(item);
  const reset = () => {
    setQuantity(1);
    setVariantId(undefined);
    setChosen([]);
    setSeat("");
    setKitchenNote("");
    setGuestNote("");
  };

  if (!item) return null;

  const variant = (item.variants ?? []).find((v: any) => v.id === variantId);
  const unitPrice = resolveUnitPrice(item, variant);
  const modifierPerUnit = modifierTotalPerUnit(chosen);
  const lineTotal = (unitPrice + modifierPerUnit) * quantity;

  const toggle = (group: any, mod: any) => {
    setChosen((prev) => {
      const exists = prev.find((m) => m.modifierId === mod.id);
      if (exists) return prev.filter((m) => m.modifierId !== mod.id);
      const single = Number(group.max_select ?? 0) === 1;
      const cleaned = single ? prev.filter((m) => m.groupId !== group.id) : prev;
      return [
        ...cleaned,
        {
          modifierId: mod.id,
          groupId: group.id,
          name: mod.name,
          priceDelta: Number(mod.price_delta ?? 0),
          quantity: 1,
        },
      ];
    });
  };

  const unmetGroup = firstUnmetRequiredGroup(itemGroups, chosen);

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
    reset();
    onClose();
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <SheetContent
        side="bottom"
        className="flex h-[92vh] max-h-[92vh] flex-col gap-0 rounded-t-2xl p-0"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-5">
          <SheetTitle className="text-xl font-bold">{item.name}</SheetTitle>
          <p className="mt-1 text-lg font-semibold tabular-nums" style={{ color: "var(--lb-green)" }}>
            {money(unitPrice + modifierPerUnit, currency)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">per unit</span>
          </p>
          {item.allergens?.length ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Allergens: {item.allergens.join(", ")}
            </p>
          ) : null}

          <div className="mt-5 flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-12 rounded-full"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              aria-label="Decrease quantity"
            >
              <Minus className="size-5" />
            </Button>
            <span className="w-10 text-center text-2xl font-bold tabular-nums">{quantity}</span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-12 rounded-full"
              onClick={() => setQuantity((q) => q + 1)}
              aria-label="Increase quantity"
            >
              <Plus className="size-5" />
            </Button>
            <div className="ml-auto w-28">
              <Label className="text-xs text-muted-foreground">Seat</Label>
              <Input
                inputMode="numeric"
                placeholder={seats > 0 ? `1–${seats}` : "—"}
                value={seat}
                onChange={(e) => setSeat(e.target.value.replace(/\D/g, "").slice(0, 2))}
                className="h-11"
              />
            </div>
          </div>

          <div className="mt-5">
            <PosCompositionPanel tenantId={tenantId} menuItemId={item.id} quantity={quantity} />
          </div>

          {(item.variants ?? []).length > 0 && (
            <div className="mt-5 space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Variant
              </Label>
              <div className="flex flex-wrap gap-2">
                {(item.variants ?? []).map((v: any) => (
                  <ChoiceButton
                    key={v.id}
                    active={variantId === v.id}
                    onClick={() => setVariantId(variantId === v.id ? undefined : v.id)}
                  >
                    {v.name}
                  </ChoiceButton>
                ))}
              </div>
            </div>
          )}

          {itemGroups.map((g) => (
            <div key={g.id} className="mt-5 space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {g.name}
                {g.required ? " · required" : ""}
              </Label>
              <div className="flex flex-wrap gap-2">
                {(g.modifiers ?? []).map((m: any) => (
                  <ChoiceButton
                    key={m.id}
                    active={chosen.some((c) => c.modifierId === m.id)}
                    onClick={() => toggle(g, m)}
                  >
                    {m.name}
                    {Number(m.price_delta ?? 0) !== 0 ? ` (+${Number(m.price_delta).toFixed(2)})` : ""}
                  </ChoiceButton>
                ))}
              </div>
            </div>
          ))}

          <div className="mt-5 space-y-1">
            <Label className="text-xs text-muted-foreground">Kitchen note</Label>
            <Textarea
              rows={2}
              value={kitchenNote}
              onChange={(e) => setKitchenNote(e.target.value)}
              placeholder="No onions"
            />
          </div>
          <div className="mt-3 space-y-1 pb-2">
            <Label className="text-xs text-muted-foreground">Guest note</Label>
            <Textarea
              rows={2}
              value={guestNote}
              onChange={(e) => setGuestNote(e.target.value)}
              placeholder="Birthday"
            />
          </div>
        </div>

        <div className="shrink-0 border-t bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Button
            className="min-h-14 w-full rounded-xl text-base font-bold text-white"
            style={{ background: unmetGroup ? undefined : "var(--lb-green)" }}
            disabled={Boolean(unmetGroup)}
            onClick={add}
          >
            {unmetGroup ? `Choose ${unmetGroup.name}` : `Add to order · ${money(lineTotal, currency)}`}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ChoiceButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-h-11 rounded-full border px-4 text-sm font-medium transition-colors",
        active ? "border-transparent text-white" : "border-border bg-card text-foreground",
      )}
      style={active ? { background: "var(--lb-green)" } : undefined}
    >
      {children}
    </button>
  );
}
