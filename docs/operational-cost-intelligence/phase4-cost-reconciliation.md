# Phase 4 — Cost Reconciliation and Variance Intelligence

Phase 4 creates immutable reconciliation runs and investigation cases over the existing expense, procurement, sales and inventory ledgers. Source ledgers remain authoritative; reconciliation is read-only against them.

## Implemented comparisons

- **Operating expense allocation:** approved property expenses against their posted allocation rows, with exact source currency and allocation-period matching.
- **Operating expense budget:** approved expense totals against an approved category budget for the exact property, category, period and currency. Budgets are explicit baselines entered by an authorised manager; no budget is inferred.
- **Purchase price:** posted goods-receipt accepted quantities multiplied by ordered unit cost versus received unit cost. Only identical stock units and matching receipt/header currencies are compared.
- **Recipe consumption cost:** sale-time theoretical-cost snapshots on closed recipe-linked order lines versus the actual cost of stock-consumption movements linked by order-item ID. Currency mismatches and missing theoretical-cost snapshots are excluded.
- **Variance thresholds:** enabled property/currency thresholds are applied before deterministic case severity is assigned.

## Integrity and controls

- Additive migrations 0042 and 0043; source inventory, procurement, order and expense rows are never updated by reconciliation.
- Tenant/property-scoped RLS on run, line, case, evidence, threshold and approved-budget records.
- Minor-unit monetary arithmetic, currency matching, source fingerprints and idempotent run/line creation.
- Every variance case retains source evidence, an initial detection event and an auditable status-change history.
- Reruns create new immutable run snapshots when source facts change; identical source fingerprints reuse the existing run.
- Budget comparisons are overspend-only. Unconfigured budgets are not treated as zero.
- Purchase-price comparisons require a recorded ordered price and accepted quantity; mismatched or missing units are excluded rather than converted speculatively.
- Recipe consumption comparisons use the pinned recipe cost snapshot captured at sale and linked append-only stock movements; order lines without recipe snapshots are outside this comparison.

## Acceptance

Dedicated PostgreSQL migration/RLS verification and engine tests must pass, followed by full repository CI on the same commit. No production migration, merge or deployment is authorised by this implementation work.
