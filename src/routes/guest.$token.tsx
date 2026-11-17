import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Search, MessageCircle, UtensilsCrossed, ShoppingBag, Plus, Minus, X, CheckCircle2 } from "lucide-react";
import { PRODUCT } from "@/config/product";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { guestCommercePageFn } from "@/modules/restaurant/selforder/whatsapp-guest-portal.functions";
import {
  submitGuestCommerceOrderFn,
  guestCommerceOrderStatusFn,
} from "@/modules/restaurant/guest-commerce/orders.functions";

export const Route = createFileRoute("/guest/$token")({
  loader: async ({ params }) => guestCommercePageFn({ data: { token: params.token } }),
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.businessName ?? "Guest Menu"} — ${PRODUCT.guestFacingName}` },
      { name: "robots", content: "noindex,nofollow" },
      { name: "referrer", content: "no-referrer" },
      { "http-equiv": "Cache-Control", content: "no-store, private, max-age=0" },
      { name: "theme-color", content: "#346739" },
    ],
  }),
  component: GuestCommercePage,
});

type PortalModifier = { id: string; name: string; price_delta: number };
type PortalModifierGroup = {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  required: boolean;
  modifiers: PortalModifier[];
};
type PortalItem = {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  currency?: string | null;
  image_url?: string | null;
  category_id?: string | null;
  tags?: string[] | null;
  allergens?: string[] | null;
  variants?: Array<{ id: string; name: string; price: number; price_is_delta: boolean }>;
  modifier_group_ids?: string[];
};
type CartLine = {
  key: string;
  menuItemId: string;
  variantId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  modifiers: Array<{ modifierId: string; groupId: string; name: string; priceDelta: number; quantity: number }>;
};
type ConfirmedOrder = {
  orderId: string;
  orderNumber: string;
  status: string;
  orderType: string;
  currency: string;
  total: number;
  paymentState: string;
  idempotent?: boolean;
};

function formatMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function GuestCommercePage() {
  const data = Route.useLoaderData();
  const { token } = Route.useParams();
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<PortalItem | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [selectedModifiers, setSelectedModifiers] = useState<Record<string, string[]>>({});
  const [optionError, setOptionError] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [confirmedOrder, setConfirmedOrder] = useState<ConfirmedOrder | null>(null);
  const [tracking, setTracking] = useState(false);

  const items = data.items as PortalItem[];
  const categories = data.categories as Array<{ id: string; name: string }>;
  const modifierGroups = (data.modifierGroups ?? []) as PortalModifierGroup[];

  const visibleItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => {
      const matchesCategory = !categoryId || item.category_id === categoryId;
      const matchesSearch =
        !query ||
        item.name.toLowerCase().includes(query) ||
        (item.description ?? "").toLowerCase().includes(query) ||
        (item.tags ?? []).some((tag) => tag.toLowerCase().includes(query));
      return matchesCategory && matchesSearch;
    });
  }, [items, search, categoryId]);

  const supportDigits = (data.supportPhone ?? "").replace(/[^0-9]/g, "");
  const supportUrl = supportDigits ? `https://wa.me/${supportDigits}` : null;
  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const cartTotal = cart.reduce(
    (sum, line) =>
      sum +
      line.quantity *
        (line.unitPrice +
          line.modifiers.reduce((modifierSum, modifier) => modifierSum + modifier.priceDelta * modifier.quantity, 0)),
    0,
  );
  const selectedGroups = selectedItem
    ? modifierGroups.filter((group) => (selectedItem.modifier_group_ids ?? []).includes(group.id))
    : [];

  function addLine(line: Omit<CartLine, "key">) {
    const key = [
      line.menuItemId,
      line.variantId ?? "",
      line.modifiers.map((modifier) => modifier.modifierId).sort().join(","),
    ].join(":");
    setCart((current) => {
      const existing = current.find((entry) => entry.key === key);
      if (existing) return current.map((entry) => entry.key === key ? { ...entry, quantity: entry.quantity + 1 } : entry);
      return [...current, { ...line, key }];
    });
  }

  function beginAddItem(item: PortalItem) {
    if (!data.canCheckout) return;
    const groups = modifierGroups.filter((group) => (item.modifier_group_ids ?? []).includes(group.id));
    if ((item.variants?.length ?? 0) > 0 || groups.length > 0) {
      setSelectedItem(item);
      setSelectedVariantId(item.variants?.[0]?.id ?? "");
      setSelectedModifiers({});
      setOptionError("");
      return;
    }
    addLine({
      menuItemId: item.id,
      description: item.name,
      quantity: 1,
      unitPrice: Number(item.price),
      discount: 0,
      modifiers: [],
    });
  }

  function toggleModifier(group: PortalModifierGroup, modifier: PortalModifier) {
    setSelectedModifiers((current) => {
      const selected = current[group.id] ?? [];
      if (selected.includes(modifier.id)) {
        return { ...current, [group.id]: selected.filter((id) => id !== modifier.id) };
      }
      if (selected.length >= group.max_select) return current;
      return { ...current, [group.id]: [...selected, modifier.id] };
    });
  }

  function addSelectedItem() {
    if (!selectedItem) return;
    for (const group of selectedGroups) {
      const count = (selectedModifiers[group.id] ?? []).length;
      const minimum = Math.max(group.min_select ?? 0, group.required ? 1 : 0);
      if (count < minimum || count > group.max_select) {
        setOptionError(`Choose ${minimum} or more option(s) for ${group.name}.`);
        return;
      }
    }
    if ((selectedItem.variants?.length ?? 0) > 0 && !selectedVariantId) {
      setOptionError("Choose an option before adding this item.");
      return;
    }
    const modifiers = selectedGroups.flatMap((group) =>
      (selectedModifiers[group.id] ?? []).map((id) => {
        const modifier = group.modifiers.find((candidate) => candidate.id === id)!;
        return {
          modifierId: modifier.id,
          groupId: group.id,
          name: modifier.name,
          priceDelta: Number(modifier.price_delta ?? 0),
          quantity: 1,
        };
      }),
    );
    const variant = selectedItem.variants?.find((candidate) => candidate.id === selectedVariantId);
    addLine({
      menuItemId: selectedItem.id,
      variantId: variant?.id,
      description: variant ? `${selectedItem.name} — ${variant.name}` : selectedItem.name,
      quantity: 1,
      unitPrice: Number(selectedItem.price),
      discount: 0,
      modifiers,
    });
    setSelectedItem(null);
  }

  function changeQuantity(key: string, delta: number) {
    setCart((current) =>
      current
        .map((line) => line.key === key ? { ...line, quantity: line.quantity + delta } : line)
        .filter((line) => line.quantity > 0),
    );
  }

  async function placeOrder() {
    if (submitting || cart.length === 0) return;
    setSubmitting(true);
    setSubmitError("");
    const stableRequestId = requestId ?? `guest-${crypto.randomUUID()}`;
    setRequestId(stableRequestId);
    try {
      const result = await submitGuestCommerceOrderFn({
        data: {
          token,
          guestName: guestName.trim() || undefined,
          clientRequestId: stableRequestId,
          lines: cart.map(({ key: _key, ...line }) => line),
        },
      });
      setConfirmedOrder(result as ConfirmedOrder);
      setCart([]);
      setCheckoutOpen(false);
      setCartOpen(false);
      setRequestId(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "We could not place the order. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function refreshOrderStatus() {
    if (!confirmedOrder || tracking) return;
    setTracking(true);
    try {
      const result = await guestCommerceOrderStatusFn({ data: { token, orderId: confirmedOrder.orderId } });
      setConfirmedOrder((current) => current ? { ...current, ...result } : current);
    } catch {
      // The confirmed order remains visible; the guest can retry status lookup.
    } finally {
      setTracking(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f7f8f5] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {data.businessLogoUrl ? (
              <img src={data.businessLogoUrl} alt="" className="h-12 w-12 rounded-xl border border-slate-100 object-cover" referrerPolicy="no-referrer" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800">
                <UtensilsCrossed className="h-6 w-6" />
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold">{data.businessName}</p>
              <p className="truncate text-xs text-slate-500">{data.propertyName} · {data.outletName}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {supportUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={supportUrl} target="_blank" rel="noreferrer">
                  <MessageCircle className="mr-2 h-4 w-4" />
                  Help
                </a>
              </Button>
            ) : null}
            {data.canCheckout && cartCount > 0 ? (
              <Button size="sm" onClick={() => setCartOpen(true)}>
                <ShoppingBag className="mr-2 h-4 w-4" />
                Cart ({cartCount})
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-4 pb-24 pt-7 sm:px-6">
        {confirmedOrder ? (
          <div className="mx-auto max-w-xl rounded-2xl border border-emerald-200 bg-white p-7 text-center shadow-sm">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-700" />
            <p className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Order received</p>
            <h1 className="mt-2 text-2xl font-semibold">Thank you</h1>
            <p className="mt-2 text-sm text-slate-500">Your order number is <strong>{confirmedOrder.orderNumber}</strong>.</p>
            <p className="mt-4 text-2xl font-bold">{formatMoney(Number(confirmedOrder.total ?? 0), confirmedOrder.currency ?? data.currency)}</p>
            <p className="mt-1 text-sm text-slate-500">Status: {confirmedOrder.status} · Payment: {confirmedOrder.paymentState}</p>
            <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
              <Button variant="outline" onClick={refreshOrderStatus} disabled={tracking}>
                {tracking ? "Checking…" : "Refresh order status"}
              </Button>
              <Button onClick={() => setConfirmedOrder(null)}>Back to menu</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-7 rounded-2xl bg-emerald-950 px-5 py-6 text-white sm:px-8">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">{PRODUCT.guestFacingName} Guest Commerce</p>
              <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">Explore the menu</h1>
              <p className="mt-2 max-w-2xl text-sm text-emerald-100">
                Browse the current menu at {data.outletName}. Availability, modifiers and prices are revalidated by the restaurant's commerce engine when you place your order.
              </p>
              {data.businessDescription ? <p className="mt-3 max-w-2xl text-sm text-emerald-100">{data.businessDescription}</p> : null}
              {!data.canCheckout ? (
                <p className="mt-4 rounded-xl bg-white/10 px-3 py-2 text-sm text-emerald-50">
                  This outlet requires a table QR code or a verified guest-room assignment before checkout.
                </p>
              ) : null}
              {data.tableServiceUrl ? (
                <div className="mt-4">
                  <a href={data.tableServiceUrl} className="inline-flex items-center rounded-lg border border-emerald-300/50 px-3 py-2 text-sm text-emerald-50 hover:bg-white/10">
                    Need staff assistance or your bill? Open table service tools
                  </a>
                </div>
              ) : null}
            </div>

            <div className="mb-5 flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search the menu" className="h-11 rounded-xl bg-white pl-10" />
              </div>
            </div>

            {categories.length > 0 ? (
              <div className="mb-6 flex gap-2 overflow-x-auto pb-2">
                <Button size="sm" variant={categoryId === null ? "default" : "outline"} className="shrink-0 rounded-full" onClick={() => setCategoryId(null)}>All</Button>
                {categories.map((category) => (
                  <Button key={category.id} size="sm" variant={categoryId === category.id ? "default" : "outline"} className="shrink-0 rounded-full" onClick={() => setCategoryId(category.id)}>{category.name}</Button>
                ))}
              </div>
            ) : null}

            {visibleItems.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
                <UtensilsCrossed className="mx-auto h-8 w-8 text-slate-400" />
                <h2 className="mt-3 font-semibold">No menu items found</h2>
                <p className="mt-1 text-sm text-slate-500">Try another search or check back with the restaurant.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visibleItems.map((item) => (
                  <article key={item.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    {item.image_url ? (
                      <img src={item.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-44 w-full object-cover" />
                    ) : (
                      <div className="flex h-32 items-center justify-center bg-slate-100 text-slate-400"><UtensilsCrossed className="h-8 w-8" /></div>
                    )}
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <h2 className="font-semibold leading-snug">{item.name}</h2>
                        <span className="shrink-0 text-sm font-semibold text-emerald-800">{formatMoney(Number(item.price), data.currency)}</span>
                      </div>
                      {item.description ? <p className="mt-2 line-clamp-3 text-sm text-slate-500">{item.description}</p> : null}
                      {item.allergens?.length ? <p className="mt-3 text-xs text-slate-400">Allergens: {item.allergens.join(", ")}</p> : null}
                      {data.canCheckout ? (
                        <Button className="mt-4 w-full" onClick={() => beginAddItem(item)}>
                          <Plus className="mr-2 h-4 w-4" /> Add to order
                        </Button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        <footer className="mt-10 border-t border-slate-200 pt-5 text-center text-xs text-slate-500">
          Secure guest access · {data.businessName} · {data.outletName}
        </footer>
      </section>

      {selectedItem ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-4" role="presentation" onClick={() => setSelectedItem(null)}>
          <section className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl" role="dialog" aria-modal="true" aria-label={`Choose options for ${selectedItem.name}`} onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div><h2 className="text-lg font-semibold">{selectedItem.name}</h2><p className="text-sm text-slate-500">{formatMoney(Number(selectedItem.price), data.currency)}</p></div>
              <Button variant="ghost" size="icon" onClick={() => setSelectedItem(null)}><X className="h-4 w-4" /></Button>
            </div>
            {(selectedItem.variants?.length ?? 0) > 0 ? (
              <div className="mt-5">
                <label className="mb-2 block text-sm font-medium">Choose a variant</label>
                <select className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm" value={selectedVariantId} onChange={(event) => setSelectedVariantId(event.target.value)}>
                  {selectedItem.variants?.map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}
                </select>
              </div>
            ) : null}
            {selectedGroups.map((group) => (
              <fieldset key={group.id} className="mt-5">
                <legend className="mb-2 text-sm font-medium">{group.name} <span className="font-normal text-slate-500">(choose {group.min_select}–{group.max_select})</span></legend>
                <div className="space-y-2">
                  {group.modifiers.map((modifier) => {
                    const checked = (selectedModifiers[group.id] ?? []).includes(modifier.id);
                    return (
                      <label key={modifier.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                        <span className="flex items-center gap-2"><input type="checkbox" checked={checked} onChange={() => toggleModifier(group, modifier)} />{modifier.name}</span>
                        {Number(modifier.price_delta) ? <span className="text-slate-500">{formatMoney(Number(modifier.price_delta), data.currency)}</span> : null}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
            {optionError ? <p className="mt-4 text-sm text-red-600">{optionError}</p> : null}
            <Button className="mt-6 w-full" onClick={addSelectedItem}>Add to order</Button>
          </section>
        </div>
      ) : null}

      {cartOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50" role="presentation" onClick={() => setCartOpen(false)}>
          <section className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl" role="dialog" aria-modal="true" aria-label="Your order" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200 p-5">
              <div><h2 className="text-lg font-semibold">Your order</h2><p className="text-xs text-slate-500">{cartCount} item(s) · {data.orderType === "takeaway" ? "Collection" : "Dine-in"}</p></div>
              <Button variant="ghost" size="icon" onClick={() => setCartOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {cart.map((line) => (
                <div key={line.key} className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{line.description}</p>
                    {line.modifiers.length ? <p className="mt-1 text-xs text-slate-500">{line.modifiers.map((modifier) => modifier.name).join(", ")}</p> : null}
                    <p className="mt-1 text-sm text-slate-600">{formatMoney(line.unitPrice, data.currency)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => changeQuantity(line.key, -1)}><Minus className="h-3 w-3" /></Button>
                    <span className="w-5 text-center text-sm tabular-nums">{line.quantity}</span>
                    <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => changeQuantity(line.key, 1)}><Plus className="h-3 w-3" /></Button>
                  </div>
                </div>
              ))}
              {cart.length === 0 ? <p className="py-10 text-center text-sm text-slate-500">Your cart is empty.</p> : null}
            </div>
            <div className="border-t border-slate-200 p-5">
              <div className="mb-4 flex items-center justify-between font-semibold"><span>Estimated subtotal</span><span>{formatMoney(cartTotal, data.currency)}</span></div>
              <p className="mb-3 text-xs text-slate-500">Final taxes, service charges and totals are calculated by the restaurant's pricing engine at checkout.</p>
              <Button className="w-full" disabled={cart.length === 0} onClick={() => { setCartOpen(false); setCheckoutOpen(true); }}>
                Continue to checkout
              </Button>
            </div>
          </section>
        </div>
      ) : null}

      {checkoutOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-4" role="presentation" onClick={() => !submitting && setCheckoutOpen(false)}>
          <section className="w-full max-w-lg rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl" role="dialog" aria-modal="true" aria-label="Checkout" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Checkout</h2><Button variant="ghost" size="icon" onClick={() => setCheckoutOpen(false)} disabled={submitting}><X className="h-4 w-4" /></Button></div>
            <p className="mt-1 text-sm text-slate-500">{cartCount} item(s) · {formatMoney(cartTotal, data.currency)} estimated</p>
            <label className="mt-5 block text-sm font-medium" htmlFor="guest-name">Name (optional)</label>
            <Input id="guest-name" className="mt-2 h-11" value={guestName} onChange={(event) => setGuestName(event.target.value)} maxLength={160} placeholder="Your name" />
            {submitError ? <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{submitError}</p> : null}
            <Button className="mt-6 w-full" onClick={placeOrder} disabled={submitting || cart.length === 0}>
              {submitting ? "Placing order…" : "Place order"}
            </Button>
            <p className="mt-3 text-xs text-slate-500">Prices and availability are verified server-side. Payment and fulfilment follow the restaurant's configured service policy.</p>
          </section>
        </div>
      ) : null}

      {data.canCheckout && cartCount > 0 && !cartOpen && !checkoutOpen && !confirmedOrder ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 p-3 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-1">
            <div><p className="text-sm font-semibold">{cartCount} item(s)</p><p className="text-xs text-slate-500">{formatMoney(cartTotal, data.currency)} estimated</p></div>
            <Button onClick={() => setCartOpen(true)}><ShoppingBag className="mr-2 h-4 w-4" /> View order</Button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
