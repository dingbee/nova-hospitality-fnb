# Phase 3 — Hybrid Cost Allocation Engine

## Scope and architecture

Phase 3 adds deterministic hybrid allocation for operational expenses and operational consumption while preserving the existing restaurant stock-movement ledger as the authoritative consumption source. It does not introduce a second stock, recipe-cost, or accounting ledger.

The implementation is staged on `feat/operational-cost-intelligence-phase3-workaround`. It is not merged or deployed.

## Allocation precedence

1. Direct source property/location attribution.
2. Approved, effective-dated, tenant- and currency-matched versioned allocation rule.
3. Activity-driver allocation from persisted operational units.
4. Explicitly approved manual allocation.
5. Visible unallocated exception.

Draft, expired, cross-tenant, wrong-currency, or inapplicable rules must not be applied. Monetary allocation uses integer minor units and deterministic largest-remainder apportionment. Allocations plus any unallocated exception must reconcile exactly to the source amount. Rule-derived allocations retain rule ID and version. Duplicate source recognition is guarded by tenant, source type, and source ID.

## Implemented in this branch

- Pure allocation kernel and focused unit tests.
- Migration `0040_operational_cost_intelligence.sql` defining tenant-scoped operational expense categories, expenses, payments, recurring schedules/occurrences, allocation rules, allocations, exceptions, and activity drivers.
- Database functions for expense allocation, recurring expense generation, and stock-consumption allocation.
- Payment-status trigger and database-side checks for overpayment, approval, tenant/property scope, allocation method, rule validity, and reconciliation.
- Activity-driver server functions and capture/list UI in the restaurant costing route.
- Expense lifecycle UI and authenticated server actions: category creation, expense capture/listing, independent approval, payment recording, and direct property allocation.
- Shared-expense allocation-rule lifecycle: versioned draft creation, tenant/property validation, independent approval, effective-date/currency checks, deterministic minor-unit apportionment, and rule-backed allocation from the costing workspace.
- Consumption-allocation server function.
- Profitability aggregation includes allocated operating expenses, contribution profit, and contribution margin while retaining food-cost metrics separately.
- Isolated PostgreSQL verification fixture covering payment lifecycle, allocation, recurring idempotency, approved-rule allocation, consumption attribution, activity-driver distribution, RLS isolation, and rollback.
- Focused CI workflow covering allocation unit tests and the isolated PostgreSQL fixture.

## Verified evidence

On commit `8ba004960caa68b842b8c4e047589939c53944a8`:
- Production build completed successfully, including the new shared-rule UI and server functions.
- The dedicated Phase 3 workflow completed successfully, including allocation unit tests and the isolated PostgreSQL migration/expense lifecycle/RLS fixture.
- The full repository typecheck reports pre-existing errors in events, inventory-agent, inventory UI, masterdata, staffnova, router, and order-table modules. The latest typecheck reports no errors in Phase 3 costing server/functions or the costing route. Repository-wide lint and full-suite steps remain gated by those unrelated typecheck errors.

The UAT Tenant A transaction checks previously exercised expense payment state transitions, direct allocation, approved 60/40 allocation, recurring generation idempotency, direct consumption attribution, and activity-driver allocation. Those checks were rolled back; no permanent UAT business data or production migration was applied.

## Acceptance disposition

- Expense capture, categories, independent approval, payment recording, and direct property allocation are wired into the costing workspace.
- Shared expense rules support draft/version creation, two-or-more weighted targets, independent approval, effective dates, currency matching, deterministic largest-remainder allocation, and rule-version traceability.
- Rule/expense writes are tenant-scoped and require costing capability; target properties and locations are independently authorized.
- Migration verification and focused allocation tests pass in isolated PostgreSQL/CI.
- Production build passes.
- No production migration, business data write, merge, or deployment was performed.

## Remaining release boundary

The implementation branch is ready for review, but repository-wide release certification remains blocked by pre-existing TypeScript errors outside Phase 3. Those errors must be resolved in their owning workstreams before the repository-wide CI gate can be green. Phase 3 must not bypass that gate or be represented as fully repository-certified.
## Current disposition

Phase 3 implementation scope is complete on the isolated branch. Focused Phase 3 verification and production build pass. Repository-wide CI certification is pending unrelated baseline type errors; the branch remains unmerged and undeployed.