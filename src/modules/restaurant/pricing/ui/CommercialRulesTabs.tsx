/**
 * Sprint 5.8 — commercial rule surfaces that were previously only reachable
 * through the database: price lists, rounding policies, and an explainable
 * "why is it this price?" preview.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { SALES_CHANNELS } from "../contracts";
import {
  listRestaurantPriceListsFn,
  listRestaurantRoundingRulesFn,
  resolveRestaurantPriceFn,
  upsertRestaurantPriceListFn,
  upsertRestaurantRoundingRuleFn,
} from "../pricing.functions";

const num = (n: unknown, dp = 2) =>
  Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: dp });

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function ChannelSelect({
  value,
  onChange,
  allowAny = true,
}: {
  value: string;
  onChange: (v: string) => void;
  allowAny?: boolean;
}) {
  return (
    <select
      className="h-11 w-full rounded border border-border bg-background px-3 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {allowAny && <option value="">Every channel</option>}
      {SALES_CHANNELS.map((c) => (
        <option key={c} value={c}>
          {c.replace(/_/g, " ")}
        </option>
      ))}
    </select>
  );
}

/* ---------------- Price lists ---------------- */

export function PriceListsTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listRestaurantPriceListsFn);
  const saveFn = useServerFn(upsertRestaurantPriceListFn);

  const lists = useQuery({
    queryKey: ["restaurant.priceLists", tenantId],
    queryFn: () => listFn({ data: { tenantId } }),
  });

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("TZS");
  const [channel, setChannel] = useState("");
  const [priority, setPriority] = useState("100");
  const [status, setStatus] = useState<"draft" | "active" | "archived">("draft");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");

  const save = useAdminMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          code: code.trim().toUpperCase(),
          name: name.trim(),
          currency,
          channel: channel ? (channel as never) : null,
          priority: Number(priority) || 100,
          status,
          effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : undefined,
          effectiveTo: effectiveTo ? new Date(effectiveTo).toISOString() : null,
        },
      }),
    successMessage: "Price list saved",
    onSuccess: () => {
      setCode("");
      setName("");
      qc.invalidateQueries({ queryKey: ["restaurant.priceLists", tenantId] });
    },
  });

  const rows = (lists.data ?? []) as any[];

  return (
    <div className="space-y-4">
      <SectionCard
        title="New price list"
        description="A price list groups prices for an audience or moment — Standard, Corporate, Happy Hour, Staff. Items are never duplicated; a product simply carries an extra price row pointing at the list."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Code">
            <Input
              className="h-11"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="HAPPY_HOUR"
            />
          </Field>
          <Field label="Name">
            <Input
              className="h-11"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Happy hour"
            />
          </Field>
          <Field label="Currency">
            <Input
              className="h-11"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Channel">
            <ChannelSelect value={channel} onChange={setChannel} />
          </Field>
          <Field label="Priority (lower wins)">
            <Input
              className="h-11"
              type="number"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </Field>
          <Field label="Status">
            <select
              className="h-11 w-full rounded border border-border bg-background px-3 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value as never)}
            >
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
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
          <Field label="Effective to">
            <Input
              className="h-11"
              type="datetime-local"
              value={effectiveTo}
              onChange={(e) => setEffectiveTo(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-3">
          <Button
            className="h-11"
            disabled={!code.trim() || !name.trim() || save.isPending}
            onClick={() => save.mutate(undefined as never)}
          >
            Save price list
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Price lists" description="Ordered by the precedence they carry.">
        {rows.length === 0 ? (
          <EmptyState
            title="No price lists yet"
            description="Everything currently sells at the standard price."
          />
        ) : (
          <ul className="divide-y">
            {rows.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{l.name}</span>
                    <StatusChip tone={l.status === "active" ? "success" : "neutral"}>
                      {l.status}
                    </StatusChip>
                    <StatusChip tone="info">{l.code}</StatusChip>
                    {l.channel && <StatusChip tone="neutral">{l.channel}</StatusChip>}
                    {l.is_default && <StatusChip tone="warning">default</StatusChip>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {l.currency} · priority {l.priority} ·{" "}
                    {new Date(l.effective_from).toLocaleDateString()}
                    {l.effective_to ? ` → ${new Date(l.effective_to).toLocaleDateString()}` : " → open"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <ResolutionPreview tenantId={tenantId} />
    </div>
  );
}

/* ---------------- Rounding ---------------- */

export function RoundingTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listRestaurantRoundingRulesFn);
  const saveFn = useServerFn(upsertRestaurantRoundingRuleFn);

  const rules = useQuery({
    queryKey: ["restaurant.rounding", tenantId],
    queryFn: () => listFn({ data: { tenantId } }),
  });

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [target, setTarget] = useState<"line" | "total" | "payment">("total");
  const [mode, setMode] = useState<"none" | "nearest" | "up" | "down">("nearest");
  const [increment, setIncrement] = useState("100");
  const [decimals, setDecimals] = useState("0");
  const [channel, setChannel] = useState("");

  const save = useAdminMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          code: code.trim().toUpperCase(),
          name: name.trim(),
          target,
          mode,
          increment: Number(increment) || 0,
          decimals: Number(decimals) || 0,
          channel: channel ? (channel as never) : null,
          active: true,
        },
      }),
    successMessage: "Rounding policy saved",
    onSuccess: () => {
      setCode("");
      setName("");
      qc.invalidateQueries({ queryKey: ["restaurant.rounding", tenantId] });
    },
  });

  const rows = (rules.data ?? []) as any[];

  return (
    <div className="space-y-4">
      <SectionCard
        title="New rounding policy"
        description="Rounding is a rule, not a habit. Set it once here and every line, bill and payment rounds the same way — and the adjustment is recorded, never hidden."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Code">
            <Input
              className="h-11"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="TZS_100"
            />
          </Field>
          <Field label="Name">
            <Input
              className="h-11"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nearest 100 TZS"
            />
          </Field>
          <Field label="Applies to">
            <select
              className="h-11 w-full rounded border border-border bg-background px-3 text-sm"
              value={target}
              onChange={(e) => setTarget(e.target.value as never)}
            >
              <option value="line">Each line</option>
              <option value="total">Bill total</option>
              <option value="payment">Payment / cash</option>
            </select>
          </Field>
          <Field label="Mode">
            <select
              className="h-11 w-full rounded border border-border bg-background px-3 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value as never)}
            >
              <option value="nearest">Nearest</option>
              <option value="up">Always up</option>
              <option value="down">Always down</option>
              <option value="none">No rounding</option>
            </select>
          </Field>
          <Field label="Increment">
            <Input
              className="h-11"
              type="number"
              inputMode="decimal"
              value={increment}
              onChange={(e) => setIncrement(e.target.value)}
            />
          </Field>
          <Field label="Decimals">
            <Input
              className="h-11"
              type="number"
              value={decimals}
              onChange={(e) => setDecimals(e.target.value)}
            />
          </Field>
          <Field label="Channel">
            <ChannelSelect value={channel} onChange={setChannel} />
          </Field>
        </div>
        <div className="mt-3">
          <Button
            className="h-11"
            disabled={!code.trim() || !name.trim() || save.isPending}
            onClick={() => save.mutate(undefined as never)}
          >
            Save policy
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Rounding policies">
        {rows.length === 0 ? (
          <EmptyState
            title="No rounding policies"
            description="Amounts are kept at two decimals with standard rounding."
          />
        ) : (
          <ul className="divide-y">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <StatusChip tone={r.active ? "success" : "neutral"}>{r.target}</StatusChip>
                    <StatusChip tone="info">{r.mode}</StatusChip>
                    {r.channel && <StatusChip tone="neutral">{r.channel}</StatusChip>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    increment {num(r.increment, 4)} · {r.decimals} decimals
                    {r.currency ? ` · ${r.currency}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/* ---------------- Explainable resolution ---------------- */

export function ResolutionPreview({ tenantId }: { tenantId: string }) {
  const resolveFn = useServerFn(resolveRestaurantPriceFn);
  const [menuItemId, setMenuItemId] = useState("");
  const [channel, setChannel] = useState("dine_in");
  const [quantity, setQuantity] = useState("1");
  const [result, setResult] = useState<any>(null);

  const run = useAdminMutation({
    mutationFn: () =>
      resolveFn({
        data: {
          tenantId,
          menuItemId: menuItemId || undefined,
          channel: channel as never,
          orderType: channel,
          quantity: Number(quantity) || 1,
        },
      }),
    successMessage: "Price resolved",
    onSuccess: (data: unknown) => setResult(data),
  });

  const quote = result?.quote;

  return (
    <SectionCard
      title="Why is it this price?"
      description="Resolve one item exactly the way the till would, and read back every step that produced the number."
    >
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Menu item ID">
          <Input
            className="h-11"
            value={menuItemId}
            onChange={(e) => setMenuItemId(e.target.value)}
            placeholder="uuid"
          />
        </Field>
        <Field label="Channel">
          <ChannelSelect value={channel} onChange={setChannel} allowAny={false} />
        </Field>
        <Field label="Quantity">
          <Input
            className="h-11"
            type="number"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
        <div className="flex items-end">
          <Button
            className="h-11 w-full"
            disabled={!menuItemId || run.isPending}
            onClick={() => run.mutate(undefined as never)}
          >
            Resolve
          </Button>
        </div>
      </div>

      {quote && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone="info">{quote.priceSource}</StatusChip>
            {quote.priceListId && <StatusChip tone="warning">price list</StatusChip>}
            <StatusChip tone="neutral">{quote.channel}</StatusChip>
            {quote.taxInclusive && <StatusChip tone="neutral">tax inclusive</StatusChip>}
          </div>
          <ol className="divide-y rounded border">
            {(quote.trace ?? []).map((t: any, i: number) => (
              <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="text-muted-foreground">
                  {t.step.replace(/_/g, " ")} — {t.detail}
                </span>
                <span className="font-medium tabular-nums">{num(t.amount)}</span>
              </li>
            ))}
          </ol>
          <p className="text-sm">
            <span className="text-muted-foreground">Line total: </span>
            <span className="font-semibold tabular-nums">
              {quote.currency} {num(quote.lineTotal)}
            </span>
            {quote.roundingAdjustment !== 0 && (
              <span className="text-muted-foreground">
                {" "}
                (rounding {num(quote.roundingAdjustment)})
              </span>
            )}
          </p>
        </div>
      )}
    </SectionCard>
  );
}
