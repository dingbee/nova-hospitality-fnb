/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Pricing Centre — the commercial workspace.
 *
 * Touch-first: large controls, explicit effective dates, and the chain kept
 * visible at all times — cost → price → tax → service charge → discount →
 * promotion → final value. Nothing here changes a price silently.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatCard } from "@/components/os/StatCard";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import {
  applyRestaurantDiscountFn,
  decideRestaurantPriceFn,
  getRestaurantCommercialEvidenceFn,
  listRestaurantCurrenciesFn,
  listRestaurantDiscountRulesFn,
  listRestaurantExchangeRatesFn,
  listRestaurantPricesFn,
  listRestaurantPricingAuditFn,
  listRestaurantPromotionsFn,
  listRestaurantServiceChargesFn,
  listRestaurantTaxRulesFn,
  restaurantPricingReadinessFn,
  setRestaurantPromotionStatusFn,
  simulateRestaurantPricingFn,
  upsertRestaurantCurrencyFn,
  upsertRestaurantDiscountRuleFn,
  upsertRestaurantExchangeRateFn,
  upsertRestaurantPriceFn,
  upsertRestaurantPromotionFn,
  upsertRestaurantServiceChargeFn,
  upsertRestaurantTaxRuleFn,
} from "../pricing.functions";
import { PriceListsTab, RoundingTab } from "./CommercialRulesTabs";
import { SALES_CHANNELS } from "../contracts";

const TABS = [
  { id: "readiness", label: "Readiness" },
  { id: "prices", label: "Prices" },
  { id: "priceLists", label: "Price lists" },
  { id: "promotions", label: "Promotions" },
  { id: "taxes", label: "Taxes & service" },
  { id: "discounts", label: "Discount rules" },
  { id: "rounding", label: "Rounding" },
  { id: "currencies", label: "Currencies" },
  { id: "simulation", label: "Simulation" },
  { id: "audit", label: "Audit history" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const num = (n: unknown, dp = 2) =>
  Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: dp });
const money = (n: unknown, currency = "USD") => `${currency} ${num(n)}`;

const PRICE_TONE: Record<string, StatusTone> = {
  active: "success",
  pending_approval: "warning",
  draft: "neutral",
  superseded: "neutral",
  expired: "neutral",
  rejected: "danger",
};

function Row({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-3">{children}</li>
  );
}

export function PricingCentre() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id as string | undefined;
  const [tab, setTab] = useState<TabId>("prices");

  if (!ws.isLoading && !ws.data?.tenant) {
    return (
      <EmptyState
        title="No restaurant tenant"
        description="You are not a member of a Restaurant & Bar OS tenant."
      />
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pricing Centre"
        description="Cost → price strategy → selling price → tax → service charge → discount → promotion → final value. Prices are versioned; history is never overwritten."
      />
      <nav className="flex flex-wrap gap-1 rounded-lg border bg-card p-1 text-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`min-h-11 rounded px-4 py-2 ${
              tab === t.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tenantId ? (
        <>
          {tab === "readiness" && <ReadinessTab tenantId={tenantId} />}
          {tab === "prices" && <PricesTab tenantId={tenantId} />}
          {tab === "priceLists" && <PriceListsTab tenantId={tenantId} />}
          {tab === "promotions" && <PromotionsTab tenantId={tenantId} />}
          {tab === "taxes" && <TaxesTab tenantId={tenantId} />}
          {tab === "discounts" && <DiscountsTab tenantId={tenantId} />}
          {tab === "rounding" && <RoundingTab tenantId={tenantId} />}
          {tab === "currencies" && <CurrenciesTab tenantId={tenantId} />}
          {tab === "simulation" && <SimulationTab tenantId={tenantId} />}
          {tab === "audit" && <AuditTab tenantId={tenantId} />}
        </>
      ) : (
        <SectionCard title="Loading">
          <p className="text-sm text-muted-foreground">Resolving your restaurant workspace…</p>
        </SectionCard>
      )}
    </div>
  );
}

/* ---------------- Readiness ---------------- */

/**
 * Answers one operational question: could the till sell this, right now?
 * It re-runs the real pricing engine per item and reports what it found —
 * it never creates a price, so "not ready" stays visible until someone
 * configures a price deliberately.
 */
function ReadinessTab({ tenantId }: { tenantId: string }) {
  const readinessFn = useServerFn(restaurantPricingReadinessFn);
  const [channel, setChannel] = useState<string>("dine_in");
  const [onlyBlocked, setOnlyBlocked] = useState(true);

  const q = useQuery({
    queryKey: ["restaurant.pricing.readiness", tenantId, channel],
    queryFn: () => readinessFn({ data: { tenantId, channel } }),
  });
  const report = q.data as any;
  const rows: any[] = report?.rows ?? [];
  const shown = onlyBlocked ? rows.filter((r) => !r.ready || r.divergent) : rows;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard label="Sellable items" value={num(report?.total ?? 0, 0)} />
        <StatCard label="Priced by rules" value={num(report?.ready ?? 0, 0)} />
        <StatCard label="Cannot be sold" value={num(report?.blocked ?? 0, 0)} />
        <StatCard label="Menu card differs" value={num(report?.divergent ?? 0, 0)} />
      </div>

      <SectionCard
        title="Commercial readiness"
        description="Each available item on a published menu is quoted through the live pricing engine, exactly as the POS would. Nothing is created or corrected here."
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {SALES_CHANNELS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChannel(c)}
              className={`min-h-11 rounded border px-3 text-sm ${
                channel === c ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {c.replace(/_/g, " ")}
            </button>
          ))}
          <Button variant="outline" className="h-11" onClick={() => setOnlyBlocked((v) => !v)}>
            {onlyBlocked ? "Show every item" : "Show only exceptions"}
          </Button>
        </div>

        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Quoting every sellable item…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing to audit"
            description="No available items on a published menu were found for this tenant."
          />
        ) : shown.length === 0 ? (
          <EmptyState
            title="Every item is priced"
            description={`All ${report.total} sellable items resolve to a configured price on the ${channel.replace(/_/g, " ")} channel.`}
          />
        ) : (
          <ul className="divide-y">
            {shown.map((r) => (
              <Row key={`${r.menuItemId}-${r.channel}`}>
                <span className="min-w-0">
                  <span className="block font-medium">{r.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {r.menuName} · {r.locationName}
                    {r.reason ? ` · ${r.reason}` : ""}
                    {r.ready && r.divergent
                      ? ` · menu card shows ${money(r.menuCardPrice, r.currency ?? "USD")}`
                      : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {r.ready ? (
                    <>
                      <span className="text-sm tabular-nums">{money(r.unitPrice, r.currency ?? "USD")}</span>
                      <StatusChip tone="neutral">{String(r.priceSource ?? "rule")}</StatusChip>
                      {r.divergent ? <StatusChip tone="warning">Menu card differs</StatusChip> : null}
                      <StatusChip tone="success">Sellable</StatusChip>
                    </>
                  ) : (
                    <StatusChip tone="danger">No price configured</StatusChip>
                  )}
                </span>
              </Row>
            ))}
          </ul>
        )}

        {report ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Rules in force: {report.rulesInForce.prices} prices · {report.rulesInForce.priceLists} price
            lists · {report.rulesInForce.taxes} tax rules · {report.rulesInForce.serviceCharges} service
            charges · {report.rulesInForce.promotions} promotions · {report.rulesInForce.roundingRules}{" "}
            rounding rules.
          </p>
        ) : null}
      </SectionCard>
    </div>
  );
}

/* ---------------- Prices ---------------- */

function PricesTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listRestaurantPricesFn);
  const saveFn = useServerFn(upsertRestaurantPriceFn);
  const decideFn = useServerFn(decideRestaurantPriceFn);
  const evidenceFn = useServerFn(getRestaurantCommercialEvidenceFn);

  const prices = useQuery({
    queryKey: ["restaurant.prices", tenantId],
    queryFn: () => listFn({ data: { tenantId, includeHistory: true, limit: 200 } }),
  });
  const evidence = useQuery({
    queryKey: ["restaurant.commercial.evidence", tenantId],
    queryFn: () => evidenceFn({ data: { tenantId, lookbackDays: 30 } }),
  });

  const [menuItemId, setMenuItemId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [scope, setScope] = useState<"tenant" | "property" | "location">("tenant");
  const [priceChannel, setPriceChannel] = useState("");
  const [priceListId, setPriceListId] = useState("");
  const [taxInclusive, setTaxInclusive] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["restaurant.prices", tenantId] });
    qc.invalidateQueries({ queryKey: ["restaurant.pricing.audit", tenantId] });
  };

  const save = useAdminMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          menuItemId: menuItemId || undefined,
          scope,
          channel: priceChannel ? (priceChannel as never) : null,
          priceListId: priceListId || null,
          currency,
          amount: Number(amount),
          taxInclusive,
          effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : undefined,
          reason: reason || undefined,
          requiresApproval,
          activate: !requiresApproval,
        },
      }),
    successMessage: "New price version created",
    onSuccess: () => {
      setAmount("");
      setReason("");
      invalidate();
    },
  });

  const decide = useAdminMutation({
    mutationFn: (v: { priceId: string; decision: "approve" | "reject" }) =>
      decideFn({ data: { tenantId, ...v } }),
    successMessage: "Price decision recorded",
    onSuccess: invalidate,
  });

  const ev = evidence.data as any;
  const rows = (prices.data ?? []) as any[];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Price changes (30d)"
          value={num(ev?.price_changes?.count ?? 0, 0)}
          tone="info"
        />
        <StatCard
          label="Awaiting approval"
          value={num(ev?.price_changes?.pending_approval ?? 0, 0)}
          tone="gold"
        />
        <StatCard
          label="Gross margin"
          value={`${num(ev?.revenue?.margin_percent ?? 0)}%`}
          tone="green"
        />
        <StatCard
          label="Discount rate"
          value={`${num(ev?.discounts?.discount_rate_percent ?? 0)}%`}
          tone="warn"
        />
      </div>

      <SectionCard
        title="New price version"
        description="A change never overwrites the current price — it supersedes it, so past receipts stay reproducible."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Menu item ID">
            <Input
              className="h-11"
              value={menuItemId}
              onChange={(e) => setMenuItemId(e.target.value)}
              placeholder="uuid"
            />
          </Field>
          <Field label="Amount">
            <Input
              className="h-11"
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Currency">
            <Input
              className="h-11"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Scope">
            <select
              className="h-11 w-full rounded border border-border bg-background px-3 text-sm"
              value={scope}
              onChange={(e) => setScope(e.target.value as never)}
            >
              <option value="tenant">Tenant default</option>
              <option value="property">Property override</option>
              <option value="location">Outlet override</option>
            </select>
          </Field>
          <Field label="Effective from">
            <Input
              className="h-11"
              type="datetime-local"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </Field>
          <Field label="Channel">
            <select
              className="h-11 w-full rounded border border-border bg-background px-3 text-sm"
              value={priceChannel}
              onChange={(e) => setPriceChannel(e.target.value)}
            >
              <option value="">Every channel</option>
              {SALES_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Price list (optional)">
            <Input
              className="h-11"
              value={priceListId}
              onChange={(e) => setPriceListId(e.target.value)}
              placeholder="price list uuid"
            />
          </Field>
          <Field label="Change reason">
            <Input
              className="h-11"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. supplier cost increase"
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <Toggle label="Tax inclusive" checked={taxInclusive} onChange={setTaxInclusive} />
          <Toggle
            label="Send for approval"
            checked={requiresApproval}
            onChange={setRequiresApproval}
          />
          <Button
            className="h-11"
            disabled={!amount || save.isPending}
            onClick={() => save.mutate(undefined as never)}
          >
            Create version
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Price history"
        description="Newest first. Superseded versions remain for audit and reprinting."
      >
        {rows.length === 0 ? (
          <EmptyState title="No prices yet" description="Create the first price version above." />
        ) : (
          <ul className="divide-y">
            {rows.map((p) => (
              <Row key={p.id}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{money(p.amount, p.currency)}</span>
                    <StatusChip tone={PRICE_TONE[p.status] ?? "neutral"}>{p.status}</StatusChip>
                    <StatusChip tone="info">{p.scope}</StatusChip>
                    <span className="text-xs text-muted-foreground">v{p.version}</span>
                    {p.tax_inclusive && <StatusChip tone="neutral">tax incl.</StatusChip>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {new Date(p.effective_from).toLocaleString()}
                    {p.effective_to ? ` → ${new Date(p.effective_to).toLocaleString()}` : " → open"}
                    {p.reason ? ` · ${p.reason}` : ""}
                  </p>
                </div>
                {p.status === "pending_approval" && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-10"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ priceId: p.id, decision: "approve" })}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-10"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ priceId: p.id, decision: "reject" })}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </Row>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/* ---------------- Promotions ---------------- */

function PromotionsTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listRestaurantPromotionsFn);
  const saveFn = useServerFn(upsertRestaurantPromotionFn);
  const statusFn = useServerFn(setRestaurantPromotionStatusFn);
  const list = useQuery({
    queryKey: ["restaurant.promotions", tenantId],
    queryFn: () => listFn({ data: { tenantId } }),
  });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [action, setAction] = useState("percent_discount");
  const [value, setValue] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["restaurant.promotions", tenantId] });
  const save = useAdminMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          code,
          name,
          action: action as never,
          value: Number(value || 0),
          startTime: startTime || null,
          endTime: endTime || null,
          status: "draft",
        },
      }),
    successMessage: "Promotion saved",
    onSuccess: () => {
      setCode("");
      setName("");
      setValue("");
      invalidate();
    },
  });
  const setStatus = useAdminMutation({
    mutationFn: (v: { promotionId: string; status: string }) =>
      statusFn({ data: { tenantId, promotionId: v.promotionId, status: v.status as never } }),
    successMessage: "Promotion updated",
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="New promotion"
        description="Happy hour, seasonal menu, weekend pricing or an event rate."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Code">
            <Input className="h-11" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label="Name">
            <Input className="h-11" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Action">
            <select
              className="h-11 w-full rounded border border-border bg-background px-3 text-sm"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              <option value="percent_discount">Percent discount</option>
              <option value="fixed_discount">Fixed discount</option>
              <option value="price_override">Price override</option>
              <option value="percent_uplift">Percent uplift</option>
            </select>
          </Field>
          <Field label="Value">
            <Input
              className="h-11"
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <Field label="From (time)">
            <Input
              className="h-11"
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </Field>
          <Field label="To (time)">
            <Input
              className="h-11"
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </Field>
        </div>
        <Button
          className="mt-3 h-11"
          disabled={!code || !name || save.isPending}
          onClick={() => save.mutate(undefined as never)}
        >
          Save promotion
        </Button>
      </SectionCard>

      <SectionCard title="Promotions">
        {((list.data ?? []) as any[]).length === 0 ? (
          <EmptyState
            title="No promotions"
            description="Promotions apply on top of the resolved base price."
          />
        ) : (
          <ul className="divide-y">
            {((list.data ?? []) as any[]).map((p) => (
              <Row key={p.id}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <StatusChip
                      tone={
                        p.status === "active"
                          ? "success"
                          : p.status === "cancelled"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {p.status}
                    </StatusChip>
                    <span className="text-xs text-muted-foreground">
                      {p.action} · {num(p.value)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {p.start_time && p.end_time ? `${p.start_time} → ${p.end_time}` : "All day"} ·
                    priority {p.priority}
                  </p>
                </div>
                <div className="flex gap-2">
                  {p.status !== "active" && (
                    <Button
                      size="sm"
                      className="h-10"
                      onClick={() => setStatus.mutate({ promotionId: p.id, status: "active" })}
                    >
                      Activate
                    </Button>
                  )}
                  {p.status === "active" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-10"
                      onClick={() => setStatus.mutate({ promotionId: p.id, status: "ended" })}
                    >
                      End
                    </Button>
                  )}
                </div>
              </Row>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/* ---------------- Taxes & service charges ---------------- */

function TaxesTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const taxesFn = useServerFn(listRestaurantTaxRulesFn);
  const svcFn = useServerFn(listRestaurantServiceChargesFn);
  const saveTaxFn = useServerFn(upsertRestaurantTaxRuleFn);
  const saveSvcFn = useServerFn(upsertRestaurantServiceChargeFn);

  const taxes = useQuery({
    queryKey: ["restaurant.taxes", tenantId],
    queryFn: () => taxesFn({ data: { tenantId } }),
  });
  const charges = useQuery({
    queryKey: ["restaurant.servicecharges", tenantId],
    queryFn: () => svcFn({ data: { tenantId } }),
  });

  const [taxCode, setTaxCode] = useState("");
  const [taxName, setTaxName] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [inclusive, setInclusive] = useState(false);
  const [svcCode, setSvcCode] = useState("");
  const [svcName, setSvcName] = useState("");
  const [svcRate, setSvcRate] = useState("");
  const [svcTaxable, setSvcTaxable] = useState(false);

  const saveTax = useAdminMutation({
    mutationFn: () =>
      saveTaxFn({
        data: { tenantId, code: taxCode, name: taxName, rate: Number(taxRate || 0), inclusive },
      }),
    successMessage: "Tax rule saved",
    onSuccess: () => {
      setTaxCode("");
      setTaxName("");
      setTaxRate("");
      qc.invalidateQueries({ queryKey: ["restaurant.taxes", tenantId] });
    },
  });
  const saveSvc = useAdminMutation({
    mutationFn: () =>
      saveSvcFn({
        data: {
          tenantId,
          code: svcCode,
          name: svcName,
          rate: Number(svcRate || 0),
          taxable: svcTaxable,
        },
      }),
    successMessage: "Service charge saved",
    onSuccess: () => {
      setSvcCode("");
      setSvcName("");
      setSvcRate("");
      qc.invalidateQueries({ queryKey: ["restaurant.servicecharges", tenantId] });
    },
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="Tax rules"
        description="VAT, GST, tourism levy — inclusive or exclusive, with effective dates."
      >
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Code">
            <Input className="h-11" value={taxCode} onChange={(e) => setTaxCode(e.target.value)} />
          </Field>
          <Field label="Name">
            <Input className="h-11" value={taxName} onChange={(e) => setTaxName(e.target.value)} />
          </Field>
          <Field label="Rate %">
            <Input
              className="h-11"
              type="number"
              value={taxRate}
              onChange={(e) => setTaxRate(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Toggle label="Price includes tax" checked={inclusive} onChange={setInclusive} />
          </div>
        </div>
        <Button
          className="mt-3 h-11"
          disabled={!taxCode || !taxName || saveTax.isPending}
          onClick={() => saveTax.mutate(undefined as never)}
        >
          Save tax rule
        </Button>
        <ul className="mt-4 divide-y">
          {((taxes.data ?? []) as any[]).map((t) => (
            <Row key={t.id}>
              <span className="font-medium">
                {t.name} <span className="text-xs text-muted-foreground">({t.code})</span>
              </span>
              <span className="flex items-center gap-2 text-sm">
                {t.basis === "percent" ? `${num(t.rate)}%` : money(t.fixed_amount)}
                <StatusChip tone={t.inclusive ? "info" : "neutral"}>
                  {t.inclusive ? "inclusive" : "exclusive"}
                </StatusChip>
                <StatusChip tone={t.active ? "success" : "neutral"}>
                  {t.active ? "active" : "inactive"}
                </StatusChip>
              </span>
            </Row>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title="Service charges" description="Kept entirely separate from tax.">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Code">
            <Input className="h-11" value={svcCode} onChange={(e) => setSvcCode(e.target.value)} />
          </Field>
          <Field label="Name">
            <Input className="h-11" value={svcName} onChange={(e) => setSvcName(e.target.value)} />
          </Field>
          <Field label="Rate %">
            <Input
              className="h-11"
              type="number"
              value={svcRate}
              onChange={(e) => setSvcRate(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Toggle label="Taxable" checked={svcTaxable} onChange={setSvcTaxable} />
          </div>
        </div>
        <Button
          className="mt-3 h-11"
          disabled={!svcCode || !svcName || saveSvc.isPending}
          onClick={() => saveSvc.mutate(undefined as never)}
        >
          Save service charge
        </Button>
        <ul className="mt-4 divide-y">
          {((charges.data ?? []) as any[]).map((c) => (
            <Row key={c.id}>
              <span className="font-medium">
                {c.name} <span className="text-xs text-muted-foreground">({c.code})</span>
              </span>
              <span className="flex items-center gap-2 text-sm">
                {c.basis === "percent" ? `${num(c.rate)}%` : money(c.fixed_amount)}
                {c.taxable && <StatusChip tone="info">taxable</StatusChip>}
              </span>
            </Row>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}

/* ---------------- Discount rules ---------------- */

function DiscountsTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listRestaurantDiscountRulesFn);
  const saveFn = useServerFn(upsertRestaurantDiscountRuleFn);
  const applyFn = useServerFn(applyRestaurantDiscountFn);
  const list = useQuery({
    queryKey: ["restaurant.discounts", tenantId],
    queryFn: () => listFn({ data: { tenantId } }),
  });

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [maxPercent, setMaxPercent] = useState("20");
  const [threshold, setThreshold] = useState("10");
  const [waiterLimit, setWaiterLimit] = useState("5");
  const [managerLimit, setManagerLimit] = useState("20");

  const [orderId, setOrderId] = useState("");
  const [discountValue, setDiscountValue] = useState("");
  const [discountReason, setDiscountReason] = useState("");

  const save = useAdminMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          code,
          name,
          maxPercent: Number(maxPercent || 0),
          approvalThresholdPercent: threshold === "" ? null : Number(threshold),
          roleLimits: {
            bartender: Number(waiterLimit || 0),
            restaurant_manager: Number(managerLimit || 0),
            general_manager: 100,
            owner: 100,
          },
        },
      }),
    successMessage: "Discount rule saved",
    onSuccess: () => {
      setCode("");
      setName("");
      qc.invalidateQueries({ queryKey: ["restaurant.discounts", tenantId] });
    },
  });

  const apply = useAdminMutation({
    mutationFn: (ruleId: string) =>
      applyFn({
        data: {
          tenantId,
          orderId,
          discountRuleId: ruleId,
          scope: "order",
          basis: "percent",
          value: Number(discountValue || 0),
          reason: discountReason || undefined,
        },
      }),
    successMessage: "Discount applied",
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="New discount rule"
        description="Authority follows the restaurant roles that already exist — no separate permission system."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Code">
            <Input className="h-11" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label="Name">
            <Input className="h-11" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Maximum %">
            <Input
              className="h-11"
              type="number"
              value={maxPercent}
              onChange={(e) => setMaxPercent(e.target.value)}
            />
          </Field>
          <Field label="Approval above %">
            <Input
              className="h-11"
              type="number"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </Field>
          <Field label="Bar/floor limit %">
            <Input
              className="h-11"
              type="number"
              value={waiterLimit}
              onChange={(e) => setWaiterLimit(e.target.value)}
            />
          </Field>
          <Field label="Manager limit %">
            <Input
              className="h-11"
              type="number"
              value={managerLimit}
              onChange={(e) => setManagerLimit(e.target.value)}
            />
          </Field>
        </div>
        <Button
          className="mt-3 h-11"
          disabled={!code || !name || save.isPending}
          onClick={() => save.mutate(undefined as never)}
        >
          Save rule
        </Button>
      </SectionCard>

      <SectionCard
        title="Apply a discount"
        description="Every application records actor, reason, amount and approval state."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Order ID">
            <Input
              className="h-11"
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              placeholder="uuid"
            />
          </Field>
          <Field label="Percent">
            <Input
              className="h-11"
              type="number"
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
            />
          </Field>
          <Field label="Reason">
            <Input
              className="h-11"
              value={discountReason}
              onChange={(e) => setDiscountReason(e.target.value)}
            />
          </Field>
        </div>
        <ul className="mt-4 divide-y">
          {((list.data ?? []) as any[]).map((r) => (
            <Row key={r.id}>
              <div className="min-w-0">
                <span className="font-medium">
                  {r.name} <span className="text-xs text-muted-foreground">({r.code})</span>
                </span>
                <p className="text-xs text-muted-foreground">
                  max {num(r.max_percent)}% · approval above {r.approval_threshold_percent ?? "—"}%
                  · {r.scope}
                </p>
              </div>
              <Button
                size="sm"
                className="h-10"
                disabled={!orderId || !discountValue || apply.isPending}
                onClick={() => apply.mutate(r.id)}
              >
                Apply
              </Button>
            </Row>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}

/* ---------------- Currencies ---------------- */

function CurrenciesTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listRestaurantCurrenciesFn);
  const saveFn = useServerFn(upsertRestaurantCurrencyFn);
  const fxListFn = useServerFn(listRestaurantExchangeRatesFn);
  const fxSaveFn = useServerFn(upsertRestaurantExchangeRateFn);

  const list = useQuery({
    queryKey: ["restaurant.currencies", tenantId],
    queryFn: () => listFn({ data: { tenantId } }),
  });
  const rates = useQuery({
    queryKey: ["restaurant.fx", tenantId],
    queryFn: () => fxListFn({ data: { tenantId } }),
  });

  const [code, setCode] = useState("");
  const [symbol, setSymbol] = useState("");
  const [isBase, setIsBase] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rate, setRate] = useState("");

  const save = useAdminMutation({
    mutationFn: () => saveFn({ data: { tenantId, code, symbol, name: code, isBase } }),
    successMessage: "Currency saved",
    onSuccess: () => {
      setCode("");
      setSymbol("");
      qc.invalidateQueries({ queryKey: ["restaurant.currencies", tenantId] });
    },
  });
  const saveRate = useAdminMutation({
    mutationFn: () =>
      fxSaveFn({ data: { tenantId, baseCurrency: from, targetCurrency: to, rate: Number(rate) } }),
    successMessage: "Exchange rate recorded",
    onSuccess: () => {
      setRate("");
      qc.invalidateQueries({ queryKey: ["restaurant.fx", tenantId] });
    },
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="Currencies"
        description="One base currency per tenant; any number of selling currencies."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Code">
            <Input
              className="h-11"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Symbol">
            <Input className="h-11" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Toggle label="Base currency" checked={isBase} onChange={setIsBase} />
          </div>
        </div>
        <Button
          className="mt-3 h-11"
          disabled={!code || save.isPending}
          onClick={() => save.mutate(undefined as never)}
        >
          Save currency
        </Button>
        <ul className="mt-4 divide-y">
          {((list.data ?? []) as any[]).map((c) => (
            <Row key={c.id}>
              <span className="font-medium">
                {c.code} <span className="text-xs text-muted-foreground">{c.symbol}</span>
              </span>
              <span className="flex gap-2">
                {c.is_base && <StatusChip tone="info">base</StatusChip>}
                <StatusChip tone={c.active ? "success" : "neutral"}>
                  {c.active ? "active" : "inactive"}
                </StatusChip>
              </span>
            </Row>
          ))}
        </ul>
      </SectionCard>

      <SectionCard
        title="Exchange rates"
        description="Dated rates. Completed transactions keep the rate that applied at the time."
      >
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Base">
            <Input
              className="h-11"
              value={from}
              onChange={(e) => setFrom(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Target">
            <Input
              className="h-11"
              value={to}
              onChange={(e) => setTo(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Rate">
            <Input
              className="h-11"
              type="number"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button
              className="h-11 w-full"
              disabled={!from || !to || !rate || saveRate.isPending}
              onClick={() => saveRate.mutate(undefined as never)}
            >
              Record rate
            </Button>
          </div>
        </div>
        <ul className="mt-4 divide-y">
          {((rates.data ?? []) as any[]).map((r) => (
            <Row key={r.id}>
              <span className="font-medium">
                {r.base_currency} → {r.target_currency}
              </span>
              <span className="text-sm text-muted-foreground">
                {num(r.rate, 6)} · {new Date(r.effective_from).toLocaleDateString()} · {r.source}
              </span>
            </Row>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}

/* ---------------- Simulation ---------------- */

function SimulationTab({ tenantId }: { tenantId: string }) {
  const simulateFn = useServerFn(simulateRestaurantPricingFn);
  const [changePercent, setChangePercent] = useState("8");
  const [result, setResult] = useState<any>(null);

  const run = useAdminMutation({
    mutationFn: () => simulateFn({ data: { tenantId, changePercent: Number(changePercent || 0) } }),
    successMessage: "Simulation complete — nothing was changed",
    onSuccess: (data) => setResult(data),
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="Commercial simulation"
        description="Preview the revenue and margin consequence before committing to a price change. This never writes a price."
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Change %">
            <Input
              className="h-11 w-32"
              type="number"
              value={changePercent}
              onChange={(e) => setChangePercent(e.target.value)}
            />
          </Field>
          <Button
            className="h-11"
            disabled={run.isPending}
            onClick={() => run.mutate(undefined as never)}
          >
            Preview impact
          </Button>
        </div>
      </SectionCard>

      {result && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Affected products"
              value={num(result.totals.affectedProducts, 0)}
              tone="info"
            />
            <StatCard
              label="Current revenue"
              value={money(result.totals.currentRevenue)}
              tone="neutral"
            />
            <StatCard
              label="Projected revenue"
              value={money(result.totals.projectedRevenue)}
              tone="green"
            />
            <StatCard
              label="Gross profit delta"
              value={money(result.totals.grossProfitDelta)}
              tone={result.totals.grossProfitDelta >= 0 ? "green" : ("danger" as never)}
            />
          </div>
          <SectionCard title="Affected products" description={result.assumptions.note}>
            <ul className="divide-y">
              {(result.lines as any[]).slice(0, 50).map((l) => (
                <Row key={l.menuItemId}>
                  <div className="min-w-0">
                    <span className="font-medium">{l.name}</span>
                    <p className="text-xs text-muted-foreground">
                      cost {money(l.unitCost)} · sold {num(l.soldQuantity)} · margin{" "}
                      {num(l.currentMargin)}% → {num(l.projectedMargin)}%
                    </p>
                  </div>
                  <span className="text-sm">
                    {money(l.currentPrice)} → <b>{money(l.proposedPrice)}</b>
                  </span>
                </Row>
              ))}
            </ul>
          </SectionCard>
        </>
      )}
    </div>
  );
}

/* ---------------- Audit ---------------- */

function AuditTab({ tenantId }: { tenantId: string }) {
  const listFn = useServerFn(listRestaurantPricingAuditFn);
  const list = useQuery({
    queryKey: ["restaurant.pricing.audit", tenantId],
    queryFn: () => listFn({ data: { tenantId, limit: 100 } }),
  });
  const rows = (list.data ?? []) as any[];
  return (
    <SectionCard
      title="Audit history"
      description="Append-only. Pricing history is added to, never rewritten."
    >
      {rows.length === 0 ? (
        <EmptyState title="No pricing activity yet" />
      ) : (
        <ul className="divide-y">
          {rows.map((a) => (
            <Row key={a.id}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip tone="info">{a.entity_type}</StatusChip>
                  <span className="font-medium">{a.action}</span>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {new Date(a.created_at).toLocaleString()}
                  {a.reason ? ` · ${a.reason}` : ""}
                </p>
              </div>
            </Row>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ---------------- Small building blocks ---------------- */

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
