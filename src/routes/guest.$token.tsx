import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Search, MessageCircle, UtensilsCrossed } from "lucide-react";
import { PRODUCT } from "@/config/product";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { whatsappGuestPortalPageFn } from "@/modules/restaurant/selforder/whatsapp-guest-portal.functions";

export const Route = createFileRoute("/guest/$token")({
  loader: async ({ params }) => whatsappGuestPortalPageFn({ data: { token: params.token } }),
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.businessName ?? "Guest Menu"} — ${PRODUCT.guestFacingName}` },
      { name: "robots", content: "noindex,nofollow" },
      { name: "referrer", content: "no-referrer" },
      { "http-equiv": "Cache-Control", content: "no-store, private, max-age=0" },
      { name: "theme-color", content: "#346739" },
    ],
  }),
  component: WhatsAppGuestPortalPage,
});

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
};

function formatMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function WhatsAppGuestPortalPage() {
  const data = Route.useLoaderData();
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const items = data.items as PortalItem[];
  const categories = data.categories as Array<{ id: string; name: string }>;

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

  return (
    <main className="min-h-screen bg-[#f7f8f5] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {data.businessLogoUrl ? (
              <img
                src={data.businessLogoUrl}
                alt=""
                className="h-12 w-12 rounded-xl border border-slate-100 object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800">
                <UtensilsCrossed className="h-6 w-6" />
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold">{data.businessName}</p>
              <p className="truncate text-xs text-slate-500">
                {data.propertyName} · {data.outletName}
              </p>
            </div>
          </div>
          {supportUrl ? (
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <a href={supportUrl} target="_blank" rel="noreferrer">
                <MessageCircle className="mr-2 h-4 w-4" />
                Help
              </a>
            </Button>
          ) : null}
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-4 pb-10 pt-7 sm:px-6">
        <div className="mb-7 rounded-2xl bg-emerald-950 px-5 py-6 text-white sm:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">
            {PRODUCT.guestFacingName} Guest Portal
          </p>
          <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">Explore the menu</h1>
          <p className="mt-2 max-w-2xl text-sm text-emerald-100">
            Browse the current menu at {data.outletName}. Menu availability and prices are checked again when you place an order.
          </p>
          {data.businessDescription ? (
            <p className="mt-3 max-w-2xl text-sm text-emerald-100">{data.businessDescription}</p>
          ) : null}
        </div>

        <div className="mb-5 flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search the menu"
              className="h-11 rounded-xl bg-white pl-10"
            />
          </div>
        </div>

        {categories.length > 0 ? (
          <div className="mb-6 flex gap-2 overflow-x-auto pb-2">
            <Button
              size="sm"
              variant={categoryId === null ? "default" : "outline"}
              className="shrink-0 rounded-full"
              onClick={() => setCategoryId(null)}
            >
              All
            </Button>
            {categories.map((category) => (
              <Button
                key={category.id}
                size="sm"
                variant={categoryId === category.id ? "default" : "outline"}
                className="shrink-0 rounded-full"
                onClick={() => setCategoryId(category.id)}
              >
                {category.name}
              </Button>
            ))}
          </div>
        ) : null}

        {visibleItems.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
            <UtensilsCrossed className="mx-auto h-8 w-8 text-slate-400" />
            <h2 className="mt-3 font-semibold">No menu items found</h2>
            <p className="mt-1 text-sm text-slate-500">
              Try another search or check back with the restaurant.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleItems.map((item) => (
              <article key={item.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                {item.image_url ? (
                  <img
                    src={item.image_url}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-44 w-full object-cover"
                  />
                ) : (
                  <div className="flex h-32 items-center justify-center bg-slate-100 text-slate-400">
                    <UtensilsCrossed className="h-8 w-8" />
                  </div>
                )}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="font-semibold leading-snug">{item.name}</h2>
                    <span className="shrink-0 text-sm font-semibold text-emerald-800">
                      {formatMoney(Number(item.price), data.currency)}
                    </span>
                  </div>
                  {item.description ? (
                    <p className="mt-2 line-clamp-3 text-sm text-slate-500">{item.description}</p>
                  ) : null}
                  {item.allergens?.length ? (
                    <p className="mt-3 text-xs text-slate-400">Allergens: {item.allergens.join(", ")}</p>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}

        <footer className="mt-10 border-t border-slate-200 pt-5 text-center text-xs text-slate-500">
          Secure guest access · {data.businessName} · {data.outletName}
        </footer>
      </section>
    </main>
  );
}
