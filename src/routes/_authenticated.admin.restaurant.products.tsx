/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatCard } from "@/components/os/StatCard";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import {
  completeRestaurantProductionFn,
  getRestaurantProductEvidenceFn,
  getRestaurantProductFn,
  getRestaurantRecipeFn,
  listRestaurantProductionsFn,
  listRestaurantProductsFn,
  listRestaurantRecipesFn,
  setRestaurantRecipeStatusFn,
  startRestaurantProductionFn,
  versionRestaurantRecipeFn,
  listRestaurantModifierGroupsFn,
} from "@/modules/restaurant/products/catalog.functions";
import { ChefHat, Factory, Package, Plus, TrendingUp } from "lucide-react";
import { hasRestaurantCapability } from "@/modules/restaurant/core/permissions";
import { ProductSheet } from "@/modules/restaurant/products/ui/ProductSheet";
import { VariantSheet } from "@/modules/restaurant/products/ui/VariantSheet";
import { ModifierGroupSheet } from "@/modules/restaurant/products/ui/ModifierGroupSheet";
import { ModifierSheet } from "@/modules/restaurant/products/ui/ModifierSheet";
import { AttachModifierGroupsPanel } from "@/modules/restaurant/products/ui/AttachModifierGroupsPanel";
import { RecipeSheet } from "@/modules/restaurant/products/ui/RecipeSheet";


export const Route = createFileRoute("/_authenticated/admin/restaurant/products")({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Products & Recipes — Restaurant & Bar OS" },
      {
        name: "description",
        content: "Versioned recipes, sellable products and production runs linking purchase to actual plate cost.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ProductRecipeCentre,
});

const RECIPE_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  active: "success",
  archived: "warning",
};
const PRODUCTION_TONE: Record<string, StatusTone> = {
  planned: "info",
  in_progress: "warning",
  completed: "success",
  cancelled: "neutral",
};

function money(value: unknown, currency = "TZS") {
  return `${currency} ${Number(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

const PRODUCT_TABS = ["recipes", "products", "modifiers", "production", "evidence"];

function ProductRecipeCentre() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const qc = useQueryClient();
  const { tab: searchTab } = Route.useSearch();

  const recipesFn = useServerFn(listRestaurantRecipesFn);
  const productsFn = useServerFn(listRestaurantProductsFn);
  const productionsFn = useServerFn(listRestaurantProductionsFn);
  const evidenceFn = useServerFn(getRestaurantProductEvidenceFn);
  const recipeFn = useServerFn(getRestaurantRecipeFn);
  const versionFn = useServerFn(versionRestaurantRecipeFn);
  const statusFn = useServerFn(setRestaurantRecipeStatusFn);
  const startFn = useServerFn(startRestaurantProductionFn);
  const completeFn = useServerFn(completeRestaurantProductionFn);

  const enabled = Boolean(tenantId);
  const recipes = useQuery({
    queryKey: ["restaurant.recipes", tenantId],
    queryFn: () => recipesFn({ data: { tenantId: tenantId!, latestOnly: true, limit: 200 } }),
    enabled,
  });
  const products = useQuery({
    queryKey: ["restaurant.products", tenantId],
    queryFn: () => productsFn({ data: { tenantId: tenantId!, activeOnly: false, limit: 200 } }),
    enabled,
  });
  const productions = useQuery({
    queryKey: ["restaurant.productions", tenantId],
    queryFn: () => productionsFn({ data: { tenantId: tenantId!, limit: 100 } }),
    enabled,
  });
  const evidence = useQuery({
    queryKey: ["restaurant.product-evidence", tenantId],
    queryFn: () => evidenceFn({ data: { tenantId: tenantId! } }),
    enabled,
  });

  const [openRecipeId, setOpenRecipeId] = useState<string | null>(null);
  const [startRecipeId, setStartRecipeId] = useState<string | null>(null);
  const [batches, setBatches] = useState("1");
  const [completing, setCompleting] = useState<any | null>(null);
  const [actualQuantity, setActualQuantity] = useState("");
  const roles = (ws.data?.roles ?? []) as readonly string[];
  const platformAdmin = ws.data?.platformAdmin ?? false;
  const canManageProducts = hasRestaurantCapability(roles, "product.manage", platformAdmin);
  const canManageRecipes = hasRestaurantCapability(roles, "recipe.manage", platformAdmin);
  const [productSheetOpen, setProductSheetOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<any | null>(null);
  const [recipeSheetOpen, setRecipeSheetOpen] = useState(false);
  const [editingRecipeLines, setEditingRecipeLines] = useState<any[] | undefined>(undefined);
  const [modifierGroupSheetOpen, setModifierGroupSheetOpen] = useState(false);
  const [editingModifierGroup, setEditingModifierGroup] = useState<any | null>(null);
  const [modifierSheetOpen, setModifierSheetOpen] = useState<{ groupId: string; modifier?: any | null } | null>(null);
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  const [editingVariant, setEditingVariant] = useState<any | null>(null);
  const [variantSheetOpen, setVariantSheetOpen] = useState(false);
  const modifierGroupsFn = useServerFn(listRestaurantModifierGroupsFn);
  const productFn = useServerFn(getRestaurantProductFn);
  const modifierGroups = useQuery({
    queryKey: ["restaurant.modifier-groups", tenantId],
    queryFn: () => modifierGroupsFn({ data: { tenantId: tenantId! } }),
    enabled,
  });

  const recipeDetail = useQuery({
    queryKey: ["restaurant.recipe", tenantId, openRecipeId],
    queryFn: () => recipeFn({ data: { tenantId: tenantId!, recipeId: openRecipeId! } }),
    enabled: enabled && Boolean(openRecipeId),
  });

  const productDetail = useQuery({
    queryKey: ["restaurant.product", tenantId, openProductId],
    queryFn: () => productFn({ data: { tenantId: tenantId!, productId: openProductId! } }),
    enabled: enabled && Boolean(openProductId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.recipes", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.productions", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.product-evidence", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.recipe", tenantId] });
  };

  const versionMutation = useAdminMutation({
    mutationFn: (recipeId: string) => versionFn({ data: { tenantId: tenantId!, recipeId, activate: false } }),
    successMessage: "New draft version created.",
    onSuccess: (res: any) => {
      invalidate();
      if (res?.id) setOpenRecipeId(res.id);
    },
  });
  const statusMutation = useAdminMutation({
    mutationFn: (vars: { recipeId: string; status: "draft" | "active" | "archived" }) =>
      statusFn({ data: { tenantId: tenantId!, recipeId: vars.recipeId, status: vars.status } }),
    successMessage: "Recipe status updated.",
    onSuccess: invalidate,
  });
  const startMutation = useAdminMutation({
    mutationFn: () =>
      startFn({ data: { tenantId: tenantId!, recipeId: startRecipeId!, batches: Number(batches) || 1 } }),
    successMessage: "Production run started.",
    onSuccess: () => {
      setStartRecipeId(null);
      setBatches("1");
      invalidate();
    },
  });
  const completeMutation = useAdminMutation({
    mutationFn: () =>
      completeFn({
        data: {
          tenantId: tenantId!,
          productionId: completing.id,
          actualQuantity: Number(actualQuantity) || 0,
          inputs: [],
        },
      }),
    successMessage: "Production completed and posted to the ledger.",
    onSuccess: () => {
      setCompleting(null);
      setActualQuantity("");
      invalidate();
    },
  });

  const ev = evidence.data as any;
  const recipeRows = (recipes.data ?? []) as any[];
  const productRows = (products.data ?? []) as any[];
  const productionRows = (productions.data ?? []) as any[];
  const detail = recipeDetail.data as any;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Products & Recipes"
        description="Purchase → inventory → recipe → production → product → sale → actual cost. Recipes are versioned; published versions are never rewritten."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Products" value={ev?.counts?.products ?? productRows.length} icon={Package} tone="green" />
        <StatCard label="Active recipes" value={ev?.counts?.active_recipes ?? 0} icon={ChefHat} tone="info" />
        <StatCard
          label="Completed runs"
          value={ev?.counts?.completed_productions ?? 0}
          icon={Factory}
          tone="gold"
        />
        <StatCard
          label="Products without recipe"
          value={ev?.missing_recipes?.length ?? 0}
          icon={TrendingUp}
          tone={(ev?.missing_recipes?.length ?? 0) > 0 ? "warn" : "neutral"}
        />
      </div>

      <Tabs defaultValue={PRODUCT_TABS.includes(searchTab ?? "") ? (searchTab as string) : "recipes"}>
        <TabsList>
          <TabsTrigger value="recipes">Recipes</TabsTrigger>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="modifiers">Modifiers</TabsTrigger>
          <TabsTrigger value="production">Production</TabsTrigger>
          <TabsTrigger value="evidence">Cost evidence</TabsTrigger>
        </TabsList>

        <TabsContent value="recipes" className="mt-4">
          <SectionCard
            title="Recipes"
            description="Latest version of each lineage. Sub-recipes and menu recipes share one model."
            actions={
              canManageRecipes ? (
                <Button size="sm" className="h-10" onClick={() => { setEditingRecipeLines(undefined); setOpenRecipeId(null); setRecipeSheetOpen(true); }}>
                  <Plus className="mr-1 h-4 w-4" /> New recipe
                </Button>
              ) : undefined
            }
          >
            {recipeRows.length === 0 ? (
              <EmptyState title="No recipes yet" description="Recipes define what a product actually costs to make." />
            ) : (
              <ul className="divide-y text-sm">
                {recipeRows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => setOpenRecipeId(r.id)}
                    >
                      <span className="font-medium">{r.name}</span>{" "}
                      <span className="text-muted-foreground">
                        {r.code} · v{r.version} · {r.kind.replace("_", " ")}
                      </span>
                    </button>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {money(r.computed_cost, r.currency ?? "TZS")} / {Number(r.yield_quantity)}
                      </span>
                      <StatusChip tone={RECIPE_TONE[r.status] ?? "neutral"}>{r.status}</StatusChip>
                      {r.status === "active" ? (
                        <Button size="sm" variant="outline" onClick={() => setStartRecipeId(r.id)}>
                          Produce
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="products" className="mt-4">
          <SectionCard
            title="Sellable products"
            description="Products are what the POS sells; recipes are what they consume."
            actions={
              canManageProducts ? (
                <Button size="sm" className="h-10" onClick={() => { setEditingProduct(null); setProductSheetOpen(true); }}>
                  <Plus className="mr-1 h-4 w-4" /> New product
                </Button>
              ) : undefined
            }
          >
            {productRows.length === 0 ? (
              <EmptyState title="No products" description="Create products to sell recipes, retail lines or bundles." />
            ) : (
              <ul className="divide-y text-sm">
                {productRows.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => setOpenProductId(p.id)}
                    >
                      <span className="font-medium">{p.name}</span>{" "}
                      <span className="text-muted-foreground">
                        {p.sku} · {String(p.product_type).replace("_", " ")}
                      </span>
                    </button>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{money(p.price, p.currency ?? "TZS")}</span>
                      {p.recipe_id ? null : <StatusChip tone="warning">no recipe</StatusChip>}
                      <StatusChip tone={p.active ? "success" : "neutral"}>{p.active ? "active" : "off"}</StatusChip>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="modifiers" className="mt-4">
          <SectionCard
            title="Modifier groups"
            description="Reusable option groups (toppings, spice level) attached to products."
            actions={
              canManageProducts ? (
                <Button size="sm" className="h-10" onClick={() => { setEditingModifierGroup(null); setModifierGroupSheetOpen(true); }}>
                  <Plus className="mr-1 h-4 w-4" /> New group
                </Button>
              ) : undefined
            }
          >
            {(modifierGroups.data ?? []).length === 0 ? (
              <EmptyState title="No modifier groups" description="Create groups like 'Toppings' or 'Spice level' to attach to products." />
            ) : (
              <ul className="space-y-3">
                {(modifierGroups.data as any[]).map((g: any) => (
                  <li key={g.id} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        className="text-left hover:underline"
                        disabled={!canManageProducts}
                        onClick={() => { setEditingModifierGroup(g); setModifierGroupSheetOpen(true); }}
                      >
                        <span className="font-medium">{g.name}</span>{" "}
                        <span className="text-xs text-muted-foreground">
                          {g.code} · select {g.min_select}-{g.max_select}
                          {g.required ? " · required" : ""}
                        </span>
                      </button>
                      {canManageProducts ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-9"
                          onClick={() => setModifierSheetOpen({ groupId: g.id, modifier: null })}
                        >
                          <Plus className="mr-1 h-3.5 w-3.5" /> Modifier
                        </Button>
                      ) : null}
                    </div>
                    {(g.modifiers ?? []).length > 0 ? (
                      <ul className="mt-2 divide-y text-xs">
                        {g.modifiers.map((m: any) => (
                          <li key={m.id} className="flex items-center justify-between py-1.5">
                            <button
                              type="button"
                              className="text-left hover:underline disabled:no-underline"
                              disabled={!canManageProducts}
                              onClick={() => setModifierSheetOpen({ groupId: g.id, modifier: m })}
                            >
                              {m.name}
                            </button>
                            <span className="text-muted-foreground">
                              {money(m.price_delta)} · {m.effect}
                              {!m.active ? " · inactive" : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">No modifiers in this group yet.</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="production" className="mt-4">
          <SectionCard title="Production runs" description="Each completed run consumes inputs and produces stock through the ledger.">
            {productionRows.length === 0 ? (
              <EmptyState title="No production runs" description="Start a run from an active recipe to batch-produce stock." />
            ) : (
              <ul className="divide-y text-sm">
                {productionRows.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{p.production_number}</span>{" "}
                      <span className="text-muted-foreground">
                        planned {Number(p.planned_quantity)}
                        {p.actual_quantity != null ? ` · actual ${Number(p.actual_quantity)}` : ""}
                      </span>
                    </span>
                    <div className="flex items-center gap-2">
                      {p.yield_variance_percent != null ? (
                        <span className="text-xs text-muted-foreground">
                          yield {Number(p.yield_variance_percent).toFixed(1)}%
                        </span>
                      ) : null}
                      <StatusChip tone={PRODUCTION_TONE[p.status] ?? "neutral"}>
                        {String(p.status).replace("_", " ")}
                      </StatusChip>
                      {p.status === "planned" || p.status === "in_progress" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setCompleting(p);
                            setActualQuantity(String(p.planned_quantity ?? ""));
                          }}
                        >
                          Complete
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="evidence" className="mt-4 space-y-4">
          <SectionCard title="Theoretical vs actual cost" description="Pinned recipe cost at sale against what the ledger actually consumed.">
            {(ev?.theoretical_vs_actual ?? []).length === 0 ? (
              <EmptyState title="No sales evidence yet" description="Close recipe-backed orders to build cost evidence." />
            ) : (
              <ul className="divide-y text-sm">
                {(ev?.theoretical_vs_actual ?? []).map((row: any) => (
                  <li key={row.recipe_id} className="flex items-center justify-between py-2">
                    <span>{row.code ?? row.recipe_id.slice(0, 8)}</span>
                    <span className="text-xs text-muted-foreground">
                      {row.units_sold} sold · theoretical {money(row.theoretical_cost)} · actual {money(row.actual_cost)}{" "}
                      <span className={row.variance > 0 ? "text-destructive" : undefined}>
                        ({row.variance > 0 ? "+" : ""}
                        {row.variance})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Recipe cost drift" description="How ingredient cost has moved since the first snapshot.">
            {(ev?.cost_drift ?? []).length === 0 ? (
              <EmptyState title="No drift recorded" description="Cost history builds as ingredient prices change." />
            ) : (
              <ul className="divide-y text-sm">
                {(ev?.cost_drift ?? []).map((row: any) => (
                  <li key={row.recipe_id} className="flex items-center justify-between py-2">
                    <span>{row.name ?? row.code}</span>
                    <span className="text-xs text-muted-foreground">
                      {money(row.earliest_cost)} → {money(row.latest_cost)}
                      {row.drift_percent != null ? ` (${row.drift_percent > 0 ? "+" : ""}${row.drift_percent}%)` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Product margin" description="Menu price against the current computed recipe cost.">
            {(ev?.product_margin ?? []).length === 0 ? (
              <EmptyState title="No priced recipe products" description="Link products to recipes to see margin." />
            ) : (
              <ul className="divide-y text-sm">
                {(ev?.product_margin ?? []).map((row: any) => (
                  <li key={row.product_id} className="flex items-center justify-between py-2">
                    <span>{row.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {money(row.price)} − {money(row.cost)} ={" "}
                      {row.margin_percent != null ? `${row.margin_percent}%` : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>

      {/* Recipe detail */}
      <Dialog open={Boolean(openRecipeId)} onOpenChange={(o) => !o && setOpenRecipeId(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detail?.recipe?.name ?? "Recipe"}</DialogTitle>
          </DialogHeader>
          {recipeDetail.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : detail ? (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip tone={RECIPE_TONE[detail.recipe.status] ?? "neutral"}>{detail.recipe.status}</StatusChip>
                <span className="text-muted-foreground">
                  {detail.recipe.code} · v{detail.recipe.version} · yields {Number(detail.recipe.yield_quantity)}
                </span>
              </div>

              <div className="rounded-md border p-3">
                <p className="font-medium">Cost breakdown</p>
                {detail.cost?.error ? (
                  <p className="text-destructive">{detail.cost.error}</p>
                ) : (
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {(detail.cost?.lines ?? []).map((l: any, i: number) => (
                      <li key={i} className="flex justify-between">
                        <span>{l.label ?? l.name ?? l.component_kind}</span>
                        <span>{money(l.cost ?? l.total_cost, detail.recipe.currency ?? "TZS")}</span>
                      </li>
                    ))}
                    <li className="flex justify-between border-t pt-1 font-medium text-foreground">
                      <span>Total</span>
                      <span>{money(detail.cost?.totalCost ?? detail.recipe.computed_cost, detail.recipe.currency ?? "TZS")}</span>
                    </li>
                  </ul>
                )}
              </div>

              <div>
                <p className="font-medium">Version history</p>
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {(detail.versions ?? []).map((v: any) => (
                    <li key={v.id} className="flex justify-between">
                      <span>v{v.version} · {v.status}</span>
                      <span>{money(v.computed_cost, detail.recipe.currency ?? "TZS")}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-wrap gap-2">
                {canManageRecipes ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingRecipeLines(
                        (detail.lines ?? []).map((l: any) => ({
                          componentKind: l.component_kind,
                          inventoryItemId: l.inventory_item_id,
                          subRecipeId: l.sub_recipe_id,
                          quantity: Number(l.quantity),
                          unitId: l.unit_id,
                          yieldPercent: Number(l.yield_percent ?? 100),
                          isOptional: Boolean(l.is_optional),
                          sortOrder: l.sort_order ?? 0,
                          notes: l.notes ?? null,
                        })),
                      );
                      setRecipeSheetOpen(true);
                    }}
                  >
                    Edit recipe
                  </Button>
                ) : null}
                {detail.recipe.status === "draft" ? (
                  <Button
                    size="sm"
                    onClick={() => statusMutation.mutate({ recipeId: detail.recipe.id, status: "active" })}
                    disabled={statusMutation.isPending}
                  >
                    Publish version
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => versionMutation.mutate(detail.recipe.id)}
                    disabled={versionMutation.isPending}
                  >
                    Create new version
                  </Button>
                )}
                {detail.recipe.status === "active" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => statusMutation.mutate({ recipeId: detail.recipe.id, status: "archived" })}
                    disabled={statusMutation.isPending}
                  >
                    Archive
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Start production */}
      <Dialog open={Boolean(startRecipeId)} onOpenChange={(o) => !o && setStartRecipeId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Start production run</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="batches">Batches</Label>
            <Input id="batches" value={batches} onChange={(e) => setBatches(e.target.value)} inputMode="decimal" />
            <p className="text-xs text-muted-foreground">
              Inputs are exploded from the recipe now; stock moves when the run is completed.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
              Start run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Complete production */}
      <Dialog open={Boolean(completing)} onOpenChange={(o) => !o && setCompleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Complete {completing?.production_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="actual">Actual output quantity</Label>
            <Input
              id="actual"
              value={actualQuantity}
              onChange={(e) => setActualQuantity(e.target.value)}
              inputMode="decimal"
            />
            <p className="text-xs text-muted-foreground">
              Variance against the planned yield is recorded as evidence, not judged here.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => completeMutation.mutate()} disabled={completeMutation.isPending}>
              Post to ledger
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Product detail */}
      <Dialog open={Boolean(openProductId)} onOpenChange={(o) => !o && setOpenProductId(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{(productDetail.data as any)?.product?.name ?? "Product"}</DialogTitle>
          </DialogHeader>
          {productDetail.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : productDetail.data ? (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {(productDetail.data as any).product.sku} ·{" "}
                  {String((productDetail.data as any).product.product_type).replace("_", " ")}
                </span>
                {canManageProducts ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingProduct((productDetail.data as any).product);
                      setProductSheetOpen(true);
                    }}
                  >
                    Edit product
                  </Button>
                ) : null}
              </div>

              <div className="rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <p className="font-medium">Variants</p>
                  {canManageProducts ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9"
                      onClick={() => { setEditingVariant(null); setVariantSheetOpen(true); }}
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" /> Variant
                    </Button>
                  ) : null}
                </div>
                {((productDetail.data as any).variants ?? []).length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">No variants — this product sells as-is.</p>
                ) : (
                  <ul className="mt-2 divide-y text-xs">
                    {(productDetail.data as any).variants.map((v: any) => (
                      <li key={v.id} className="flex items-center justify-between py-1.5">
                        <button
                          type="button"
                          className="text-left hover:underline disabled:no-underline"
                          disabled={!canManageProducts}
                          onClick={() => { setEditingVariant(v); setVariantSheetOpen(true); }}
                        >
                          {v.name}
                        </button>
                        <span className="text-muted-foreground">
                          {v.price_is_delta ? "Δ" : ""}
                          {money(v.price)}
                          {!v.active ? " · inactive" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <AttachModifierGroupsPanel
                tenantId={tenantId!}
                productId={(productDetail.data as any).product.id}
                attachedGroupIds={((productDetail.data as any).modifierGroups ?? []).map((g: any) => g.group_id)}
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ProductSheet
        open={productSheetOpen}
        onOpenChange={(o) => {
          setProductSheetOpen(o);
          if (!o) void qc.invalidateQueries({ queryKey: ["restaurant.product", tenantId] });
        }}
        tenantId={tenantId ?? ""}
        product={editingProduct}
      />

      {openProductId ? (
        <VariantSheet
          open={variantSheetOpen}
          onOpenChange={(o) => {
            setVariantSheetOpen(o);
            if (!o) void qc.invalidateQueries({ queryKey: ["restaurant.product", tenantId, openProductId] });
          }}
          tenantId={tenantId ?? ""}
          productId={openProductId}
          variant={editingVariant}
        />
      ) : null}

      <RecipeSheet
        open={recipeSheetOpen}
        onOpenChange={setRecipeSheetOpen}
        tenantId={tenantId ?? ""}
        recipe={openRecipeId ? detail?.recipe : null}
        lines={editingRecipeLines}
      />

      <ModifierGroupSheet
        open={modifierGroupSheetOpen}
        onOpenChange={setModifierGroupSheetOpen}
        tenantId={tenantId ?? ""}
        group={editingModifierGroup}
      />

      {modifierSheetOpen ? (
        <ModifierSheet
          open={Boolean(modifierSheetOpen)}
          onOpenChange={(o) => !o && setModifierSheetOpen(null)}
          tenantId={tenantId ?? ""}
          groupId={modifierSheetOpen.groupId}
          modifier={modifierSheetOpen.modifier}
        />
      ) : null}

    </div>
  );
}
