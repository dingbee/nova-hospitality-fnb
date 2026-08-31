import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  Minus,
  Plus,
  Search,
  ShoppingBag,
  Sparkles,
  Star,
  UtensilsCrossed,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { requestGuestBillFn } from "@/modules/restaurant/selforder/selfbill.functions";
import { guestOrderProgressFn } from "@/modules/restaurant/selforder/selftrack.functions";
import {
  guestStaffRequestStatusFn,
  requestStaffFn,
} from "@/modules/restaurant/selforder/selfstaff.functions";
import {
  guestFeedbackStatusFn,
  submitGuestFeedbackFn,
} from "@/modules/restaurant/selforder/selffeedback.functions";
import { askNovaFn } from "@/modules/restaurant/selforder/selfnova.functions";
import type { AskNovaRecommendedItem } from "@/modules/restaurant/selforder/selfnova.server";
import {
  buildChosenModifiers,
  isMissingRequiredModifiers,
  resolveVariantUnitPrice,
  toggleModifierSelection,
  toGuestOrderLine,
  type ModifierGroup,
  type ModifierSelection,
  type ProductVariant,
} from "@/modules/restaurant/selforder/selforder-cart";
import {
  classifyRecoveredOrder,
  clearStoredOrderId,
  readStoredOrderId,
  readStoredSessionToken,
  readWelcomeSeen,
  writeStoredOrderId,
  writeStoredSessionToken,
  writeWelcomeSeen,
} from "@/modules/restaurant/selforder/selforder-recovery";
import type { SalesLineModifier } from "@/modules/restaurant/sales/sales.server";
import { searchMenuItems } from "@/modules/restaurant/selforder/selforder-search";

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
  variants?: ProductVariant[];
  /** Only present when set on the menu item itself — never inferred client-side. Used to decide whether "Vegetarian options" is a fair starter prompt for Ask NOVA. */
  tags?: string[];
};

type CartLine = {
  key: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  modifiers: SalesLineModifier[];
  variantId?: string;
  /** Kitchen-facing prep instruction ("no onions", "sauce on the side") — posLineSchema's `notes` field, printed on the ticket, not the receipt. */
  notes?: string;
};

function GuestOrderPage() {
  const { tableId } = Route.useParams();
  const menuFn = useServerFn(guestMenuFn);
  const submitFn = useServerFn(submitGuestOrderFn);

  // networkMode: "always" here and on every other query/mutation on this
  // page: React Query's default ("online") never even calls queryFn while
  // it believes the browser is offline, and only resumes on a window
  // 'online' event — it never times out, so isPending simply never
  // resolves. A guest's phone on restaurant wifi routinely fires a
  // spurious 'offline' event with no matching 'online' one (captive
  // portals, AP roaming between routers), which is exactly what left this
  // screen stuck on "Loading the menu…" with no error to show for it. The
  // fetch itself already handles a real network failure correctly
  // (isError); this only stops the browser's own online/offline guess from
  // pre-empting that fetch.
  const menu = useQuery({
    queryKey: ["selforder.menu", tableId],
    queryFn: () => menuFn({ data: { tableId } }),
    retry: false,
    networkMode: "always",
  });

  const [categoryId, setCategoryId] = useState<string | null>(null);
  // GEP1: universal menu search. Purely client-side over the items
  // guestMenuFn already fetched — no second network call per keystroke, no
  // second catalogue. See selforder-search.ts for the ranking rules.
  const [query, setQuery] = useState("");
  const [pickerItem, setPickerItem] = useState<MenuItem | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [novaOpen, setNovaOpen] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [confirmed, setConfirmed] = useState<{
    orderId: string;
    orderNumber: string;
    total: number;
  } | null>(null);

  // Order recovery: read only after mount, never during the initial render,
  // so a server-rendered "no stored order" pass never mismatches a client
  // hydration pass that would otherwise see localStorage immediately. See
  // selforder-recovery.ts for the full security model — this id is a hint,
  // re-validated server-side below before anything is shown or resumed.
  const [storedOrderId, setStoredOrderId] = useState<string | null>(null);
  // The guest's dining-session token for this table, if one was issued on a
  // previous order here — same "hint only" model as storedOrderId. It is
  // never assumed valid: resolveOrStartGuestSession re-validates it
  // server-side on every submission and simply issues a fresh one if it's
  // missing, expired, or belongs to a session that's since closed.
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  // Whether this browser has already tapped past the branded welcome for
  // this table. Read only after mount, same "hint only, never during the
  // initial render" reasoning as storedOrderId above — it decides one UI
  // moment (skip straight to the menu on reload) and never gates
  // authorization, so a hydration mismatch here has no security meaning.
  const [welcomeSeen, setWelcomeSeen] = useState(false);
  useEffect(() => {
    setStoredOrderId(readStoredOrderId(tableId));
    setSessionToken(readStoredSessionToken(tableId));
    setWelcomeSeen(readWelcomeSeen(tableId));
  }, [tableId]);

  const dismissRecovery = () => {
    clearStoredOrderId(tableId);
    setStoredOrderId(null);
  };

  const recoveryStatusFn = useServerFn(guestOrderStatusFn);
  const recovery = useQuery({
    queryKey: ["selforder.recovery", tableId, storedOrderId],
    queryFn: () => recoveryStatusFn({ data: { tableId, orderId: storedOrderId! } }),
    enabled: Boolean(storedOrderId),
    retry: false,
    networkMode: "always",
  });
  // "Order not found for this table" (wrong table, nonexistent id, tenant
  // mismatch) throws exactly like any other cross-table guest lookup —
  // treated identically to "nothing to recover".
  const recoveryOutcome = recovery.isError
    ? "none"
    : recovery.data
      ? classifyRecoveredOrder(recovery.data)
      : undefined;

  useEffect(() => {
    if (recoveryOutcome === "none") {
      dismissRecovery();
    } else if (recoveryOutcome === "paid" && recovery.data && storedOrderId) {
      setConfirmed({
        orderId: storedOrderId,
        orderNumber: recovery.data.orderNumber,
        total: recovery.data.total,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- act once when the outcome first resolves, not on every render
  }, [recoveryOutcome]);

  const currency = menu.data?.table.currency ?? "USD";
  const items = (menu.data?.items ?? []) as MenuItem[];
  const categories = (menu.data?.categories ?? []) as { id: string; name: string }[];
  const groupsById = useMemo(() => {
    const map = new Map<string, ModifierGroup>();
    for (const g of (menu.data?.modifierGroups ?? []) as ModifierGroup[]) map.set(g.id, g);
    return map;
  }, [menu.data]);
  // Keyed off menu.data (stable across renders once loaded) rather than the
  // `items`/`categories` derived arrays above, which are fresh `?? []`
  // references every render and would defeat the memo — same reasoning as
  // groupsById just above.
  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of (menu.data?.categories ?? []) as { id: string; name: string }[])
      map.set(c.id, c.name);
    return map;
  }, [menu.data]);
  const searchActive = query.trim().length > 0;
  // Search spans the whole published menu regardless of the selected
  // category (spec: "search overriding category filtering when a search is
  // active"); clearing the search restores ordinary category browsing.
  const filtered = useMemo(() => {
    if (searchActive) return searchMenuItems(items, query, categoryNameById);
    return categoryId ? items.filter((i) => i.category_id === categoryId) : items;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `items` is a fresh `?? []` reference every render (see comment above); menu.data is the real, stable dependency
  }, [menu.data, query, searchActive, categoryId, categoryNameById]);

  const cartTotal = cart.reduce(
    (s, l) =>
      s +
      (l.unitPrice + l.modifiers.reduce((m, mod) => m + mod.priceDelta * mod.quantity, 0)) *
        l.quantity,
    0,
  );
  const cartCount = cart.reduce((s, l) => s + l.quantity, 0);

  const addToCart = (
    item: MenuItem,
    selection: {
      modifiers: SalesLineModifier[];
      unitPrice: number;
      variantId?: string;
      variantName?: string;
      notes?: string;
    },
  ) => {
    setCart((c) => [
      ...c,
      {
        key: `${item.id}:${Date.now()}`,
        menuItemId: item.id,
        // Same convention PosItemDialog already uses: the variant name rides
        // along in the line description, so the kitchen ticket says "Burger
        // — Large" rather than just "Burger".
        name: selection.variantName ? `${item.name} — ${selection.variantName}` : item.name,
        unitPrice: selection.unitPrice,
        quantity: 1,
        modifiers: selection.modifiers,
        variantId: selection.variantId,
        notes: selection.notes,
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
          lines: cart.map(toGuestOrderLine),
          sessionToken: sessionToken ?? undefined,
        },
      }),
    networkMode: "always",
    onSuccess: (order: {
      id: string;
      order_number: string;
      total: number;
      guestSessionToken?: string;
    }) => {
      writeStoredOrderId(tableId, order.id);
      if (order.guestSessionToken) {
        writeStoredSessionToken(tableId, order.guestSessionToken);
        setSessionToken(order.guestSessionToken);
      }
      setConfirmed({
        orderId: order.id,
        orderNumber: order.order_number,
        total: Number(order.total ?? 0),
      });
      setCart([]);
      setCartOpen(false);
    },
  });

  // The one new guest-facing refusal this sprint adds: the server declined
  // to start or continue a dining session at this table (another session is
  // already active there). Every other submit failure keeps the existing
  // generic copy.
  const submitTableOccupied =
    submit.error instanceof Error && submit.error.message.includes("already has a dining session");

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
          onRetry={() => menu.refetch()}
        />
      </div>
    );
  }

  if (confirmed) {
    return (
      <div className="flex min-h-screen flex-col items-center gap-3 bg-background px-6 pt-20 pb-16 text-center pt-safe">
        <span className="flex size-16 items-center justify-center rounded-full bg-primary/10">
          <CheckCircle2 className="size-9 text-primary" aria-hidden />
        </span>
        <h1 className="font-display mt-2 text-2xl text-foreground">Order sent</h1>
        <p className="text-sm text-muted-foreground">
          Order <span className="font-medium text-foreground">{confirmed.orderNumber}</span> ·{" "}
          {money(confirmed.total, currency)}
        </p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Your order is on its way to the kitchen and bar. A member of staff will bring it out
          shortly.
        </p>
        <OrderProgressPanel tableId={tableId} orderId={confirmed.orderId} />
        <RequestStaffPanel tableId={tableId} orderId={confirmed.orderId} />
        <RequestBillPanel tableId={tableId} orderId={confirmed.orderId} />
        <GuestPaymentPanel tableId={tableId} orderId={confirmed.orderId} />
        <GuestFeedbackPanel tableId={tableId} orderId={confirmed.orderId} />
        <Button
          variant="outline"
          className="mt-4 min-h-11"
          onClick={() => {
            dismissRecovery();
            setConfirmed(null);
          }}
        >
          Order more
        </Button>
      </div>
    );
  }

  // A stored order exists and hasn't resolved to "paid" (which jumps
  // straight into the confirmed screen above) or "none" (dismissed
  // automatically) yet — still validating it server-side.
  if (storedOrderId && recoveryOutcome === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <LoadingState label="Checking your order…" />
      </div>
    );
  }

  if (recoveryOutcome === "offer" && storedOrderId && recovery.data) {
    return (
      <RecoveryPrompt
        onContinue={() =>
          setConfirmed({
            orderId: storedOrderId,
            orderNumber: recovery.data!.orderNumber,
            total: recovery.data!.total,
          })
        }
        onStartNew={dismissRecovery}
      />
    );
  }

  if (!welcomeSeen) {
    return (
      <GuestWelcome
        businessName={menu.data?.table.businessName ?? "our restaurant"}
        onContinue={() => {
          writeWelcomeSeen(tableId);
          setWelcomeSeen(true);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background pb-28 text-foreground">
      <div className="sticky top-0 z-20 bg-background/95 pt-safe backdrop-blur">
        <header className="border-b bg-card/95 px-4 pb-3">
          <div className="pt-3">
            <p className="eyebrow">Table {menu.data?.table.tableName}</p>
            <p className="font-display mt-0.5 text-xl leading-tight text-foreground">
              {menu.data?.table.businessName}
            </p>
          </div>
        </header>

        <div className="px-4 pt-2.5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the menu — try “fish”, “burger”, “vegetarian”…"
              aria-label="Search the menu"
              enterKeyHint="search"
              className="h-11 rounded-full bg-card pl-10 pr-10 text-sm"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex gap-2 overflow-x-auto px-4 py-2.5">
          <Button
            size="sm"
            variant={!searchActive && !categoryId ? "default" : "outline"}
            className="min-h-9 shrink-0 rounded-full"
            onClick={() => {
              setCategoryId(null);
              setQuery("");
            }}
          >
            All
          </Button>
          {categories.map((c) => (
            <Button
              key={c.id}
              size="sm"
              variant={!searchActive && categoryId === c.id ? "default" : "outline"}
              className="min-h-9 shrink-0 rounded-full"
              onClick={() => {
                setCategoryId(c.id);
                setQuery("");
              }}
            >
              {c.name}
            </Button>
          ))}
        </div>
      </div>

      {/*
        Future intelligence hook: a "Recommended for you" / "Popular
        tonight" rail belongs here, above the category grid, once a real
        recommendation source exists. Nothing is fabricated in the
        meantime — no placeholder rail is rendered without real data.
      */}

      <button
        type="button"
        onClick={() => setNovaOpen(true)}
        className="mx-4 mt-1 flex min-h-14 w-[calc(100%-2rem)] items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-4 text-left"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Sparkles className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-foreground">
            Not sure what to order?
          </span>
          <span className="block text-xs text-muted-foreground">Ask NOVA</span>
        </span>
      </button>

      <main className="p-4">
        {filtered.length === 0 && (
          <EmptyState
            title={searchActive ? "No matches" : "Nothing here yet"}
            description={
              searchActive
                ? `Nothing matched "${query.trim()}". Try a different word, or clear the search to browse by category.`
                : "Check back soon, or try another category."
            }
          />
        )}
        {filtered.length > 0 && (
          <div className="flex flex-col gap-2">
            {filtered.map((item) => (
              <MenuItemRow
                key={item.id}
                item={item}
                currency={currency}
                onSelect={() => setPickerItem(item)}
              />
            ))}
          </div>
        )}
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
          onAdd={(selection) => addToCart(pickerItem, selection)}
        />
      )}

      <AskNovaDrawer
        open={novaOpen}
        onOpenChange={setNovaOpen}
        tableId={tableId}
        items={items}
        onPickItem={(item) => {
          setNovaOpen(false);
          setPickerItem(item);
        }}
      />

      {cartCount > 0 && !cartOpen && (
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          className="fixed inset-x-4 bottom-4 z-20 flex min-h-14 items-center justify-between rounded-full bg-primary px-5 text-primary-foreground shadow-lg pb-safe"
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
            <DrawerTitle className="font-display text-xl">Your order</DrawerTitle>
          </DrawerHeader>
          <div className="max-h-[50vh] space-y-3 overflow-y-auto px-4">
            {cart.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Your cart is empty.</p>
            ) : (
              cart.map((l) => (
                <div key={l.key} className="flex items-center justify-between gap-2 border-b pb-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{l.name}</p>
                    {l.modifiers.length > 0 && (
                      <p className="truncate text-xs text-muted-foreground">
                        {l.modifiers.map((m) => m.name).join(", ")}
                      </p>
                    )}
                    {l.notes && (
                      <p className="truncate text-xs italic text-muted-foreground">"{l.notes}"</p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {money(
                        l.unitPrice + l.modifiers.reduce((s, m) => s + m.priceDelta, 0),
                        currency,
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2.5">
                    <Button
                      size="icon"
                      variant="outline"
                      className="size-9 rounded-full"
                      onClick={() => updateQty(l.key, -1)}
                      aria-label="Remove one"
                    >
                      <Minus className="size-3.5" />
                    </Button>
                    <span className="w-4 text-center text-sm font-medium">{l.quantity}</span>
                    <Button
                      size="icon"
                      variant="outline"
                      className="size-9 rounded-full"
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
          <DrawerFooter className="pb-safe">
            <label className="text-xs font-medium text-muted-foreground">
              Name (optional)
              <input
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="For the kitchen to call out"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
              />
            </label>
            <div className="flex items-center justify-between border-t pt-3 text-base font-semibold">
              <span>Total</span>
              <span>{money(cartTotal, currency)}</span>
            </div>
            {submit.isError && (
              <p className="text-xs text-destructive">
                {submitTableOccupied
                  ? "This table already has an order in progress. If this is your table, please ask a member of staff for help."
                  : "Couldn't send your order — please try again."}
              </p>
            )}
            <Button
              className="min-h-12 rounded-full text-base"
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

/**
 * Shown when a recoverable (still-active, unpaid) order was found for this
 * table from a stored recovery hint. Deliberately a choice, not an
 * automatic resume — a different guest picking up the same table's link
 * (or the same guest starting a fresh round) must never be silently
 * dropped into someone else's in-progress order.
 */
/**
 * The first thing a guest sees after scanning the table QR — a warm,
 * correctly branded welcome before the menu, not a bare product grid. Reuses
 * the guest portal's existing design system (no new visual language) and
 * needs nothing beyond the tenant's already-fetched businessName: no login,
 * no AI call, no new query. If AI services or anything else are down this
 * screen is unaffected — it renders the moment guestMenuFn's ordinary query
 * resolves, exactly like every other guest screen already does.
 */
function GuestWelcome({
  businessName,
  onContinue,
}: {
  businessName: string;
  onContinue: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center pt-safe">
      <span className="flex size-14 items-center justify-center rounded-full bg-primary/10">
        <Sparkles className="size-7 text-primary" aria-hidden />
      </span>
      <p className="eyebrow">Welcome to</p>
      <h1 className="font-display text-2xl text-foreground">{businessName}</h1>
      <p className="max-w-xs text-sm text-muted-foreground">
        We're delighted to have you with us. Take a look around and choose your favourites.
      </p>
      <div className="mt-3 flex w-full max-w-xs flex-col gap-2">
        <Button className="min-h-12 rounded-full text-base" onClick={onContinue}>
          Explore menu
        </Button>
      </div>
    </div>
  );
}

function RecoveryPrompt({
  onContinue,
  onStartNew,
}: {
  onContinue: () => void;
  onStartNew: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center pt-safe">
      <span className="flex size-14 items-center justify-center rounded-full bg-primary/10">
        <UtensilsCrossed className="size-7 text-primary" aria-hidden />
      </span>
      <h1 className="font-display text-2xl text-foreground">Welcome back</h1>
      <p className="max-w-xs text-sm text-muted-foreground">
        You have an order in progress at this table.
      </p>
      <div className="mt-3 flex w-full max-w-xs flex-col gap-2">
        <Button className="min-h-12 rounded-full text-base" onClick={onContinue}>
          Continue your order
        </Button>
        <Button variant="outline" className="min-h-11 rounded-full" onClick={onStartNew}>
          Start a new order
        </Button>
      </div>
    </div>
  );
}

/**
 * A single visual product card: image first, then name, a short
 * description when the catalogue has one, price and availability. The
 * whole card opens the modifier/quantity picker — there's no separate
 * "view" vs "add" affordance to tap around, which keeps one-handed
 * ordering fast.
 */
/**
 * GEP1: a compact, scannable row — the same interaction (tap -> ItemPicker
 * -> existing cart/order flow) as the old large card, just laid out so a
 * 100+ item menu (or a page of search results) doesn't force a guest to
 * scroll past oversized cards to find an ordinary product. The bigger,
 * fuller hospitality presentation (a larger photo, full description) now
 * lives in ItemPicker itself, which a tap always opens.
 */
function MenuItemRow({
  item,
  currency,
  onSelect,
}: {
  item: MenuItem;
  currency: string;
  onSelect: () => void;
}) {
  const disabled = item.available === false || item.priceConfigured === false;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="flex min-h-[4.5rem] w-full items-center gap-3 rounded-2xl border bg-card p-2.5 text-left shadow-sm transition-colors hover:border-primary disabled:opacity-50"
    >
      <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
        {item.image_url ? (
          <img src={item.image_url} alt="" className="size-full object-cover" />
        ) : (
          <UtensilsCrossed className="size-5 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight">{item.name}</p>
        {item.description && (
          <p className="line-clamp-1 text-xs text-muted-foreground">{item.description}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-primary">
            {money(Number(item.price ?? 0), currency)}
          </span>
          {item.available === false ? (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              Unavailable
            </Badge>
          ) : (
            (item.variants ?? []).length > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {item.variants!.length} options
              </Badge>
            )
          )}
        </div>
      </div>
    </button>
  );
}

type ItemSelection = {
  modifiers: SalesLineModifier[];
  unitPrice: number;
  variantId?: string;
  variantName?: string;
  notes?: string;
};

/** Selected-state marker shared by variant and modifier chips, so "chosen" reads identically everywhere in this dialog. */
function ChipCheck() {
  return <Check className="size-3.5" aria-hidden />;
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
  onAdd: (selection: ItemSelection) => void;
}) {
  const [selected, setSelected] = useState<ModifierSelection>({});
  // No restaurant_product_variants row carries a required/min/max-select
  // column (unlike modifier groups, which do) — a variant is never
  // mandatory here, matching the till's own PosItemDialog, which lets
  // "Add" proceed with no variant chosen too.
  const [variantId, setVariantId] = useState<string | undefined>(undefined);
  const [note, setNote] = useState("");

  const variants: ProductVariant[] = item.variants ?? [];
  const variant = variants.find((v) => v.id === variantId);
  const unitPrice = resolveVariantUnitPrice(Number(item.price ?? 0), variant);

  const toggle = (group: ModifierGroup, modifierId: string) =>
    setSelected((s) => toggleModifierSelection(s, group, modifierId));

  const missingRequired = isMissingRequiredModifiers(groups, selected);
  const chosenModifiers: SalesLineModifier[] = buildChosenModifiers(groups, selected);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl">
        {/*
          GEP1: the item's photo now lives here rather than on every row in
          the compact browsing list — the same "attractive hospitality
          presentation" the old large cards gave every item, just moved to
          the moment a guest actually taps in for a closer look.
        */}
        {item.image_url && (
          <div className="-mx-6 -mt-6 aspect-[16/9] w-[calc(100%+3rem)] overflow-hidden rounded-t-2xl bg-muted">
            <img src={item.image_url} alt="" className="size-full object-cover" />
          </div>
        )}
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{item.name}</DialogTitle>
          {item.description && <DialogDescription>{item.description}</DialogDescription>}
        </DialogHeader>
        <p className="text-lg font-semibold text-primary">{money(unitPrice, currency)}</p>

        {variants.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              Choose an option
              <span className="ml-1 text-xs font-normal text-muted-foreground">Optional</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {variants.map((v) => {
                const active = v.id === variantId;
                const vPrice = Number(v.price ?? 0);
                // Two distinct ways a variant's own price row can read:
                // a delta on top of the base price ("+2.00"), or a
                // standalone absolute price ("— 8.00") — never both.
                const priceLabel = v.price_is_delta
                  ? vPrice !== 0
                    ? ` (${vPrice > 0 ? "+" : ""}${money(vPrice, currency)})`
                    : ""
                  : ` — ${money(vPrice, currency)}`;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setVariantId(active ? undefined : v.id)}
                    aria-pressed={active}
                    className={`inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors ${active ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground"}`}
                  >
                    {active && <ChipCheck />}
                    {v.name}
                    {priceLabel}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.id} className="space-y-2">
            <p className="text-sm font-medium">
              {g.name}
              {g.required ? (
                <span className="ml-1 text-xs font-semibold text-destructive">Required</span>
              ) : (
                <span className="ml-1 text-xs font-normal text-muted-foreground">Optional</span>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {g.modifiers.map((m) => {
                const active = selected[g.id]?.has(m.id) ?? false;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggle(g, m.id)}
                    aria-pressed={active}
                    className={`inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors ${active ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground"}`}
                  >
                    {active && <ChipCheck />}
                    {m.name}
                    {Number(m.price_delta ?? 0) > 0 &&
                      ` +${money(Number(m.price_delta), currency)}`}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <div className="space-y-2">
          <label htmlFor="item-note" className="text-sm font-medium">
            Note for the kitchen
            <span className="ml-1 text-xs font-normal text-muted-foreground">Optional</span>
          </label>
          <textarea
            id="item-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. No onions, sauce on the side, mild"
            rows={2}
            maxLength={500}
            className="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
          />
        </div>

        <div className="flex gap-2 pt-2">
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            <X className="size-4" /> Cancel
          </Button>
          <Button
            className="min-h-11 flex-1"
            disabled={missingRequired}
            onClick={() =>
              onAdd({
                modifiers: chosenModifiers,
                unitPrice,
                variantId,
                variantName: variant?.name,
                notes: note.trim() || undefined,
              })
            }
          >
            Add to order
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Lets the guest ask for their bill without flagging down staff. Idempotent
 * server-side (requestGuestBill returns the existing bill_requested_at
 * rather than writing a second one), so a double tap or a page reload
 * after tapping is always safe — this component's own "already requested"
 * view just doesn't persist across a reload, since nothing here needs a
 * new read path to guarantee that safety property.
 */
const GUEST_STAGE_STEPS = ["received", "preparing", "ready", "served"] as const;
const GUEST_STAGE_LABEL: Record<(typeof GUEST_STAGE_STEPS)[number], string> = {
  received: "Order received",
  preparing: "Preparing",
  ready: "Ready",
  served: "Served",
};

/**
 * Redacted, station-aware view of the guest's own order moving through the
 * kitchen and bar. Reuses the canonical order/ticket lifecycle end to end
 * (see selftrack.server.ts / selforder-tracking.ts) rather than a second
 * workflow, and polls with the same safe pattern GuestPaymentPanel already
 * uses below instead of a new realtime layer.
 */
function OrderProgressPanel({ tableId, orderId }: { tableId: string; orderId: string }) {
  const progressFn = useServerFn(guestOrderProgressFn);
  const progress = useQuery({
    queryKey: ["selforder.progress", tableId, orderId],
    queryFn: () => progressFn({ data: { tableId, orderId } }),
    refetchInterval: 8_000,
    networkMode: "always",
  });

  if (progress.isPending || progress.isError || !progress.data) return null;
  const { overallStage, streams } = progress.data;

  if (overallStage === "cancelled") {
    return (
      <div className="mt-2 w-full max-w-sm rounded-2xl border bg-card p-4 text-left">
        <p className="text-sm font-semibold text-foreground">Order cancelled</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Please speak to a member of staff if this doesn't look right.
        </p>
      </div>
    );
  }

  const currentIndex = GUEST_STAGE_STEPS.indexOf(overallStage);

  return (
    <div className="mt-2 w-full max-w-sm rounded-2xl border bg-card p-4 text-left">
      <p className="text-sm font-semibold text-foreground">{GUEST_STAGE_LABEL[overallStage]}</p>

      <div className="mt-3 flex items-center">
        {GUEST_STAGE_STEPS.map((step, i) => (
          <div key={step} className="flex flex-1 items-center last:flex-none">
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                i <= currentIndex
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {i + 1}
            </span>
            {i < GUEST_STAGE_STEPS.length - 1 && (
              <span
                className={`mx-1 h-0.5 flex-1 rounded ${i < currentIndex ? "bg-primary" : "bg-muted"}`}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex text-[10px] text-muted-foreground">
        {GUEST_STAGE_STEPS.map((step) => (
          <span key={step} className="flex-1 text-center first:text-left last:text-right">
            {GUEST_STAGE_LABEL[step]}
          </span>
        ))}
      </div>

      {streams.length > 1 && (
        <div className="mt-3 space-y-1 border-t pt-3">
          {streams.map((s) => (
            <div key={s.station} className="flex items-center justify-between text-xs">
              <span className="capitalize text-muted-foreground">{s.station}</span>
              <span className="font-medium text-foreground">{GUEST_STAGE_LABEL[s.stage]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The first live guest-to-staff alert. Polls the same safe pattern every
 * other guest panel on this screen uses (see OrderProgressPanel /
 * GuestPaymentPanel) rather than a new realtime layer — see
 * selfstaff.server.ts for the spam-controlled write and read this wraps.
 */
function RequestStaffPanel({ tableId, orderId }: { tableId: string; orderId: string }) {
  const requestFn = useServerFn(requestStaffFn);
  const statusFn = useServerFn(guestStaffRequestStatusFn);

  const status = useQuery({
    queryKey: ["selforder.staffRequest", tableId, orderId],
    queryFn: () => statusFn({ data: { tableId, orderId } }),
    refetchInterval: 8_000,
    networkMode: "always",
  });

  const request = useMutation({
    mutationFn: async () => {
      const result = await requestFn({ data: { tableId, orderId } });
      // Refetch before settling so the UI reflects the new state the
      // instant the button stops showing "Requesting…", instead of
      // waiting for the next 8s poll.
      await status.refetch();
      return result;
    },
    networkMode: "always",
  });

  if (status.isPending || !status.data) return null;
  const s = status.data;

  if (s.ok && s.status === "acknowledged") {
    return (
      <div className="mt-2 w-full max-w-sm rounded-2xl border border-primary/30 bg-primary/5 p-4 text-left">
        <p className="text-sm font-semibold text-primary">Staff acknowledged</p>
        <p className="mt-1 text-xs text-muted-foreground">Someone will be with you shortly.</p>
      </div>
    );
  }

  if (s.ok && s.status === "requested") {
    return (
      <div className="mt-2 w-full max-w-sm rounded-2xl border border-primary/30 bg-primary/5 p-4 text-left">
        <p className="text-sm font-semibold text-primary">Staff requested</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A member of our team has been notified.
        </p>
      </div>
    );
  }

  if (request.data && !request.data.ok) {
    return (
      <div className="mt-2 w-full max-w-sm rounded-2xl border bg-card p-4 text-left">
        <p className="text-xs text-muted-foreground">
          Staff can't be requested right now — please ask a member of staff directly.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <Button
        variant="outline"
        className="min-h-11 w-full rounded-full"
        disabled={request.isPending}
        onClick={() => request.mutate()}
      >
        {request.isPending ? "Requesting…" : "Need assistance? Request staff"}
      </Button>
      {request.isError && (
        <p className="mt-2 text-xs text-destructive">Couldn't reach staff. Please try again.</p>
      )}
    </div>
  );
}

function RequestBillPanel({ tableId, orderId }: { tableId: string; orderId: string }) {
  const requestFn = useServerFn(requestGuestBillFn);
  const request = useMutation({
    mutationFn: () => requestFn({ data: { tableId, orderId } }),
    networkMode: "always",
  });

  if (request.data?.ok) {
    return (
      <div className="mt-2 w-full max-w-sm rounded-2xl border border-primary/30 bg-primary/5 p-4 text-left">
        <p className="text-sm font-semibold text-primary">Bill requested</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A member of staff will be with you shortly.
        </p>
      </div>
    );
  }

  if (request.data && !request.data.ok) {
    return (
      <div className="mt-2 w-full max-w-sm rounded-2xl border bg-card p-4 text-left">
        <p className="text-xs text-muted-foreground">
          This order can no longer request a bill — please ask a member of staff.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <Button
        variant="outline"
        className="min-h-11 w-full rounded-full"
        disabled={request.isPending}
        onClick={() => request.mutate()}
      >
        {request.isPending ? "Requesting…" : "Request bill"}
      </Button>
      {request.isError && (
        <p className="mt-2 text-xs text-destructive">
          Couldn't request the bill. Please try again.
        </p>
      )}
    </div>
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
    networkMode: "always",
  });

  const initiate = useMutation({
    mutationFn: () => initiateFn({ data: { tableId, orderId, method } }),
    networkMode: "always",
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
    networkMode: "always",
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
      <div className="mt-2 w-full max-w-sm rounded-2xl border border-primary/30 bg-primary/5 p-4 text-left">
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
    <div className="mt-2 w-full max-w-sm rounded-2xl border bg-card p-4 text-left">
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
            className={`min-h-10 flex-1 rounded-full border px-3 text-sm capitalize transition-colors ${method === m ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}`}
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
        className="mt-3 min-h-11 w-full rounded-full text-base"
        disabled={initiate.isPending}
        onClick={() => initiate.mutate()}
      >
        {initiate.isPending ? "Redirecting…" : "Pay now"}
      </Button>
    </div>
  );
}

const FEEDBACK_ACK: Record<
  "service_recovery" | "thanks" | "advocacy_ready",
  { title: string; body: string }
> = {
  service_recovery: {
    title: "Thank you for telling us",
    body: "We're sorry your visit fell short — a member of our team has been notified.",
  },
  thanks: {
    title: "Thank you for your feedback",
    body: "We appreciate you taking the time to let us know how it went.",
  },
  advocacy_ready: {
    title: "Thank you — glad you enjoyed it!",
    body: "We're so happy you had a great experience with us.",
  },
};

/**
 * Post-payment "How was your experience?" — only ever shown once
 * guestFeedbackStatusFn reports the order as paid (server-derived, never
 * the client's own belief about payment state). One rating per order:
 * once submitted, the same server-authoritative record is shown back
 * rather than letting the guest change it. No external review link is
 * produced here — 4-5 stars only marks the moment a future phase could
 * offer one.
 */
function GuestFeedbackPanel({ tableId, orderId }: { tableId: string; orderId: string }) {
  const statusFn = useServerFn(guestFeedbackStatusFn);
  const submitFn = useServerFn(submitGuestFeedbackFn);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");

  const status = useQuery({
    queryKey: ["selforder.feedbackStatus", tableId, orderId],
    queryFn: () => statusFn({ data: { tableId, orderId } }),
    refetchInterval: 8_000,
    networkMode: "always",
  });

  const submit = useMutation({
    mutationFn: (vars: { rating: number; comment: string }) =>
      submitFn({
        data: { tableId, orderId, rating: vars.rating, comment: vars.comment || undefined },
      }),
    networkMode: "always",
    onSuccess: () => status.refetch(),
  });

  if (status.isPending || !status.data || !status.data.eligible) return null;

  const submitted = status.data.submitted ? status.data : submit.data?.ok ? submit.data : null;
  if (submitted) {
    const ack = FEEDBACK_ACK[submitted.routing];
    return (
      <div className="mt-2 w-full max-w-sm rounded-2xl border border-primary/30 bg-primary/5 p-4 text-left">
        <p className="flex items-center gap-1 text-sm font-semibold text-primary">
          {Array.from({ length: 5 }, (_, i) => (
            <Star
              key={i}
              className={`size-4 ${i < submitted.rating ? "fill-primary text-primary" : "text-muted-foreground/40"}`}
            />
          ))}
        </p>
        <p className="mt-2 text-sm font-semibold text-foreground">{ack.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{ack.body}</p>
      </div>
    );
  }

  return (
    <div className="mt-2 w-full max-w-sm rounded-2xl border bg-card p-4 text-left">
      <p className="text-sm font-semibold text-foreground">How was your experience?</p>
      <div className="mt-2 flex items-center gap-1">
        {Array.from({ length: 5 }, (_, i) => {
          const value = i + 1;
          return (
            <button
              key={value}
              type="button"
              aria-label={`${value} star${value === 1 ? "" : "s"}`}
              className="min-h-11 min-w-11 flex items-center justify-center"
              onClick={() => setRating(value)}
            >
              <Star
                className={`size-7 ${rating !== null && value <= rating ? "fill-primary text-primary" : "text-muted-foreground/40"}`}
              />
            </button>
          );
        })}
      </div>
      {rating !== null && (
        <>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Anything you'd like to add? (optional)"
            className="mt-3 min-h-20"
            maxLength={1000}
          />
          <Button
            className="mt-3 min-h-11 w-full rounded-full"
            disabled={submit.isPending}
            onClick={() => submit.mutate({ rating, comment })}
          >
            {submit.isPending ? "Sending…" : "Submit feedback"}
          </Button>
          {submit.isError && (
            <p className="mt-2 text-xs text-destructive">
              Couldn't send feedback. Please try again.
            </p>
          )}
        </>
      )}
    </div>
  );
}

type NovaTurn =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; recommendedItems: AskNovaRecommendedItem[] }
  | { id: string; role: "fallback"; categories: { id: string; name: string }[] };

function newTurnId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

const NOVA_STARTER_PROMPTS = ["Recommend something for me", "Something light", "Something filling"];

/**
 * "Not sure what to order?" — a compact chat over the exact same
 * table-scoped sellable catalogue the ordering screen itself shows (see
 * selfnova.server.ts). Recommending an item never opens a second cart
 * mechanism: tapping one just opens the same ItemPicker the menu grid
 * already uses (onPickItem), so the modifier -> cart -> order flow stays
 * the only path to actually ordering anything.
 */
function AskNovaDrawer({
  open,
  onOpenChange,
  tableId,
  items,
  onPickItem,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableId: string;
  items: MenuItem[];
  onPickItem: (item: MenuItem) => void;
}) {
  const askFn = useServerFn(askNovaFn);
  const [turns, setTurns] = useState<NovaTurn[]>([]);
  const [input, setInput] = useState("");

  const ask = useMutation({
    mutationFn: (message: string) => {
      // Only real prior chat turns become history — a fallback notice was
      // never something NOVA actually said, so it isn't replayed as if it
      // were part of the conversation.
      const history = turns
        .filter(
          (t): t is Extract<NovaTurn, { role: "user" | "assistant" }> =>
            t.role === "user" || t.role === "assistant",
        )
        .map((t) => ({ role: t.role, content: t.content }));
      return askFn({ data: { tableId, message, history } });
    },
    networkMode: "always",
    onSuccess: (result) => {
      setTurns((t) => [
        ...t,
        result.ok
          ? {
              id: newTurnId(),
              role: "assistant",
              content: result.reply,
              recommendedItems: result.recommendedItems,
            }
          : { id: newTurnId(), role: "fallback", categories: result.categories },
      ]);
    },
  });

  const send = (message: string) => {
    const text = message.trim();
    if (!text || ask.isPending) return;
    setTurns((t) => [...t, { id: newTurnId(), role: "user", content: text }]);
    setInput("");
    ask.mutate(text);
  };

  const findItem = (id: string) => items.find((i) => i.id === id) ?? null;
  const hasVegetarianTag = items.some((i) => (i.tags ?? []).includes("vegetarian"));
  const starters = hasVegetarianTag
    ? [...NOVA_STARTER_PROMPTS, "Vegetarian options"]
    : NOVA_STARTER_PROMPTS;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="font-display flex items-center gap-1.5 text-xl">
            <Sparkles className="size-4 text-primary" /> Ask NOVA
          </DrawerTitle>
        </DrawerHeader>

        <div className="max-h-[50vh] space-y-3 overflow-y-auto px-4 pb-2">
          {turns.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Tell me what you're in the mood for, or tap a suggestion below.
            </p>
          )}
          {turns.map((t) => {
            if (t.role === "user") {
              return (
                <div
                  key={t.id}
                  className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
                >
                  {t.content}
                </div>
              );
            }
            if (t.role === "assistant") {
              return (
                <div key={t.id} className="mr-auto max-w-[90%] space-y-2">
                  <div className="rounded-2xl rounded-tl-sm border bg-card px-3 py-2 text-sm">
                    {t.content}
                  </div>
                  {t.recommendedItems.map((r) => {
                    const full = findItem(r.id);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        disabled={!full}
                        onClick={() => full && onPickItem(full)}
                        className="flex min-h-11 w-full items-center justify-between rounded-xl border bg-card px-3 py-2 text-left disabled:opacity-50"
                      >
                        <span className="text-sm font-medium">{r.name}</span>
                        <span className="text-sm text-muted-foreground">
                          {money(r.price, r.currency)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            }
            return (
              <div key={t.id} className="mr-auto max-w-[90%] space-y-2">
                <div className="rounded-2xl rounded-tl-sm border bg-card px-3 py-2 text-sm text-muted-foreground">
                  NOVA isn't available right now — here's the menu by category instead.
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {t.categories.map((c) => (
                    <Badge key={c.id} variant="outline" className="rounded-full">
                      {c.name}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })}
          {ask.isPending && (
            <div className="mr-auto max-w-[90%] rounded-2xl rounded-tl-sm border bg-card px-3 py-2 text-sm text-muted-foreground">
              Thinking…
            </div>
          )}
        </div>

        {turns.length === 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pb-3">
            {starters.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="min-h-9 rounded-full border px-3 text-xs text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <DrawerFooter>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about the menu…"
              className="h-11"
            />
            <Button
              type="submit"
              disabled={ask.isPending || !input.trim()}
              className="min-h-11 shrink-0"
            >
              Send
            </Button>
          </form>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
