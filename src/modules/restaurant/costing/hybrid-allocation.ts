/**
 * LexiBite Operational Cost Intelligence — Phase 3 allocation kernel.
 *
 * Pure, deterministic domain logic only. This deliberately does not write to
 * Supabase or create a second inventory/expense ledger. P1/P2 persistence
 * adapters can call this kernel after their original contracts are restored.
 */

export type CostScope = "property" | "outlet" | "shared" | "unallocated";
export type AllocationMethod = "direct" | "approved_rule" | "activity_driver" | "manual" | "unallocated";

export interface CostSource {
  sourceId: string;
  sourceType: "operational_expense" | "operational_consumption";
  tenantId: string;
  propertyId: string | null;
  outletId: string | null;
  currency: string;
  amount: number;
  period: string;
}

export interface CostTarget {
  propertyId: string;
  outletId: string | null;
  weight: number;
}

export interface ApprovedAllocationRule {
  id: string;
  tenantId: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  approved: boolean;
  version: number;
  targets: CostTarget[];
}

export interface DriverAllocation {
  propertyId: string;
  outletId: string | null;
  units: number;
}

export interface ManualAllocation {
  propertyId: string;
  outletId: string | null;
  amount: number;
  approvedBy: string;
}

export interface CostAllocation {
  sourceId: string;
  sourceType: CostSource["sourceType"];
  tenantId: string;
  propertyId: string | null;
  outletId: string | null;
  currency: string;
  period: string;
  amount: number;
  method: AllocationMethod;
  ruleId: string | null;
  ruleVersion: number | null;
}

export interface AllocationResult {
  allocations: CostAllocation[];
  unallocatedAmount: number;
  method: AllocationMethod;
  reconciliation: {
    sourceAmount: number;
    allocatedAmount: number;
    unallocatedAmount: number;
    balanced: boolean;
  };
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationError";
  }
}

const moneyMinor = (amount: number): number => {
  if (!Number.isFinite(amount) || amount < 0) throw new AllocationError("Cost amount must be a finite non-negative number.");
  return Math.round((amount + Number.EPSILON) * 100);
};

const fromMinor = (amount: number): number => Number((amount / 100).toFixed(2));

function validateSource(source: CostSource): number {
  if (!source.sourceId || !source.tenantId) throw new AllocationError("A source ID and tenant ID are required.");
  if (!/^[A-Z]{3}$/.test(source.currency)) throw new AllocationError("Currency must be an ISO-style three-letter uppercase code.");
  if (!/^\d{4}-\d{2}$/.test(source.period)) throw new AllocationError("Period must use YYYY-MM format.");
  return moneyMinor(source.amount);
}

/** Largest-remainder apportionment guarantees exact minor-unit reconciliation. */
function apportion(totalMinor: number, targets: Array<{ propertyId: string; outletId: string | null; weight: number }>) {
  if (!targets.length) throw new AllocationError("At least one allocation target is required.");
  if (targets.some(t => !t.propertyId || !Number.isFinite(t.weight) || t.weight <= 0)) {
    throw new AllocationError("Every target requires a property and a positive finite weight.");
  }
  const totalWeight = targets.reduce((sum, target) => sum + target.weight, 0);
  const rows = targets.map((target, index) => {
    const exact = totalMinor * target.weight / totalWeight;
    const floor = Math.floor(exact);
    return { ...target, index, minor: floor, remainder: exact - floor };
  });
  let remainder = totalMinor - rows.reduce((sum, row) => sum + row.minor, 0);
  [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .slice(0, remainder).forEach(row => { row.minor += 1; });
  return rows.map(({ propertyId, outletId, minor }) => ({ propertyId, outletId, amount: fromMinor(minor) }));
}

function result(source: CostSource, sourceMinor: number, method: AllocationMethod, portions: Array<{ propertyId: string; outletId: string | null; amount: number }>, rule?: ApprovedAllocationRule): AllocationResult {
  const allocatedMinor = portions.reduce((sum, portion) => sum + moneyMinor(portion.amount), 0);
  if (allocatedMinor > sourceMinor) throw new AllocationError("Allocated cost cannot exceed its source amount.");
  const unallocatedMinor = sourceMinor - allocatedMinor;
  const allocations = portions.filter(p => moneyMinor(p.amount) > 0).map(p => ({
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    tenantId: source.tenantId,
    propertyId: p.propertyId,
    outletId: p.outletId,
    currency: source.currency,
    period: source.period,
    amount: p.amount,
    method,
    ruleId: rule?.id ?? null,
    ruleVersion: rule?.version ?? null,
  }));
  return {
    allocations,
    unallocatedAmount: fromMinor(unallocatedMinor),
    method,
    reconciliation: {
      sourceAmount: fromMinor(sourceMinor),
      allocatedAmount: fromMinor(allocatedMinor),
      unallocatedAmount: fromMinor(unallocatedMinor),
      balanced: allocatedMinor + unallocatedMinor === sourceMinor,
    },
  };
}

/**
 * Allocation precedence:
 * 1. Explicit source property/outlet attribution.
 * 2. Approved, tenant/currency/period-matched versioned rule.
 * 3. Activity-driver allocation supplied by a trusted operational projection.
 * 4. Explicitly approved manual allocation.
 * 5. Visible unallocated exception — never silently discard or guess.
 */
export function allocateOperationalCost(input: {
  source: CostSource;
  rule?: ApprovedAllocationRule | null;
  drivers?: DriverAllocation[];
  manual?: ManualAllocation[];
}): AllocationResult {
  const { source } = input;
  const sourceMinor = validateSource(source);

  if (source.propertyId) {
    return result(source, sourceMinor, "direct", [{
      propertyId: source.propertyId,
      outletId: source.outletId,
      amount: fromMinor(sourceMinor),
    }]);
  }

  const rule = input.rule;
  if (rule?.approved && rule.tenantId === source.tenantId && rule.currency === source.currency &&
      rule.effectiveFrom <= source.period && (!rule.effectiveTo || rule.effectiveTo >= source.period)) {
    const portions = apportion(sourceMinor, rule.targets);
    return result(source, sourceMinor, "approved_rule", portions, rule);
  }

  const drivers = input.drivers ?? [];
  if (drivers.length) {
    if (drivers.some(d => !Number.isFinite(d.units) || d.units <= 0 || !d.propertyId)) {
      throw new AllocationError("Activity-driver rows require a property and positive finite units.");
    }
    const portions = apportion(sourceMinor, drivers.map(d => ({ ...d, weight: d.units })));
    return result(source, sourceMinor, "activity_driver", portions);
  }

  const manual = input.manual ?? [];
  if (manual.length && manual.every(m => Boolean(m.approvedBy) && Number.isFinite(m.amount) && m.amount >= 0)) {
    const manualMinor = manual.reduce((sum, m) => sum + moneyMinor(m.amount), 0);
    if (manualMinor !== sourceMinor) throw new AllocationError("Approved manual allocations must equal the complete source amount.");
    return result(source, sourceMinor, "manual", manual.map(m => ({
      propertyId: m.propertyId, outletId: m.outletId, amount: fromMinor(moneyMinor(m.amount)),
    })));
  }

  return result(source, sourceMinor, "unallocated", []);
}

/** Batch guard against recognising the same underlying expense/consumption twice. */
export function assertUniqueCostSources(sources: CostSource[]): void {
  const seen = new Set<string>();
  for (const source of sources) {
    const key = [source.tenantId, source.sourceType, source.sourceId].join(":");
    if (seen.has(key)) throw new AllocationError(`Duplicate cost source recognition: ${source.sourceType}/${source.sourceId}.`);
    seen.add(key);
  }
}
