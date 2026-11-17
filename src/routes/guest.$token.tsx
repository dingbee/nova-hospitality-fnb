import { useServerFn } from "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { UtensilsCrossed } from "lucide-react";
import { guestPortalMenuFn } from "@/modules/messaging/guest-portal.functions";

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
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount); }
  catch { return currency + " " + Number(amount).toFixed(2); }
}

function WhatsAppGuestPortal() {
  const { token } = Route.useParams();
  const loadMenu = useServerFn(guestPortalMenuFn);
  const menu = useQuery({
    queryKey: ["whatsapp-guest-portal", token],
    queryFn: () => loadMenu({ data: { token } }),
    retry: false,
    networkMode: "always",
  });

  if (menu.isPending) return <main className="mx-auto flex min-h-dvh max-w-3xl items-center justify-center px-6"><p className="text-sm text-muted-foreground">Loading the restaurant menu…</p></main>;
  if (menu.isError || !menu.data) return <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-3 px-6 text-center"><UtensilsCrossed className="size-9 text-primary" aria-hidden /><h1 className="text-xl font-semibold">This menu link is unavailable</h1><p className="text-sm text-muted-foreground">{menu.error instanceof Error ? menu.error.message : "Return to WhatsApp and request a fresh menu link."}</p></main>;

  const data = menu.data;
  const categories = [...data.categories].sort((a, b) => a.sortOrder - b.sortOrder);
  return <main className="min-h-dvh bg-background text-foreground">
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-5">
        {data.logoUrl ? <img src={data.logoUrl} alt="" className="size-12 rounded-xl object-cover" /> : <span className="flex size-12 items-center justify-center rounded-xl bg-primary/10"><UtensilsCrossed className="size-6 text-primary" aria-hidden /></span>}
        <div className="min-w-0"><p className="truncate text-lg font-semibold">{data.businessName}</p><p className="text-xs text-muted-foreground">{data.outletName} · Menu</p></div>
        <span className="ml-auto rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">WhatsApp</span>
      </div>
    </header>
    <div className="mx-auto max-w-3xl px-5 py-6">
      <div className="mb-6"><h1 className="text-2xl font-semibold tracking-tight">Explore the menu</h1><p className="mt-1 text-sm text-muted-foreground">Browse the restaurant’s current published selection and prices.</p></div>
      {categories.map(category => {
        const items = data.items.filter(item => item.categoryId === category.id);
        if (!items.length) return null;
        return <section key={category.id} className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">{category.name}</h2>
          <div className="divide-y divide-border rounded-xl border border-border">
            {items.map(item => <article key={item.id} className="flex gap-4 p-4">
              {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" className="size-20 shrink-0 rounded-lg object-cover" /> : null}
              <div className="min-w-0 flex-1"><h3 className="font-medium">{item.name}</h3>{item.description ? <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.description}</p> : null}
                <p className="mt-2 text-sm font-semibold">{formatMoney(Number(item.price), data.currency)}</p>
                {item.variants.length ? <p className="mt-1 text-xs text-muted-foreground">{item.variants.map((v: { id: string; name: string }) => v.name).join(" · ")}</p> : null}
              </div>
            </article>)}
          </div>
        </section>;
      })}
      {data.items.length === 0 ? <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">The restaurant has no currently available menu items.</p> : null}
      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">Menu prices are provided by {data.businessName}. Ordering and checkout are completed through the restaurant’s approved guest ordering channel.</footer>
    </div>
  </main>;
}
