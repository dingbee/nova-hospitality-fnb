import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Minus, Plus, ShoppingBag, UtensilsCrossed, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
} from "@/components/ui/drawer";
import { LoadingState } from "@/components/os/LoadingState";
import { ErrorState } from "@/components/os/ErrorState";
import { EmptyState } from "@/components/os/EmptyState";
import {
  guestMenuFn,
  submitGuestOrderFn,
} from "@/modules/restaurant/selforder/selforder.functions";
import {
  confirmGuestPaymentFn,
  guestOrderStatusFn,
  initiateGuestPaymentFn,
} from "@/modules/restaurant/selforder/selfpay.functions";
import { GUEST_PAYMENT_METHODS } from "@/modules/restaurant/selforder/selfpay.contracts";
import type { SalesLineModifier } from "@/modules/restaurant/sales/sales.server";

export const Route = createFileRoute("/order/$tableId")({
  head: () => ({ meta: [{ title: "Order" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: GuestOrderPage,
});

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

type ModifierGroup = {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  required: boolean;
  modifiers: { id: string; group_id: string; name: string; price_delta: number }[];
};

type MenuItem = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  available: boolean;
  priceConfigured?: boolean;
  image_url: string | null;
  category_id: string | null;
  modifier_group_ids: string[];
};

type CartLine = {
  key: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  modifiers: SalesLineModifier[];
};

function GuestOrderPage() {
  const { tableId } = Route.useParams();
  const menuFn = useServerFn(guestMenuFn);
  const submitFn = useServerFn(submitGuestOrderFn);

  const menu = useQuery({
    queryKey: ["selforder.menu", tableId],
    queryFn: () => menuFn({ data: { tableId } }),
    retry: false,
  });

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [pickerItem, setPickerItem] = useState<MenuItem | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [confirmed, setConfirmed] = useState<{
    orderId: string;
    orderNumber: string;
    total: number;
  } | null>(null);

  const currency = menu.data?.table.currency ?? "USD";
  const items = (menu.data?.items ?? []) as MenuItem[];
  const categories = (menu.data?.categories ?? []) as { id: string; name: string }[];
  const groupsById = useMemo(() => {
    const map = new Map<string, ModifierGroup>();
    for (const g of (menu.data?.modifierGroups ?? []) as ModifierGroup[]) map.set(g.id, g);
    return map;
  }, [menu.data]);
  const filtered = categoryId ? items.filter((i) => i.category_id === categoryId) : items;

  const cartTotal = cart.reduce(
    (s, l) =>
      s +
      (l.unitPrice + l.modifiers.reduce((m, mod) => m + mod.priceDelta * mod.quantity, 0)) *
        l.quantity,
    0,
  );
  const cartCount = cart.reduce((s, l) => s + l.quantity, 0);

  const addToCart = (item: MenuItem, modifiers: SalesLineModifier[]) => {
    setCart((c) => [
      ...c,
      {
        key: `${item.id}:${Date.now()}`,
        menuItemId: item.id,
        name: item.name,
        unitPrice: Number(item.price ?? 0),
        quantity: 1,
        modifiers,
      },
    ]);
    setPickerItem(null);
  };

  const updateQty = (key: string, delta: number) => {
    setCart((c) =>
      c.flatMap((l) => {
        if (l.key !== key) return [l];
        const next = l.quantity + delta;
        return next <= 0 ? [] : [{ ...l, quantity: next }];
      }),
    );
  };

  const submit = useMutation({
    mutationFn: () =>
      submitFn({
        data: {
          tableId,
          guestName: guestName || undefined,
          lines: cart.map((l) => ({
            menuItemId: l.menuItemId,
            description: l.name,
            quantity: l.quantity,
            unitPrice: 0,
            discount: 0,
            modifiers: l.modifiers,
          })),
        },
      }),
    onSuccess: (order: { id: string; order_number: string; total: number }) => {
      setConfirmed({
        orderId: order.id,
        orderNumber: order.order_number,
        total: Number(order.total ?? 0),
      });
      setCart([]);
      setCartOpen(false);
    },
  });

  if (menu.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <LoadingState label="Loading the menu…" />
      </div>
    );
  }

  if (menu.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <ErrorState
          title="This table isn't available"
          description="Please ask a member of staff for help ordering."
        />
      </div>
    );
  }

  if (confirmed) {
    return (
      <div className="flex min-h-screen flex-col items-center gap-3 bg-background px-6 pt-16 text-center">
        <UtensilsCrossed className="size-10 text-primary" />
        <h1 className="text-xl font-semibold text-foreground">Order sent</h1>
        <p className="text-sm text-muted-foreground">
          Order {confirmed.orderNumber} — {money(confirmed.total, currency)}
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Your order is on its way to the kitchen and bar. A member of staff will bring it out
          shortly.
        </p>
        <GuestPaymentPanel tableId={tableId} orderId={confirmed.orderId} />
        <Button variant="outline" className="mt-2 min-h-11" onClick={() => setConfirmed(null)}>
          Order more
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24 text-foreground">
      <header className="sticky top-0 z-20 border-b bg-card/95 px-4 py-3 backdrop-blur">
        <p className="text-sm font-semibold">{menu.data?.table.tenantName}</p>
        <p className="text-xs text-muted-foreground">Table {menu.data?.table.tableName}</p>
      </header>

      <div className="sticky top-[57px] z-10 flex gap-2 overflow-x-auto bg-background/95 px-4 py-2 backdrop-blur">
        <Button
          size="sm"
          variant={categoryId ? "outline" : "default"}
          className="min-h-9 shrink-0"
          onClick={() => setCategoryId(null)}
        >
          All
        </Button>
        {categories.map((c) => (
          <Button
            key={c.id}
            size="sm"
            variant={categoryId === c.id ? "default" : "outline"}
            className="min-h-9 shrink-0"
            onClick={() => setCategoryId(c.id)}
          >
            {c.name}
          </Button>
        ))}
      </div>

      <main className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
        {filtered.length === 0 && (
          <div className="col-span-full">
            <EmptyState
              title="Nothing here yet"
              description="Check back soon, or try another category."
            />
          </div>
        )}
        {filtered.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={item.available === false || item.priceConfigured === false}
            onClick={() => setPickerItem(item)}
            className="flex flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-primary disabled:opacity-50"
          >
            <div className="flex aspect-square w-full items-center justify-center bg-muted">
              {item.image_url ? (
                <img src={item.image_url} alt="" className="size-full object-cover" />
              ) : (
                <UtensilsCrossed className="size-8 text-muted-foreground" aria-hidden />
              )}
            </div>
            <div className="flex flex-1 flex-col gap-1 p-2.5">
              <span className="text-sm font-medium leading-tight">{item.name}</span>
              <span className="mt-auto text-sm text-primary">
                {money(Number(item.price ?? 0), currency)}
              </span>
              {item.available === false && (
                <Badge variant="secondary" className="w-fit">
                  Unavailable
                </Badge>
              )}
            </div>
          </button>
        ))}
      </main>

      {pickerItem && (
        <ItemPicker
          item={pickerItem}
          currency={currency}
          groups={
            (pickerItem.modifier_group_ids ?? [])
              .map((id) => groupsById.get(id))
              .filter(Boolean) as ModifierGroup[]
          }
          onClose={() => setPickerItem(null)}
          onAdd={(mods) => addToCart(pickerItem, mods)}
        />
      )}

      {cartCount > 0 && !cartOpen && (
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          className="fixed inset-x-4 bottom-4 z-20 flex min-h-14 items-center justify-between rounded-lg bg-primary px-5 text-primary-foreground shadow-lg"
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <ShoppingBag className="size-4" /> {cartCount} item{cartCount === 1 ? "" : "s"}
          </span>
          <span className="text-sm font-semibold">{money(cartTotal, currency)}</span>
        </button>
      )}

      <Drawer open={cartOpen} onOpenChange={setCartOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Your order</DrawerTitle>
          </DrawerHeader>
          <div className="max-h-[50vh] space-y-3 overflow-y-auto px-4">
            {cart.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Your cart is empty.</p>
            ) : (
              cart.map((l) => (
                <div key={l.key} className="flex items-center justify-between gap-2 border-b pb-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{l.name}</p>
                    {l.modifiers.length > 0 && (
                      <p className="truncate text-xs text-muted-foreground">
                        {l.modifiers.map((m) => m.name).join(", ")}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {money(
                        l.unitPrice + l.modifiers.reduce((s, m) => s + m.priceDelta, 0),
                        currency,
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="icon"
                      variant="outline"
                      className="size-8"
                      onClick={() => updateQty(l.key, -1)}
                      aria-label="Remove one"
                    >
                      <Minus className="size-3.5" />
                    </Button>
                    <span className="w-4 text-center text-sm">{l.quantity}</span>
                    <Button
                      size="icon"
                      variant="outline"
                      className="size-8"
                      onClick={() => updateQty(l.key, 1)}
                      aria-label="Add one"
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
          <DrawerFooter>
            <label className="text-xs font-medium text-muted-foreground">
              Name (optional)
              <input
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="For the kitchen to call out"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
              />
            </label>
            <div className="flex items-center justify-between text-sm font-semibold">
              <span>Total</span>
              <span>{money(cartTotal, currency)}</span>
            </div>
            {submit.isError && (
              <p className="text-xs text-destructive">
                {(submit.error as Error).message || "Couldn't send your order — please try again."}
              </p>
            )}
            <Button
              className="min-h-12"
              disabled={cart.length === 0 || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? "Sending…" : "Send order"}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

function ItemPicker({
  item,
  currency,
  groups,
  onClose,
  onAdd,
}: {
  item: MenuItem;
  currency: string;
  groups: ModifierGroup[];
  onClose: () => void;
  onAdd: (modifiers: SalesLineModifier[]) => void;
}) {
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});

  const toggle = (group: ModifierGroup, modifierId: string) => {
    setSelected((s) => {
      const current = new Set(s[group.id] ?? []);
      const single = group.max_select <= 1;
      if (current.has(modifierId)) {
        current.delete(modifierId);
      } else {
        if (single) current.clear();
        else if (current.size >= group.max_select) return s;
        current.add(modifierId);
      }
      return { ...s, [group.id]: current };
    });
  };

  const missingRequired = groups.some(
    (g) => g.required && (selected[g.id]?.size ?? 0) < Math.max(1, g.min_select),
  );

  const chosenModifiers: SalesLineModifier[] = groups.flatMap((g) =>
    [...(selected[g.id] ?? [])].map((id) => {
      const m = g.modifiers.find((mm) => mm.id === id)!;
      return {
        modifierId: m.id,
        groupId: g.id,
        name: m.name,
        priceDelta: Number(m.price_delta ?? 0),
        quantity: 1,
      };
    }),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          {item.description && <DialogDescription>{item.description}</DialogDescription>}
        </DialogHeader>
        <p className="text-lg font-semibold text-primary">
          {money(Number(item.price ?? 0), currency)}
        </p>
        {groups.map((g) => (
          <div key={g.id} className="space-y-2">
            <p className="text-sm font-medium">
              {g.name}
              {g.required && <span className="ml-1 text-xs text-destructive">Required</span>}
            </p>
            <div className="flex flex-wrap gap-2">
              {g.modifiers.map((m) => {
                const active = selected[g.id]?.has(m.id) ?? false;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggle(g, m.id)}
                    className={`min-h-10 rounded-md border px-3 text-sm ${active ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}`}
                  >
                    {m.name}
                    {Number(m.price_delta ?? 0) > 0 &&
                      ` +${money(Number(m.price_delta), currency)}`}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex gap-2 pt-2">
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            <X className="size-4" /> Cancel
          </Button>
          <Button
            className="min-h-11 flex-1"
            disabled={missingRequired}
            onClick={() => onAdd(chosenModifiers)}
          >
            Add to order
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The one payment surface a guest can reach without staff help. Polls the
 * server-authoritative order/bill status (never trusts the total this page
 * itself just showed). "Pay now" starts a hosted checkout and navigates the
 * browser there — nothing is marked paid by that call. On return from
 * checkout (Pesapal appends ?OrderTrackingId=... to the URL this page gave
 * it), the tracking id is sent back for server-side re-verification before
 * anything is recorded; it is never trusted just because it's present in
 * the URL.
 */
function GuestPaymentPanel({ tableId, orderId }: { tableId: string; orderId: string }) {
  const statusFn = useServerFn(guestOrderStatusFn);
  const initiateFn = useServerFn(initiateGuestPaymentFn);
  const confirmFn = useServerFn(confirmGuestPaymentFn);
  const [method, setMethod] = useState<(typeof GUEST_PAYMENT_METHODS)[number]>("mobile_money");

  const status = useQuery({
    queryKey: ["selforder.paymentStatus", tableId, orderId],
    queryFn: () => statusFn({ data: { tableId, orderId } }),
    refetchInterval: 8_000,
  });

  const initiate = useMutation({
    mutationFn: () => initiateFn({ data: { tableId, orderId, method } }),
    onSuccess: (result) => {
      if (result.ok) window.location.href = result.redirectUrl;
    },
  });

  const orderTrackingId = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("OrderTrackingId");
  }, []);

  const confirm = useMutation({
    mutationFn: () => confirmFn({ data: { tableId, orderId, orderTrackingId: orderTrackingId! } }),
    onSuccess: () => {
      // Drop the provider's query params so a page refresh doesn't re-verify forever.
      window.history.replaceState({}, "", window.location.pathname);
      status.refetch();
    },
  });

  const confirmMutate = confirm.mutate;
  useEffect(() => {
    if (orderTrackingId) confirmMutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per mount when a tracking id is present, not on every render
  }, [orderTrackingId]);

  if (status.isPending || (orderTrackingId && confirm.isPending)) return null;
  if (status.isError || !status.data) return null;

  const s = status.data;
  const currency = s.currency;

  if (s.paymentState === "paid" || s.amountDue <= 0) {
    return (
      <div className="sig-raise mt-2 w-full max-w-sm rounded-lg border border-primary/30 bg-primary/5 p-4 text-left">
        <p className="text-sm font-semibold text-primary">Paid</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {money(s.total, currency)} settled on order {s.orderNumber}.
        </p>
      </div>
    );
  }

  const confirmResult = confirm.data;
  const initiateResult = initiate.data;

  return (
    <div className="mt-2 w-full max-w-sm rounded-lg border bg-card p-4 text-left">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Amount due</span>
        <span className="font-semibold">{money(s.amountDue, currency)}</span>
      </div>

      <div className="mt-3 flex gap-2">
        {GUEST_PAYMENT_METHODS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMethod(m)}
            className={`min-h-10 flex-1 rounded-md border px-3 text-sm capitalize ${method === m ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}`}
          >
            {m.replace("_", " ")}
          </button>
        ))}
      </div>

      {confirmResult && !confirmResult.ok && (
        <p className="mt-3 text-xs text-muted-foreground">
          {confirmResult.reason === "declined" &&
            `Payment wasn't accepted${confirmResult.detail ? `: ${confirmResult.detail}` : "."} Please try again or pay a member of staff.`}
          {confirmResult.reason === "expired" && "That payment attempt expired. Please try again."}
          {confirmResult.reason === "provider_not_configured" &&
            "Online payment isn't available at this venue yet — please pay a member of staff."}
          {confirmResult.reason === "already_paid" && "This order is already settled."}
        </p>
      )}
      {confirmResult?.ok && confirmResult.status === "pending" && (
        <p className="mt-3 text-xs text-muted-foreground">
          Still confirming your payment — this will update automatically.
        </p>
      )}
      {initiateResult && !initiateResult.ok && (
        <p className="mt-3 text-xs text-muted-foreground">
          {initiateResult.reason === "provider_not_configured" &&
            "Online payment isn't available at this venue yet — please pay a member of staff."}
          {initiateResult.reason === "not_payable" && "This order can no longer be paid online."}
          {initiateResult.reason === "already_paid" && "This order is already settled."}
        </p>
      )}
      {(initiate.isError || confirm.isError) && (
        <p className="mt-3 text-xs text-destructive">
          Couldn't reach the payment service. Please try again.
        </p>
      )}

      <Button
        className="mt-3 min-h-11 w-full"
        disabled={initiate.isPending}
        onClick={() => initiate.mutate()}
      >
        {initiate.isPending ? "Redirecting…" : "Pay now"}
      </Button>
    </div>
  );
}
