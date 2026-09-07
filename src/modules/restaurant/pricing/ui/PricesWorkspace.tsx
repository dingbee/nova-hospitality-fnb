/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Prices — the operator-facing commercial pricing workspace.
 *
 * Item registry: restaurant_menu_items via getRestaurantPricingCatalogueFn
 * (which itself reads the same tables listRestaurantMenuItemsFn does —
 * nothing here is a second item registry). Authoritative price: the same
 * pricing engine POS/guest/Readiness already read. Every write — single or
 * bulk — goes through upsertRestaurantPriceFn/bulkUpsertRestaurantPricesFn,
 * which are thin wrappers around the one versioned upsertPrice function.
 * No UUID is ever typed by an operator here.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ChevronRight, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import {
  bulkUpsertRestaurantPricesFn,
  getRestaurantPricingCatalogueFn,
  listRestaurantCurrenciesFn,
  listRestaurantPriceListsFn,
  upsertRestaurantPriceFn,
} from "../pricing.functions";
import { listRestaurantCategoriesFn, listRestaurantMenusFn } from "../../menu/menu.functions";
import { PRICING_STATES, SALES_CHANNELS, type PricingState } from "../contracts";

const money = (n: unknown, currency = "") =>
  `${currency ? `${currency} ` : ""}${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const pct = (n: unknown) => (n == null ? "—" : `${Number(n).toFixed(1)}%`);

const STATE_LABEL: Record<PricingState, string> = {
  active: "Active",
  no_price: "No price",
  pending_approval: "Pending approval",
  scheduled: "Scheduled",
  expired: "Expired",
};
const STATE_TONE: Record<PricingState, StatusTone> = {
  active: "success",
  no_price: "danger",
  pending_approval: "warning",
  scheduled: "info",
  expired: "neutral",
};

export type PricesPreselect = { menuItemId?: string; status?: PricingState } | null;

export function PricesTab({
  tenantId,
  preselect,
  onPreselectConsumed,
}: {
  tenantId: string;
  preselect?: PricesPreselect;
  onPreselectConsumed?: () => void;
}) {
  const ws = useRestaurantWorkspace();
  const properties = (ws.data?.properties ?? []) as any[];
  const locations = (ws.data?.locations ?? []) as any[];

  const [propertyId, setPropertyId] = useState<string>("");
  const [locationId, setLocationId] = useState<string>("");
  const [channel, setChannel] = useState<string>("dine_in");
  const [menuId, setMenuId] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [status, setStatus] = useState<PricingState | "">(preselect?.status ?? "");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [configureItemId, setConfigureItemId] = useState<string | null>(
    preselect?.menuItemId ?? null,
  );
  const [configureOpen, setConfigureOpen] = useState(Boolean(preselect?.menuItemId));
  const [bulkOpen, setBulkOpen] = useState(false);

  const scopedLocations = propertyId
    ? locations.filter((l) => l.property_id === propertyId)
    : locations;

  const menusFn = useServerFn(listRestaurantMenusFn);
  const categoriesFn = useServerFn(listRestaurantCategoriesFn);
  const priceListsFn = useServerFn(listRestaurantPriceListsFn);
  const currenciesFn = useServerFn(listRestaurantCurrenciesFn);
  const catalogueFn = useServerFn(getRestaurantPricingCatalogueFn);

  const menus = useQuery({
    queryKey: ["restaurant.pricing.menus", tenantId],
    queryFn: () => menusFn({ data: { tenantId } }),
  });
  const categories = useQuery({
    queryKey: ["restaurant.pricing.categories", tenantId],
    queryFn: () => categoriesFn({ data: { tenantId } }),
  });
  const priceLists = useQuery({
    queryKey: ["restaurant.pricing.priceLists", tenantId],
    queryFn: () => priceListsFn({ data: { tenantId, activeOnly: true } }),
  });
  const currencies = useQuery({
    queryKey: ["restaurant.pricing.currencies", tenantId],
    queryFn: () => currenciesFn({ data: { tenantId, activeOnly: true } }),
  });
  const baseCurrency =
    ((currencies.data as any[] | undefined)?.find((c) => c.is_base)?.code as string | undefined) ??
    "USD";

  const catalogueKey = [
    "restaurant.pricing.catalogue",
    tenantId,
    propertyId,
    locationId,
    channel,
    menuId,
    categoryId,
    status,
    search,
  ];
  const catalogue = useQuery({
    queryKey: catalogueKey,
    queryFn: () =>
      catalogueFn({
        data: {
          tenantId,
          propertyId: propertyId || undefined,
          locationId: locationId || undefined,
          channel: channel as any,
          menuId: menuId || undefined,
          categoryId: categoryId || undefined,
          status: status || undefined,
          search: search || undefined,
        },
      }),
  });
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["restaurant.pricing.catalogue", tenantId] });
    qc.invalidateQueries({ queryKey: ["restaurant.pricing.readiness", tenantId] });
    qc.invalidateQueries({ queryKey: ["restaurant.pricing.audit", tenantId] });
  };

  const report = catalogue.data as { total: number; rows: any[] } | undefined;
  const rows: any[] = report?.rows ?? [];

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.menuItemId)),
    );
  };

  const configureItem = configureItemId ? rows.find((r) => r.menuItemId === configureItemId) : null;

  const closeConfigure = () => {
    setConfigureOpen(false);
    setConfigureItemId(null);
    onPreselectConsumed?.();
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title="Prices"
        description="Manage authoritative selling prices across properties, outlets and sales channels."
        actions={
          <Button
            className="h-11"
            onClick={() => {
              setConfigureItemId(null);
              setConfigureOpen(true);
            }}
          >
            <Plus className="mr-1.5 size-4" /> Configure Price
          </Button>
        }
      >
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <div className="relative sm:col-span-2 lg:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-11 pl-9"
              placeholder="Search item name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select
            value={propertyId || "__all"}
            onValueChange={(v) => {
              setPropertyId(v === "__all" ? "" : v);
              setLocationId("");
            }}
          >
            <SelectTrigger className="h-11">
              <SelectValue placeholder="Property" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Every property</SelectItem>
              {properties.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={locationId || "__all"}
            onValueChange={(v) => setLocationId(v === "__all" ? "" : v)}
          >
            <SelectTrigger className="h-11">
              <SelectValue placeholder="Outlet" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Every outlet</SelectItem>
              {scopedLocations.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={menuId || "__all"}
            onValueChange={(v) => setMenuId(v === "__all" ? "" : v)}
          >
            <SelectTrigger className="h-11">
              <SelectValue placeholder="Menu" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Every menu</SelectItem>
              {((menus.data ?? []) as any[]).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={categoryId || "__all"}
            onValueChange={(v) => setCategoryId(v === "__all" ? "" : v)}
          >
            <SelectTrigger className="h-11">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Every category</SelectItem>
              {((categories.data ?? []) as any[]).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {SALES_CHANNELS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChannel(c)}
              className={`min-h-9 rounded border px-3 text-xs ${
                channel === c ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {c.replace(/_/g, " ")}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" />
          {(["", ...PRICING_STATES] as const).map((s) => (
            <button
              key={s || "__any"}
              type="button"
              onClick={() => setStatus(s as PricingState | "")}
              className={`min-h-9 rounded border px-3 text-xs ${
                status === s ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {s ? STATE_LABEL[s] : "Every state"}
            </button>
          ))}
        </div>

        {catalogue.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading the pricing grid…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No items match these filters"
            description="Broaden the property, outlet, menu or status filter above."
          />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={selected.size > 0 && selected.size === rows.length}
                      onCheckedChange={toggleAll}
                    />
                  </TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Current price</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.menuItemId}
                    data-state={selected.has(r.menuItemId) ? "selected" : undefined}
                  >
                    <TableCell>
                      <Checkbox
                        checked={selected.has(r.menuItemId)}
                        onCheckedChange={() => toggleSelected(r.menuItemId)}
                      />
                    </TableCell>
                    <TableCell className="min-w-0">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.menuName}
                        {r.categoryName ? ` · ${r.categoryName}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.recipeCost != null ? money(r.recipeCost, r.currency ?? baseCurrency) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {r.activePrice
                        ? money(r.activePrice.amount, r.activePrice.currency)
                        : r.pendingPrice
                          ? money(r.pendingPrice.amount, r.pendingPrice.currency)
                          : r.scheduledPrice
                            ? money(r.scheduledPrice.amount, r.scheduledPrice.currency)
                            : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pct(r.marginPercent)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {channel.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell>
                      <StatusChip tone={STATE_TONE[r.state as PricingState]}>
                        {STATE_LABEL[r.state as PricingState]}
                      </StatusChip>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setConfigureItemId(r.menuItemId);
                          setConfigureOpen(true);
                        }}
                      >
                        {r.state === "no_price" ? "Configure" : "Edit"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {selected.size > 0 ? (
        <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-xl border bg-card p-3 shadow-lg">
          <span className="pl-2 text-sm font-medium">{selected.size} items selected</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button onClick={() => setBulkOpen(true)}>Configure Prices</Button>
          </div>
        </div>
      ) : null}

      <ConfigurePriceSheet
        open={configureOpen}
        onOpenChange={(v) => {
          if (!v) closeConfigure();
          else setConfigureOpen(true);
        }}
        tenantId={tenantId}
        item={configureItem ?? null}
        allRows={rows}
        onPickItem={(id) => setConfigureItemId(id)}
        properties={properties}
        locations={locations}
        defaultPropertyId={propertyId}
        defaultLocationId={locationId}
        defaultChannel={channel}
        priceLists={(priceLists.data ?? []) as any[]}
        baseCurrency={baseCurrency}
        onSaved={() => {
          invalidate();
          closeConfigure();
        }}
      />

      <BulkConfigureSheet
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        tenantId={tenantId}
        items={rows.filter((r) => selected.has(r.menuItemId))}
        properties={properties}
        locations={locations}
        defaultPropertyId={propertyId}
        defaultLocationId={locationId}
        defaultChannel={channel}
        priceLists={(priceLists.data ?? []) as any[]}
        baseCurrency={baseCurrency}
        onSaved={() => {
          invalidate();
          setBulkOpen(false);
          setSelected(new Set());
        }}
      />
    </div>
  );
}

/* ---------------- Single-item configuration ---------------- */

function ConfigurePriceSheet({
  open,
  onOpenChange,
  tenantId,
  item,
  allRows,
  onPickItem,
  properties,
  locations,
  defaultPropertyId,
  defaultLocationId,
  defaultChannel,
  priceLists,
  baseCurrency,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tenantId: string;
  item: any | null;
  allRows: any[];
  onPickItem: (menuItemId: string) => void;
  properties: any[];
  locations: any[];
  defaultPropertyId: string;
  defaultLocationId: string;
  defaultChannel: string;
  priceLists: any[];
  baseCurrency: string;
  onSaved: () => void;
}) {
  const saveFn = useServerFn(upsertRestaurantPriceFn);
  const [propertyId, setPropertyId] = useState(defaultPropertyId);
  const [locationId, setLocationId] = useState(defaultLocationId);
  const [channel, setChannel] = useState(defaultChannel);
  const [priceListId, setPriceListId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(baseCurrency);
  const [taxInclusive, setTaxInclusive] = useState(false);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);

  // Reset the form to the current filters/currency every time a fresh
  // configuration sheet is opened for a (possibly different) item.
  const [lastItemId, setLastItemId] = useState<string | null>(null);
  if (open && item?.menuItemId !== lastItemId) {
    setLastItemId(item?.menuItemId ?? null);
    setPropertyId(defaultPropertyId);
    setLocationId(defaultLocationId);
    setChannel(defaultChannel);
    setPriceListId("");
    setAmount("");
    setCurrency(item?.currency ?? baseCurrency);
    setTaxInclusive(false);
    setScheduleLater(false);
    setEffectiveFrom("");
    setReason("");
    setRequiresApproval(false);
  }

  const scopedLocations = propertyId
    ? locations.filter((l) => l.property_id === propertyId)
    : locations;

  const save = useAdminMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          propertyId: propertyId || undefined,
          locationId: locationId || undefined,
          menuItemId: item!.menuItemId,
          scope: locationId ? "location" : propertyId ? "property" : "tenant",
          priceListId: priceListId || null,
          channel: channel as any,
          currency,
          amount: Number(amount),
          taxInclusive,
          effectiveFrom:
            scheduleLater && effectiveFrom ? new Date(effectiveFrom).toISOString() : undefined,
          reason: reason || undefined,
          requiresApproval,
          activate: !requiresApproval,
        },
      }),
    onSuccessToast: () => (requiresApproval ? "Submitted for approval" : "Price activated"),
    onSuccess: onSaved,
  });

  const parsedAmount = Number(amount);
  const recipeCost = item?.recipeCost ?? null;
  const foodCostPercent =
    recipeCost != null && parsedAmount > 0 ? (recipeCost / parsedAmount) * 100 : null;
  const grossContribution =
    recipeCost != null && parsedAmount > 0 ? parsedAmount - recipeCost : null;
  const grossMargin =
    grossContribution != null && parsedAmount > 0 ? (grossContribution / parsedAmount) * 100 : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Configure Price</SheetTitle>
          <SheetDescription>
            A new price version supersedes the current one. Nothing is overwritten — history stays
            intact.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {!item ? (
            <Field label="Item">
              <Command className="rounded-lg border">
                <CommandInput placeholder="Search menu item by name…" />
                <CommandList>
                  <CommandEmpty>No item matches.</CommandEmpty>
                  <CommandGroup>
                    {allRows.map((r) => (
                      <CommandItem
                        key={r.menuItemId}
                        value={r.name}
                        onSelect={() => onPickItem(r.menuItemId)}
                      >
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                          {r.menuName}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </Field>
          ) : (
            <>
              <div className="rounded-lg border bg-card/40 p-3">
                <p className="font-medium">{item.name}</p>
                <p className="text-xs text-muted-foreground">
                  {item.menuName}
                  {item.categoryName ? ` · ${item.categoryName}` : ""}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Property">
                  <Select
                    value={propertyId || "__tenant"}
                    onValueChange={(v) => {
                      setPropertyId(v === "__tenant" ? "" : v);
                      setLocationId("");
                    }}
                  >
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__tenant">Every property (tenant default)</SelectItem>
                      {properties.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Outlet">
                  <Select
                    value={locationId || "__property"}
                    onValueChange={(v) => setLocationId(v === "__property" ? "" : v)}
                  >
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__property">Every outlet</SelectItem>
                      {scopedLocations.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Channel">
                  <Select value={channel} onValueChange={setChannel}>
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SALES_CHANNELS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Price list (optional)">
                  <Select
                    value={priceListId || "__none"}
                    onValueChange={(v) => setPriceListId(v === "__none" ? "" : v)}
                  >
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">No price list</SelectItem>
                      {priceLists.map((pl) => (
                        <SelectItem key={pl.id} value={pl.id}>
                          {pl.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Selling price">
                  <Input
                    className="h-11"
                    type="number"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0"
                  />
                </Field>
                <Field label="Currency">
                  <Input
                    className="h-11"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle label="Tax inclusive" checked={taxInclusive} onChange={setTaxInclusive} />
                <Toggle
                  label="Schedule for later"
                  checked={scheduleLater}
                  onChange={setScheduleLater}
                />
              </div>
              {scheduleLater ? (
                <Field label="Effective from">
                  <Input
                    className="h-11"
                    type="datetime-local"
                    value={effectiveFrom}
                    onChange={(e) => setEffectiveFrom(e.target.value)}
                  />
                </Field>
              ) : null}
              <Field label="Reason (optional)">
                <Input
                  className="h-11"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. supplier cost increase"
                />
              </Field>

              {parsedAmount > 0 ? (
                <div className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
                  <Row2
                    label="Recipe cost"
                    value={recipeCost != null ? money(recipeCost, currency) : "Not available"}
                  />
                  <Row2 label="Selling price" value={money(parsedAmount, currency)} />
                  <Row2
                    label="Food cost"
                    value={foodCostPercent != null ? pct(foodCostPercent) : "—"}
                  />
                  <Row2
                    label="Gross contribution"
                    value={grossContribution != null ? money(grossContribution, currency) : "—"}
                  />
                  <Row2
                    label="Gross margin"
                    value={grossMargin != null ? pct(grossMargin) : "—"}
                    strong
                  />
                </div>
              ) : null}

              <Toggle
                label="Require approval before it goes live"
                checked={requiresApproval}
                onChange={setRequiresApproval}
              />

              <Button
                className="h-11 w-full"
                disabled={!amount || Number(amount) <= 0 || save.isPending}
                onClick={() => save.mutate(undefined as never)}
              >
                {requiresApproval ? "Submit for Approval" : "Save & Activate"}
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Row2({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-semibold" : ""}>{value}</span>
    </div>
  );
}

/* ---------------- Bulk configuration ---------------- */

type BulkStep = "form" | "preview";

function BulkConfigureSheet({
  open,
  onOpenChange,
  tenantId,
  items,
  properties,
  locations,
  defaultPropertyId,
  defaultLocationId,
  defaultChannel,
  priceLists,
  baseCurrency,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tenantId: string;
  items: any[];
  properties: any[];
  locations: any[];
  defaultPropertyId: string;
  defaultLocationId: string;
  defaultChannel: string;
  priceLists: any[];
  baseCurrency: string;
  onSaved: () => void;
}) {
  const bulkFn = useServerFn(bulkUpsertRestaurantPricesFn);
  const [step, setStep] = useState<BulkStep>("form");
  const [propertyId, setPropertyId] = useState(defaultPropertyId);
  const [locationId, setLocationId] = useState(defaultLocationId);
  const [channel, setChannel] = useState(defaultChannel);
  const [priceListId, setPriceListId] = useState("");
  const [currency, setCurrency] = useState(baseCurrency);
  const [method, setMethod] = useState<"individual" | "uniform">("individual");
  const [uniformAmount, setUniformAmount] = useState("");
  const [uniformConfirmed, setUniformConfirmed] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);

  // Fresh defaults whenever the sheet opens on a (possibly new) selection.
  const [lastOpenKey, setLastOpenKey] = useState<string | null>(null);
  const openKey = open ? items.map((i) => i.menuItemId).join(",") : null;
  if (open && openKey !== lastOpenKey) {
    setLastOpenKey(openKey);
    setStep("form");
    setPropertyId(defaultPropertyId);
    setLocationId(defaultLocationId);
    setChannel(defaultChannel);
    setPriceListId("");
    setCurrency(baseCurrency);
    setMethod("individual");
    setUniformAmount("");
    setUniformConfirmed(false);
    setAmounts({});
    setReason("");
    setRequiresApproval(false);
  }

  const scopedLocations = propertyId
    ? locations.filter((l) => l.property_id === propertyId)
    : locations;

  const lines = useMemo(
    () =>
      items.map((it) => ({
        menuItemId: it.menuItemId as string,
        name: it.name as string,
        currentAmount: it.activePrice?.amount ?? null,
        amount:
          method === "uniform" ? Number(uniformAmount || 0) : Number(amounts[it.menuItemId] || 0),
      })),
    [items, method, uniformAmount, amounts],
  );
  const canPreview =
    lines.length > 0 &&
    lines.every((l) => l.amount > 0) &&
    (method === "individual" || uniformConfirmed);

  const bulkSave = useAdminMutation({
    mutationFn: () =>
      bulkFn({
        data: {
          tenantId,
          propertyId: propertyId || undefined,
          locationId: locationId || undefined,
          scope: locationId ? "location" : propertyId ? "property" : "tenant",
          channel: channel as any,
          priceListId: priceListId || null,
          currency,
          taxInclusive: false,
          reason: reason || undefined,
          requiresApproval,
          lines: lines.map((l) => ({ menuItemId: l.menuItemId, amount: l.amount })),
        },
      }),
    onSuccessToast: (data: any) =>
      data.failed > 0
        ? `${data.succeeded} of ${data.total} prices configured — ${data.failed} failed.`
        : `${data.succeeded} price${data.succeeded === 1 ? "" : "s"} configured.`,
    onSuccess: onSaved,
  });

  const scopeLabel = locationId
    ? locations.find((l) => l.id === locationId)?.name
    : propertyId
      ? properties.find((p) => p.id === propertyId)?.name
      : "Every property (tenant default)";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Configure Prices — {items.length} items</SheetTitle>
          <SheetDescription>
            {step === "form"
              ? "Choose scope, channel and how the new prices are set."
              : "Review before creating new price versions."}
          </SheetDescription>
        </SheetHeader>

        {step === "form" ? (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Property">
                <Select
                  value={propertyId || "__tenant"}
                  onValueChange={(v) => {
                    setPropertyId(v === "__tenant" ? "" : v);
                    setLocationId("");
                  }}
                >
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__tenant">Every property (tenant default)</SelectItem>
                    {properties.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Outlet">
                <Select
                  value={locationId || "__property"}
                  onValueChange={(v) => setLocationId(v === "__property" ? "" : v)}
                >
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__property">Every outlet</SelectItem>
                    {scopedLocations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Channel">
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SALES_CHANNELS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Price list (optional)">
                <Select
                  value={priceListId || "__none"}
                  onValueChange={(v) => setPriceListId(v === "__none" ? "" : v)}
                >
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No price list</SelectItem>
                    {priceLists.map((pl) => (
                      <SelectItem key={pl.id} value={pl.id}>
                        {pl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Currency">
                <Input
                  className="h-11"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                />
              </Field>
              <Field label="Reason (optional)">
                <Input
                  className="h-11"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
            </div>

            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Pricing method
              </Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setMethod("individual")}
                  className={`min-h-11 flex-1 rounded border px-3 text-sm ${method === "individual" ? "border-primary bg-primary/10" : ""}`}
                >
                  Set prices individually
                </button>
                <button
                  type="button"
                  onClick={() => setMethod("uniform")}
                  className={`min-h-11 flex-1 rounded border px-3 text-sm ${method === "uniform" ? "border-primary bg-primary/10" : ""}`}
                >
                  Apply the same price to all
                </button>
              </div>
            </div>

            {method === "individual" ? (
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border p-3">
                {items.map((it) => (
                  <div key={it.menuItemId} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-sm">{it.name}</span>
                    <Input
                      className="h-10 w-32"
                      type="number"
                      inputMode="decimal"
                      placeholder={it.activePrice ? String(it.activePrice.amount) : "0"}
                      value={amounts[it.menuItemId] ?? ""}
                      onChange={(e) =>
                        setAmounts((prev) => ({ ...prev, [it.menuItemId]: e.target.value }))
                      }
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <Field label="Price for every selected item">
                  <Input
                    className="h-11"
                    type="number"
                    inputMode="decimal"
                    value={uniformAmount}
                    onChange={(e) => setUniformAmount(e.target.value)}
                  />
                </Field>
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4"
                      checked={uniformConfirmed}
                      onChange={(e) => setUniformConfirmed(e.target.checked)}
                    />
                    <span>
                      Applying the same price to {items.length} different items can be commercially
                      dangerous — they may have different costs and margins. I've checked this is
                      intentional.
                    </span>
                  </label>
                </div>
              </div>
            )}

            <Toggle
              label="Require approval before it goes live"
              checked={requiresApproval}
              onChange={setRequiresApproval}
            />

            <Button
              className="h-11 w-full"
              disabled={!canPreview}
              onClick={() => setStep("preview")}
            >
              Preview changes <ChevronRight className="ml-1 size-4" />
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <p className="text-sm font-medium">
              {lines.length} item{lines.length === 1 ? "" : "s"} will receive new commercial prices.
            </p>
            <div className="max-h-72 divide-y overflow-y-auto rounded-lg border">
              {lines.map((l) => (
                <div
                  key={l.menuItemId}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate">{l.name}</span>
                  <span className="tabular-nums">
                    {l.currentAmount != null ? money(l.currentAmount, currency) : "—"} →{" "}
                    <b>{money(l.amount, currency)}</b>
                  </span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
              <Row2 label="Scope" value={scopeLabel ?? "Tenant"} />
              <Row2 label="Channel" value={channel.replace(/_/g, " ")} />
              <Row2 label="Effective" value="Immediately" />
              <Row2
                label="Approval"
                value={requiresApproval ? "Required" : "Publish immediately"}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              New price versions will be created. Existing historical prices will not be
              overwritten.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="h-11 flex-1" onClick={() => setStep("form")}>
                Back
              </Button>
              <Button
                className="h-11 flex-1"
                disabled={bulkSave.isPending}
                onClick={() => bulkSave.mutate(undefined as never)}
              >
                Confirm & Activate
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/* ---------------- Small building blocks (shared with the rest of the Centre) ---------------- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
