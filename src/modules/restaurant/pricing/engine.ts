/**
 * Deterministic commercial pricing engine (pure, browser-safe, testable).
 *
 * Given a set of candidate prices, promotions, taxes, service charges and a
 * pricing context, it produces exactly one answer plus the reason for it. No
 * database, no side effects, no reasoning: the Intelligence Core reasons, this
 * file only computes.
 */
import type { ChargeBasis, PriceScope, PromotionAction } from "./contracts";
import { add, applyRounding, money as toMoney, mul, percent as pct, sub, work } from "./decimal";
import type { RoundingMode } from "./decimal";

/**
 * Thrown when the rules cannot produce exactly one answer. Selling is blocked
 * rather than guessed: a wrong price is worse than a refused sale.
 */
export class CommercialRuleError extends Error {
  readonly code: "no_price" | "ambiguous_price";
  readonly detail: Record<string, unknown>;
  constructor(code: "no_price" | "ambiguous_price", message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommercialRuleError";
    this.code = code;
    this.detail = detail;
  }
}

export type PriceCandidate = {
  id: string;
  scope: PriceScope;
  amount: number;
  currency: string;
  taxInclusive: boolean;
  version: number;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  propertyId: string | null;
  locationId: string | null;
  productId: string | null;
  variantId: string | null;
  menuItemId: string | null;
  /** Optional membership of a named price list (corporate, happy hour…). */
  priceListId?: string | null;
  /** Optional sales-channel restriction (dine_in, takeaway, delivery…). */
  channel?: string | null;
};

/** A named, effective-dated set of prices with its own precedence. */
export type PriceListRule = {
  id: string;
  code: string;
  name: string;
  currency: string;
  channel: string | null;
  priority: number;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  propertyId: string | null;
  locationId: string | null;
};

/** A configured rounding policy for line, bill total or payment amounts. */
export type RoundingRule = {
  id: string;
  code: string;
  target: "line" | "total" | "payment";
  mode: RoundingMode;
  increment: number;
  decimals: number;
  currency: string | null;
  channel: string | null;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  propertyId: string | null;
  locationId: string | null;
};

/** A chosen modifier or option priced on top of the resolved base price. */
export type ModifierSelection = {
  id?: string | null;
  name?: string;
  priceDelta: number;
  quantity?: number;
};

export type PromotionRule = {
  id: string;
  code: string;
  name: string;
  action: PromotionAction;
  value: number;
  status: string;
  priority: number;
  stackable: boolean;
  startsAt: string;
  endsAt: string | null;
  startTime: string | null;
  endTime: string | null;
  daysOfWeek: number[];
  propertyId: string | null;
  locationId: string | null;
  products: string[];
  categories: string[];
  channels?: string[];
};

export type ChargeRule = {
  id: string;
  code: string;
  name: string;
  basis: ChargeBasis;
  rate: number;
  fixedAmount: number;
  inclusive?: boolean;
  taxable?: boolean;
  compound?: boolean;
  priority?: number;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  propertyId: string | null;
  locationId: string | null;
  products: string[];
  categories: string[];
  orderTypes?: string[];
  channels?: string[];
};

export type PricingContext = {
  at: Date;
  propertyId?: string | null;
  locationId?: string | null;
  productId?: string | null;
  variantId?: string | null;
  menuItemId?: string | null;
  categoryId?: string | null;
  orderType?: string;
  /** Sales channel: dine_in, takeaway, delivery, room_charge, event, corporate. */
  channel?: string | null;
  /** Price lists explicitly requested for this sale (e.g. a corporate account). */
  priceListIds?: string[];
  quantity: number;
};

export type PricingTrace = {
  step: string;
  detail: string;
  amount: number;
};

export type PricingQuote = {
  currency: string;
  basePrice: number;
  priceId: string | null;
  priceSource: string;
  priceListId: string | null;
  channel: string | null;
  unitPrice: number;
  modifierTotal: number;
  promotionId: string | null;
  promotionDiscount: number;
  lineNet: number;
  serviceCharge: number;
  serviceChargeId: string | null;
  taxTotal: number;
  taxRuleId: string | null;
  taxRate: number;
  taxInclusive: boolean;
  roundingAdjustment: number;
  lineTotal: number;
  trace: PricingTrace[];
};

const round = (n: number, dp = 4) => (dp === 4 ? work(n) : toMoney(n, dp));
const money = (n: number, dp = 2) => toMoney(n, dp);

function withinDates(from: string, to: string | null, at: Date): boolean {
  if (new Date(from).getTime() > at.getTime()) return false;
  if (to && new Date(to).getTime() < at.getTime()) return false;
  return true;
}

function withinScope(
  propertyId: string | null,
  locationId: string | null,
  ctx: PricingContext,
): boolean {
  if (locationId && locationId !== (ctx.locationId ?? null)) return false;
  if (propertyId && propertyId !== (ctx.propertyId ?? null)) return false;
  return true;
}

function targets(products: string[], categories: string[], ctx: PricingContext): boolean {
  if (products.length === 0 && categories.length === 0) return true;
  if (ctx.productId && products.includes(ctx.productId)) return true;
  if (ctx.menuItemId && products.includes(ctx.menuItemId)) return true;
  if (ctx.categoryId && categories.includes(ctx.categoryId)) return true;
  return false;
}

/** A rule with no channel list applies everywhere; otherwise it must match. */
function channelMatches(channels: string[] | undefined, ctx: PricingContext): boolean {
  if (!channels || channels.length === 0) return true;
  return channels.includes(ctx.channel ?? ctx.orderType ?? "dine_in");
}

const activeChannel = (ctx: PricingContext) => ctx.channel ?? ctx.orderType ?? "dine_in";

const SCOPE_WEIGHT: Record<PriceScope, number> = { tenant: 0, property: 1, location: 2 };

/**
 * The price lists in force for this context, most specific first. A list is
 * eligible when it is active, dated in, in scope, matches the channel, and is
 * either global (no channel) or explicitly requested for the sale.
 */
export function eligiblePriceLists(lists: PriceListRule[], ctx: PricingContext): PriceListRule[] {
  const requested = new Set(ctx.priceListIds ?? []);
  return lists
    .filter(
      (l) =>
        l.status === "active" &&
        withinDates(l.effectiveFrom, l.effectiveTo, ctx.at) &&
        withinScope(l.propertyId, l.locationId, ctx) &&
        (!l.channel || l.channel === activeChannel(ctx)) &&
        (requested.size === 0 || requested.has(l.id) || !l.channel),
    )
    .sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
}

/**
 * Precedence, highest first:
 *   outlet scope → channel-specific → price list (by list priority) →
 *   variant-specific → latest effective date → highest version.
 */
function candidateRank(
  c: PriceCandidate,
  ctx: PricingContext,
  listRank: Map<string, number>,
): number[] {
  const listPriority = c.priceListId ? (listRank.get(c.priceListId) ?? 9_999) : 10_000;
  return [
    SCOPE_WEIGHT[c.scope],
    c.channel && c.channel === activeChannel(ctx) ? 1 : 0,
    -listPriority,
    c.variantId ? 1 : 0,
    new Date(c.effectiveFrom).getTime(),
    c.version,
  ];
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Hierarchy: tenant default → property override → outlet override, then
 * channel, then price list. The most specific applicable, effective, active
 * price wins; ties break on the latest effective date, then highest version.
 * A genuine tie on every dimension is an ambiguity, not a coin toss.
 */
export function resolveBasePrice(
  candidates: PriceCandidate[],
  ctx: PricingContext,
  lists: PriceListRule[] = [],
): PriceCandidate | null {
  const eligibleLists = eligiblePriceLists(lists, ctx);
  const listRank = new Map(eligibleLists.map((l, i) => [l.id, l.priority * 100 + i]));
  const eligible = candidates.filter(
    (c) =>
      c.status === "active" &&
      withinDates(c.effectiveFrom, c.effectiveTo, ctx.at) &&
      withinScope(c.propertyId, c.locationId, ctx) &&
      (!c.channel || c.channel === activeChannel(ctx)) &&
      (!c.priceListId || listRank.has(c.priceListId)) &&
      (ctx.variantId ? c.variantId === ctx.variantId || c.variantId === null : true),
  );
  if (eligible.length === 0) return null;
  const ranked = eligible
    .map((c) => ({ c, rank: candidateRank(c, ctx, listRank) }))
    .sort((a, b) => compareRank(a.rank, b.rank));
  const winner = ranked[0];
  const runnerUp = ranked[1];
  if (
    winner &&
    runnerUp &&
    compareRank(winner.rank, runnerUp.rank) === 0 &&
    runnerUp.c.amount !== winner.c.amount
  ) {
    throw new CommercialRuleError(
      "ambiguous_price",
      "Two different prices are equally valid for this item. Resolve the overlap in Pricing before selling it.",
      { priceIds: [winner.c.id, runnerUp.c.id], amounts: [winner.c.amount, runnerUp.c.amount] },
    );
  }
  return winner?.c ?? null;
}

function timeWithin(start: string | null, end: string | null, at: Date): boolean {
  if (!start || !end) return true;
  const mins = at.getHours() * 60 + at.getMinutes();
  const toMin = (t: string) => {
    const [h = "0", m = "0"] = t.split(":");
    return Number(h) * 60 + Number(m);
  };
  const s = toMin(start);
  const e = toMin(end);
  // A window that crosses midnight (e.g. 22:00 → 02:00) stays contiguous.
  return s <= e ? mins >= s && mins <= e : mins >= s || mins <= e;
}

export function applicablePromotions(
  promotions: PromotionRule[],
  ctx: PricingContext,
): PromotionRule[] {
  return promotions
    .filter(
      (p) =>
        p.status === "active" &&
        withinDates(p.startsAt, p.endsAt, ctx.at) &&
        withinScope(p.propertyId, p.locationId, ctx) &&
        channelMatches(p.channels, ctx) &&
        (p.daysOfWeek.length === 0 || p.daysOfWeek.includes(ctx.at.getDay())) &&
        timeWithin(p.startTime, p.endTime, ctx.at) &&
        targets(p.products, p.categories, ctx),
    )
    .sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
}

export function applyPromotion(unitPrice: number, promo: PromotionRule): number {
  switch (promo.action) {
    case "percent_discount":
      return round(sub(unitPrice, pct(unitPrice, promo.value)));
    case "fixed_discount":
      return round(Math.max(0, sub(unitPrice, promo.value)));
    case "price_override":
      return round(promo.value);
    case "percent_uplift":
      return round(add(unitPrice, pct(unitPrice, promo.value)));
    default:
      return unitPrice;
  }
}

export function applicableCharges(rules: ChargeRule[], ctx: PricingContext): ChargeRule[] {
  return rules
    .filter(
      (r) =>
        r.active &&
        withinDates(r.effectiveFrom, r.effectiveTo, ctx.at) &&
        withinScope(r.propertyId, r.locationId, ctx) &&
        targets(r.products, r.categories, ctx) &&
        channelMatches(r.channels, ctx) &&
        (!r.orderTypes ||
          r.orderTypes.length === 0 ||
          r.orderTypes.includes(ctx.orderType ?? "dine_in")),
    )
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.code.localeCompare(b.code));
}

function chargeAmount(rule: ChargeRule, base: number, quantity: number): number {
  return rule.basis === "percent" ? round(pct(base, rule.rate)) : round(mul(rule.fixedAmount, quantity));
}

/** The rounding policy in force for a target, or a plain 2-decimal default. */
export function resolveRounding(
  rules: RoundingRule[],
  target: "line" | "total" | "payment",
  ctx: PricingContext,
  currency?: string,
): RoundingRule | null {
  return (
    rules
      .filter(
        (r) =>
          r.active &&
          r.target === target &&
          withinDates(r.effectiveFrom, r.effectiveTo, ctx.at) &&
          withinScope(r.propertyId, r.locationId, ctx) &&
          (!r.channel || r.channel === activeChannel(ctx)) &&
          (!r.currency || !currency || r.currency === currency),
      )
      .sort(
        (a, b) =>
          SCOPE_WEIGHT[b.locationId ? "location" : b.propertyId ? "property" : "tenant"] -
          SCOPE_WEIGHT[a.locationId ? "location" : a.propertyId ? "property" : "tenant"],
      )[0] ?? null
  );
}

/**
 * Tax on an exclusive line is added on top; on an inclusive line it is
 * extracted from the amount the customer already pays.
 */
export function computeTax(
  rules: ChargeRule[],
  base: number,
  quantity: number,
  inclusive: boolean,
): { total: number; rate: number; ruleId: string | null; net: number } {
  if (rules.length === 0) return { total: 0, rate: 0, ruleId: null, net: round(base) };
  const percentRate = rules.filter((r) => r.basis === "percent").reduce((s, r) => s + r.rate, 0);
  const fixed = rules
    .filter((r) => r.basis === "fixed")
    .reduce((s, r) => add(s, mul(r.fixedAmount, quantity)), 0);
  if (inclusive) {
    const net = round(sub(base, fixed) / (1 + percentRate / 100));
    return { total: round(sub(base, net)), rate: percentRate, ruleId: rules[0]?.id ?? null, net };
  }
  return {
    total: round(add(pct(base, percentRate), fixed)),
    rate: percentRate,
    ruleId: rules[0]?.id ?? null,
    net: round(base),
  };
}

/** The single, explainable answer for one order line. */
export function quoteLine(args: {
  ctx: PricingContext;
  prices: PriceCandidate[];
  promotions: PromotionRule[];
  taxes: ChargeRule[];
  serviceCharges: ChargeRule[];
  priceLists?: PriceListRule[];
  roundingRules?: RoundingRule[];
  modifiers?: ModifierSelection[];
  fallbackUnitPrice?: number;
  fallbackCurrency?: string;
  lineDiscount?: number;
  /** When true, a missing configured price throws instead of falling back. */
  strict?: boolean;
}): PricingQuote {
  const { ctx, prices, promotions, taxes, serviceCharges } = args;
  const trace: PricingTrace[] = [];

  const base = resolveBasePrice(prices, ctx, args.priceLists ?? []);
  if (!base && (args.strict || !(args.fallbackUnitPrice && args.fallbackUnitPrice > 0))) {
    throw new CommercialRuleError(
      "no_price",
      "No active price is configured for this item in this outlet and channel.",
      { menuItemId: ctx.menuItemId, productId: ctx.productId, channel: activeChannel(ctx) },
    );
  }
  const currency = base?.currency ?? args.fallbackCurrency ?? "USD";
  const basePrice = base ? base.amount : (args.fallbackUnitPrice ?? 0);
  trace.push({
    step: "base_price",
    detail: base ? `${base.scope} price v${base.version}` : "no configured price — fallback used",
    amount: basePrice,
  });

  let unitPrice = basePrice;
  let promotionId: string | null = null;
  for (const promo of applicablePromotions(promotions, ctx)) {
    const next = applyPromotion(unitPrice, promo);
    trace.push({
      step: "promotion",
      detail: `${promo.name} (${promo.action} ${promo.value})`,
      amount: next,
    });
    unitPrice = next;
    promotionId = promo.id;
    if (!promo.stackable) break;
  }

  // Modifiers are a net addition on top of the resolved price. They sit after
  // promotions on purpose: a "20% off pizza" must not silently discount the
  // extra cheese the guest chose.
  const modifierPerUnit = (args.modifiers ?? []).reduce(
    (s, m) => add(s, mul(Number(m.priceDelta ?? 0), Number(m.quantity ?? 1))),
    0,
  );
  const modifierTotal = round(mul(modifierPerUnit, ctx.quantity));
  if (modifierTotal !== 0)
    trace.push({ step: "modifiers", detail: `${args.modifiers?.length ?? 0} selected`, amount: modifierTotal });

  const gross = round(add(mul(unitPrice, ctx.quantity), modifierTotal));
  const discount = round(Math.min(args.lineDiscount ?? 0, gross));
  const afterDiscount = round(sub(gross, discount));
  if (discount > 0) trace.push({ step: "discount", detail: "line discount", amount: -discount });

  const svcRules = applicableCharges(serviceCharges, ctx);
  const svc = svcRules.reduce((s, r) => add(s, chargeAmount(r, afterDiscount, ctx.quantity)), 0);
  if (svc > 0)
    trace.push({
      step: "service_charge",
      detail: svcRules.map((r) => r.code).join(", "),
      amount: svc,
    });

  const taxRules = applicableCharges(taxes, ctx);
  const inclusive = base?.taxInclusive ?? taxRules.some((r) => r.inclusive);
  const taxableBase =
    add(
      afterDiscount,
      svcRules
        .filter((r) => r.taxable)
        .reduce((s, r) => add(s, chargeAmount(r, afterDiscount, ctx.quantity)), 0),
    );
  const tax = computeTax(taxRules, taxableBase, ctx.quantity, inclusive);
  if (tax.total > 0) {
    trace.push({
      step: "tax",
      detail: `${taxRules.map((r) => r.code).join(", ")} ${inclusive ? "(inclusive)" : "(exclusive)"}`,
      amount: tax.total,
    });
  }

  const rawTotal = inclusive ? add(afterDiscount, svc) : add(afterDiscount, svc, tax.total);
  const rounding = resolveRounding(args.roundingRules ?? [], "line", ctx, currency);
  const lineTotal = rounding
    ? applyRounding(rawTotal, rounding)
    : money(rawTotal);
  const roundingAdjustment = round(sub(lineTotal, money(rawTotal)));
  if (roundingAdjustment !== 0)
    trace.push({ step: "rounding", detail: rounding?.code ?? "default", amount: roundingAdjustment });
  trace.push({ step: "line_total", detail: currency, amount: lineTotal });

  return {
    currency,
    basePrice: round(basePrice),
    priceId: base?.id ?? null,
    priceSource: base ? base.scope : "fallback",
    priceListId: base?.priceListId ?? null,
    channel: activeChannel(ctx),
    unitPrice: round(unitPrice),
    modifierTotal,
    promotionId,
    promotionDiscount: round(mul(Math.max(0, sub(basePrice, unitPrice)), ctx.quantity)),
    lineNet: inclusive ? tax.net : afterDiscount,
    serviceCharge: money(svc),
    serviceChargeId: svcRules[0]?.id ?? null,
    taxTotal: money(tax.total),
    taxRuleId: tax.ruleId,
    taxRate: tax.rate,
    taxInclusive: inclusive,
    roundingAdjustment,
    lineTotal,
    trace,
  };
}

/* ---------------- Discount governance ---------------- */

export type DiscountGovernanceRule = {
  maxPercent: number;
  roleLimits: Record<string, number>;
  approvalThresholdPercent: number | null;
  requiresReason: boolean;
};

/** The highest percentage these roles may grant without an exception. */
export function discountCeiling(rule: DiscountGovernanceRule, roles: readonly string[]): number {
  const limits = roles
    .map((r) => rule.roleLimits[r])
    .filter((v): v is number => typeof v === "number");
  const roleCeiling = limits.length > 0 ? Math.max(...limits) : rule.maxPercent;
  return Math.min(rule.maxPercent, roleCeiling);
}

export function evaluateDiscount(args: {
  rule: DiscountGovernanceRule;
  roles: readonly string[];
  basis: ChargeBasis;
  value: number;
  lineBase: number;
  reason?: string | null;
  platformAdmin?: boolean;
}): {
  allowed: boolean;
  requiresApproval: boolean;
  percent: number;
  amount: number;
  message?: string;
} {
  const percent =
    args.basis === "percent"
      ? args.value
      : args.lineBase > 0
        ? (args.value / args.lineBase) * 100
        : 100;
  const amount =
    args.basis === "percent" ? round(args.lineBase * (args.value / 100)) : round(args.value);
  const ceiling = discountCeiling(args.rule, args.roles);
  if (args.rule.requiresReason && !args.reason?.trim()) {
    return {
      allowed: false,
      requiresApproval: false,
      percent,
      amount,
      message: "A reason is required for this discount.",
    };
  }
  if (!args.platformAdmin && percent > ceiling) {
    return {
      allowed: false,
      requiresApproval: true,
      percent,
      amount,
      message: `Your role may grant up to ${ceiling}% — ${percent.toFixed(1)}% needs approval.`,
    };
  }
  const threshold = args.rule.approvalThresholdPercent;
  return {
    allowed: true,
    requiresApproval: threshold !== null && threshold !== undefined && percent > threshold,
    percent,
    amount,
  };
}

/* ---------------- Currency ---------------- */

export type FxRate = {
  baseCurrency: string;
  targetCurrency: string;
  rate: number;
  effectiveFrom: string;
};

/** The rate in force at `at`. Historical transactions keep the rate they stored. */
export function resolveFxRate(
  rates: FxRate[],
  base: string,
  target: string,
  at: Date,
): number | null {
  if (base === target) return 1;
  const direct = rates
    .filter(
      (r) =>
        r.baseCurrency === base && r.targetCurrency === target && new Date(r.effectiveFrom) <= at,
    )
    .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())[0];
  if (direct) return direct.rate;
  const inverse = rates
    .filter(
      (r) =>
        r.baseCurrency === target && r.targetCurrency === base && new Date(r.effectiveFrom) <= at,
    )
    .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())[0];
  return inverse && inverse.rate !== 0 ? round(1 / inverse.rate, 8) : null;
}

export function convert(amount: number, rate: number, decimals = 2): number {
  return Number((amount * rate).toFixed(decimals));
}
