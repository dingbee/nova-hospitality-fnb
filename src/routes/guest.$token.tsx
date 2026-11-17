import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { UtensilsCrossed, Plus, Minus, ShoppingBag, CheckCircle2 } from "lucide-react";
import {
  guestPortalMenuFn,
  submitGuestCommerceOrderFn,
  initiateGuestCommercePaymentFn,
  checkGuestReservationAvailabilityFn,
  createGuestReservationFn,
  cancelGuestReservationFn,
} from "@/modules/messaging/guest-portal.functions";
import type { GuestLineInput } from "@/modules/restaurant/selforder/selforder.contracts";

export const Route = createFileRoute("/guest/$token")({
  head: () => ({
    meta: [
      { title: "Guest Menu — LexiBite" },
      { name: "robots", content: "noindex,nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: WhatsAppGuestPortal,
});

function formatMoney(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return currency + " " + Number(amount).toFixed(2);
  }
}

type ModifierSelection = Record<string, Record<string, string[]>>;

type GuestPortalMenuData = {
  businessName: string;
  logoUrl: string | null;
  outletName: string;
  guestName: string | null;
  loyaltyPointsBalance: number;
  timezone: string;
  reservationDurationMinutes: number;
  currency: string;
  categories: Array<{ id: string; name: string; sortOrder: number }>;
  modifierGroups: Array<{
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    required: boolean;
    modifiers: Array<{ id: string; name: string; priceDelta: number }>;
  }>;
  items: Array<{
    id: string;
    name: string;
    description: string | null;
    price: number;
    currency: string;
    imageUrl: string | null;
    categoryId: string | null;
    available: boolean;
    availabilityReasons: string[];
    availableQuantity: number | null;
    modifierGroupIds: string[];
    variants: Array<{ id: string; name: string; price: number; priceIsDelta: boolean }>;
  }>;
};

function WhatsAppGuestPortal() {
  const { token } = Route.useParams();
  const loadMenu = useServerFn(guestPortalMenuFn);
  const submitOrder = useServerFn(submitGuestCommerceOrderFn);
  const [fulfilmentMethod, setFulfilmentMethod] = useState<"pickup" | "dine_in">("pickup");
  const [confirmedReservationId, setConfirmedReservationId] = useState<string | null>(null);
  const initiatePayment = useServerFn(initiateGuestCommercePaymentFn);
  const menu = useQuery({
    queryKey: ["whatsapp-guest-portal", token, fulfilmentMethod],
    queryFn: () =>
      loadMenu({
        data: { token, orderType: fulfilmentMethod === "dine_in" ? "dine_in" : "takeaway" },
      }),
    retry: false,
    networkMode: "always",
  });
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [modifierSelection, setModifierSelection] = useState<ModifierSelection>({});
  const [variantSelection, setVariantSelection] = useState<Record<string, string>>({});
  const [guestName, setGuestName] = useState("");
  const [clientRequestId, setClientRequestId] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [reservationLocalStart, setReservationLocalStart] = useState("");
  const [reservationPartySize, setReservationPartySize] = useState(2);
  const [reservationRequestId, setReservationRequestId] = useState("");
  const [reservationNotice, setReservationNotice] = useState("");
  const reservationAvailabilityFn = useServerFn(checkGuestReservationAvailabilityFn);
  const createReservationFn = useServerFn(createGuestReservationFn);
  const order = useMutation({
    mutationFn: (lines: GuestLineInput[]) =>
      submitOrder({
        data: {
          token,
          guestName,
          clientRequestId,
          fulfilmentMethod,
          reservationId: fulfilmentMethod === "dine_in" ? confirmedReservationId ?? undefined : undefined,
          lines,
        },
      }),
  });
  const payment = useMutation({
    mutationFn: () =>
      initiatePayment({ data: { token, orderId: order.data!.orderId } }),
    onSuccess: (result) => {
      if (result.ok && result.status === "redirect") {
        window.location.assign(result.redirectUrl);
        return;
      }
      setPaymentError(
        result.reason === "provider_not_configured"
          ? "Online payment is not yet enabled for this restaurant. Contact the outlet to complete your order."
          : result.reason === "not_ready_for_payment"
            ? "This order is not ready for payment yet."
            : "A secure payment session could not be started. Please retry.",
      );
    },
  });
  const reservationAvailability = useMutation({
    mutationFn: () =>
      reservationAvailabilityFn({
        data: { token, localStart: reservationLocalStart, partySize: reservationPartySize },
      }),
  });
  const reservation = useMutation({
    mutationFn: () =>
      createReservationFn({
        data: {
          token,
          localStart: reservationLocalStart,
          partySize: reservationPartySize,
          guestName,
          clientRequestId: reservationRequestId,
        },
      }),
    onSuccess: (result) => {
      setConfirmedReservationId(result.reservationId);
      setReservationNotice("");
      setFulfilmentMethod("dine_in");
    },
  });
  const cancelReservationFn = useServerFn(cancelGuestReservationFn);
  const cancelReservation = useMutation({
    mutationFn: () =>
      cancelReservationFn({
        data: { token, reservationId: reservation.data!.reservationId },
      }),
    onSuccess: () => {
      reservation.reset();
      reservationAvailability.reset();
      setConfirmedReservationId(null);
      setFulfilmentMethod("pickup");
      setReservationNotice("Your reservation has been cancelled.");
    },
  });

  useEffect(() => {
    const key = "lexibite:wa-checkout:" + token;
    let requestId = sessionStorage.getItem(key);
    if (!requestId) {
      requestId = crypto.randomUUID();
      sessionStorage.setItem(key, requestId);
    }
    setClientRequestId(requestId);
    const reservationKey = "lexibite:wa-reservation:" + token;
    let reservationId = sessionStorage.getItem(reservationKey);
    if (!reservationId) {
      reservationId = crypto.randomUUID();
      sessionStorage.setItem(reservationKey, reservationId);
    }
    setReservationRequestId(reservationId);
  }, [token]);

  if (menu.isPending)
    return (
      <main className="mx-auto flex min-h-dvh max-w-3xl items-center justify-center px-6">
        <p className="text-sm text-muted-foreground">Loading the restaurant menu…</p>
      </main>
    );
  if (menu.isError || !menu.data)
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-3 px-6 text-center">
        <UtensilsCrossed className="size-9 text-primary" aria-hidden />
        <h1 className="text-xl font-semibold">This menu link is unavailable</h1>
        <p className="text-sm text-muted-foreground">
          {menu.error instanceof Error
            ? menu.error.message
            : "Return to WhatsApp and request a fresh menu link."}
        </p>
      </main>
    );

  const data = menu.data as GuestPortalMenuData;
  const categories = [...data.categories].sort((a, b) => a.sortOrder - b.sortOrder);
  const cartItems = data.items.filter((item) => (quantities[item.id] ?? 0) > 0);
  const lines = cartItems.map((item) => {
    const modifiers = item.modifierGroupIds.flatMap((groupId) => {
      const group = data.modifierGroups.find((g) => g.id === groupId);
      if (!group) return [];
      return (modifierSelection[item.id]?.[groupId] ?? []).flatMap((modifierId) => {
        const modifier = group.modifiers.find((m) => m.id === modifierId);
        return modifier
          ? [
              {
                modifierId: modifier.id,
                groupId: group.id,
                name: modifier.name,
                priceDelta: modifier.priceDelta,
                quantity: 1,
              },
            ]
          : [];
      });
    });
    return {
      menuItemId: item.id,
      description: item.name,
      quantity: quantities[item.id] ?? 0,
      unitPrice: 0,
      discount: 0,
      variantId: variantSelection[item.id] || undefined,
      modifiers,
    };
  });
  const missingRequiredModifiers = cartItems.some((item) =>
    item.modifierGroupIds.some((groupId) => {
      const group = data.modifierGroups.find((g) => g.id === groupId);
      return Boolean(
        group && (modifierSelection[item.id]?.[groupId]?.length ?? 0) < group.minSelect,
      );
    }),
  );

  function changeQuantity(itemId: string, delta: number) {
    setQuantities((current) => {
      const next = Math.max(0, Math.min(99, (current[itemId] ?? 0) + delta));
      return { ...current, [itemId]: next };
    });
  }

  function toggleModifier(itemId: string, groupId: string, modifierId: string, maxSelect: number) {
    setModifierSelection((current) => {
      const selected = current[itemId]?.[groupId] ?? [];
      const next = selected.includes(modifierId)
        ? selected.filter((id) => id !== modifierId)
        : selected.length >= maxSelect
          ? selected
          : [...selected, modifierId];
      return { ...current, [itemId]: { ...(current[itemId] ?? {}), [groupId]: next } };
    });
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-5">
          {data.logoUrl ? (
            <img src={data.logoUrl} alt="" className="size-12 rounded-xl object-cover" />
          ) : (
            <span className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
              <UtensilsCrossed className="size-6 text-primary" aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold">{data.businessName}</p>
            <p className="text-xs text-muted-foreground">{data.outletName} · Takeaway menu</p>
          </div>
          <span className="ml-auto rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            WhatsApp
          </span>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-5 py-6">
        {order.data ? (
          <section className="mb-6 rounded-2xl border border-primary/30 bg-primary/5 p-5">
            <CheckCircle2 className="mb-2 size-7 text-primary" aria-hidden />
            <h1 className="text-xl font-semibold">Order received</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Order {order.data.orderNumber} · {formatMoney(order.data.total, order.data.currency)}
            </p>
            <p className="mt-2 text-sm">
              {order.data.paymentTiming === "pay_first"
                ? "Your order is awaiting payment confirmation before production begins."
                : "Your order has been sent to the restaurant for preparation."}
            </p>
            {order.data.paymentTiming === "pay_first" && order.data.status !== "paid" ? (
              <div className="mt-4">
                {paymentError ? <p className="mb-2 text-sm text-destructive">{paymentError}</p> : null}
                {payment.isError ? (
                  <p className="mb-2 text-sm text-destructive">
                    {payment.error instanceof Error
                      ? payment.error.message
                      : "Secure payment could not be started."}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                  disabled={payment.isPending}
                  onClick={() => {
                    setPaymentError("");
                    payment.mutate();
                  }}
                >
                  {payment.isPending ? "Preparing secure checkout…" : "Continue to secure payment"}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
        <section className="mb-8 rounded-2xl border border-border p-5">
          <h2 className="text-lg font-semibold">Reserve a table</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a time at {data.outletName}. Times are interpreted in {data.timezone}.
            Standard seating duration: {data.reservationDurationMinutes} minutes.
          </p>
          {reservationNotice ? (
            <p className="mt-3 text-sm text-muted-foreground">{reservationNotice}</p>
          ) : null}
          {reservation.data ? (
            <div className="mt-3 rounded-xl bg-primary/10 p-3 text-sm">
              <p className="font-semibold">Reservation confirmed</p>
              <p className="mt-1">Reference: {reservation.data.bookingReference}</p>
              <p className="text-muted-foreground">
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: data.timezone,
                }).format(new Date(reservation.data.startsAt))}
              </p>
              {cancelReservation.isError ? (
                <p className="mt-2 text-sm text-destructive">
                  {cancelReservation.error instanceof Error
                    ? cancelReservation.error.message
                    : "Reservation could not be cancelled."}
                </p>
              ) : null}
              <button
                type="button"
                className="mt-3 rounded-lg border border-border px-3 py-2 text-xs font-semibold disabled:opacity-50"
                disabled={cancelReservation.isPending}
                onClick={() => cancelReservation.mutate()}
              >
                {cancelReservation.isPending ? "Cancelling…" : "Cancel reservation"}
              </button>
            </div>
          ) : (
            <>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  Date and time
                  <input
                    type="datetime-local"
                    value={reservationLocalStart}
                    onChange={(event) => {
                      setReservationLocalStart(event.target.value);
                      reservationAvailability.reset();
                    }}
                    className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2"
                  />
                </label>
                <label className="block text-sm">
                  Your name
                  <input
                    value={guestName}
                    onChange={(event) => setGuestName(event.target.value)}
                    maxLength={160}
                    className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2"
                    placeholder={data.guestName || "Name for the reservation"}
                  />
                </label>
                <label className="block text-sm">
                  Party size
                  <select
                    value={reservationPartySize}
                    onChange={(event) => {
                      setReservationPartySize(Number(event.target.value));
                      reservationAvailability.reset();
                    }}
                    className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2"
                  >
                    {Array.from({ length: 12 }, (_, index) => index + 1).map((size) => (
                      <option key={size} value={size}>
                        {size} {size === 1 ? "guest" : "guests"}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {reservationAvailability.data ? (
                <p className="mt-3 text-sm">
                  {reservationAvailability.data.available
                    ? `${reservationAvailability.data.availableTableCount} suitable table(s) are available for this time.`
                    : "No suitable table is available for this time and party size."}
                </p>
              ) : null}
              {reservationAvailability.isError ? (
                <p className="mt-2 text-sm text-destructive">
                  {reservationAvailability.error instanceof Error
                    ? reservationAvailability.error.message
                    : "Availability could not be checked."}
                </p>
              ) : null}
              {reservation.isError ? (
                <p className="mt-2 text-sm text-destructive">
                  {reservation.error instanceof Error
                    ? reservation.error.message
                    : "Reservation could not be confirmed."}
                </p>
              ) : null}
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  className="flex-1 rounded-xl border border-border px-4 py-3 text-sm font-semibold disabled:opacity-50"
                  disabled={!reservationLocalStart || reservationAvailability.isPending}
                  onClick={() => reservationAvailability.mutate()}
                >
                  {reservationAvailability.isPending ? "Checking availability…" : "Check availability"}
                </button>
                {reservationAvailability.data?.available ? (
                  <button
                    type="button"
                    className="flex-1 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                    disabled={!reservationRequestId || reservation.isPending}
                    onClick={() => reservation.mutate()}
                  >
                    {reservation.isPending ? "Confirming reservation…" : "Confirm reservation"}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </section>
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Explore the menu</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose your items and submit a takeaway order.
          </p>
        </div>
        {categories.map((category) => {
          const items = data.items.filter((item) => item.categoryId === category.id);
          if (!items.length) return null;
          return (
            <section key={category.id} className="mb-8">
              <h2 className="mb-3 text-lg font-semibold">{category.name}</h2>
              <div className="divide-y divide-border rounded-xl border border-border">
                {items.map((item) => (
                  <article key={item.id} className="p-4">
                    <div className="flex gap-4">
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt=""
                          loading="lazy"
                          className="size-20 shrink-0 rounded-lg object-cover"
                        />
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <h3 className="font-medium">{item.name}</h3>
                        {item.description ? (
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                            {item.description}
                          </p>
                        ) : null}
                        <p className="mt-2 text-sm font-semibold">
                          {formatMoney(Number(item.price), data.currency)}
                        </p>
                        {!item.available ? (
                          <p className="mt-1 text-xs text-destructive">
                            {item.availabilityReasons[0] ?? "Currently unavailable"}
                          </p>
                        ) : null}
                        {item.variants.length ? (
                          <label className="mt-2 block text-xs text-muted-foreground">
                            Option
                            <select
                              className="mt-1 block w-full rounded-lg border border-border bg-background p-2 text-sm text-foreground"
                              value={variantSelection[item.id] ?? ""}
                              onChange={(e) =>
                                setVariantSelection((v) => ({ ...v, [item.id]: e.target.value }))
                              }
                            >
                              <option value="">Standard</option>
                              {item.variants.map((v: { id: string; name: string }) => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          className="flex size-9 items-center justify-center rounded-full border border-border disabled:opacity-40"
                          disabled={!quantities[item.id]}
                          onClick={() => changeQuantity(item.id, -1)}
                          aria-label={"Remove one " + item.name}
                        >
                          <Minus className="size-4" />
                        </button>
                        <span className="w-5 text-center text-sm tabular-nums">
                          {quantities[item.id] ?? 0}
                        </span>
                        <button
                          type="button"
                          className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
                          disabled={!item.available}
                          onClick={() => changeQuantity(item.id, 1)}
                          aria-label={"Add one " + item.name}
                        >
                          <Plus className="size-4" />
                        </button>
                      </div>
                    </div>
                    {item.modifierGroupIds.map((groupId) => {
                      const group = data.modifierGroups.find((g) => g.id === groupId);
                      if (!group || !group.modifiers.length) return null;
                      return (
                        <fieldset key={group.id} className="mt-3 rounded-lg bg-muted/40 p-3">
                          <legend className="px-1 text-xs font-medium">
                            {group.name}
                            {group.required ? " · Required" : " · Optional"}
                          </legend>
                          <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {group.modifiers.map((modifier) => {
                              const checked = (
                                modifierSelection[item.id]?.[group.id] ?? []
                              ).includes(modifier.id);
                              const atLimit =
                                (modifierSelection[item.id]?.[group.id]?.length ?? 0) >=
                                group.maxSelect;
                              return (
                                <label
                                  key={modifier.id}
                                  className="flex items-center gap-2 text-sm"
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={!checked && atLimit}
                                    onChange={() =>
                                      toggleModifier(
                                        item.id,
                                        group.id,
                                        modifier.id,
                                        group.maxSelect,
                                      )
                                    }
                                  />
                                  <span>{modifier.name}</span>
                                  {modifier.priceDelta ? (
                                    <span className="ml-auto text-xs text-muted-foreground">
                                      {formatMoney(modifier.priceDelta, data.currency)}
                                    </span>
                                  ) : null}
                                </label>
                              );
                            })}
                          </div>
                        </fieldset>
                      );
                    })}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
        {data.items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            The restaurant has no currently available menu items.
          </p>
        ) : null}
        {cartItems.length > 0 && !order.data ? (
          <section className="sticky bottom-3 mt-8 rounded-2xl border border-border bg-background p-4 shadow-lg">
            <div className="mb-3 flex items-center gap-2">
              <ShoppingBag className="size-5" />
              <h2 className="font-semibold">
                Your order · {lines.reduce((sum, line) => sum + line.quantity, 0)} items
              </h2>
            </div>
            <label className="mb-3 block text-sm">
              Fulfilment
              <select
                value={fulfilmentMethod}
                onChange={(event) => setFulfilmentMethod(event.target.value as "pickup" | "dine_in")}
                className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2"
              >
                <option value="pickup">Pickup / takeaway</option>
                {reservation.data ? <option value="dine_in">Dine in — {reservation.data.bookingReference}</option> : null}
              </select>
            </label>
            <label className="mb-3 block text-sm">
              Name (optional)
              <input
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                maxLength={160}
                className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2"
                placeholder="Your name"
              />
            </label>
            {missingRequiredModifiers ? (
              <p className="mb-2 text-xs text-destructive">
                Choose all required options before submitting.
              </p>
            ) : null}
            {order.isError ? (
              <p className="mb-2 text-sm text-destructive">
                {order.error instanceof Error
                  ? order.error.message
                  : "Order could not be submitted. Please try again."}
              </p>
            ) : null}
            <button
              type="button"
              className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              disabled={
                !clientRequestId ||
                missingRequiredModifiers ||
                order.isPending ||
                (fulfilmentMethod === "dine_in" && !reservation.data)
              }
              onClick={() => order.mutate(lines)}
            >
              {order.isPending
                ? "Submitting order…"
                : fulfilmentMethod === "dine_in"
                  ? "Place dine-in order"
                  : "Place pickup order"}
            </button>
          </section>
        ) : null}
        <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
          Menu prices are provided by {data.businessName}. Final order totals are calculated by the
          restaurant’s LexiBite pricing engine.
        </footer>
      </div>
    </main>
  );
}
