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
- Consumption-allocation server function.
- Profitability aggregation includes allocated operating expenses, contribution profit, and contribution margin while retaining food-cost metrics separately.
- Isolated PostgreSQL verification fixture covering payment lifecycle, allocation, recurring idempotency, approved-rule allocation, consumption attribution, activity-driver distribution, RLS isolation, and rollback.
- Focused CI workflow covering allocation unit tests and the isolated PostgreSQL fixture.

## Verified evidence

On commit `467811e3c527b81de452ac85831fc8f465e67cc8`:
- Production build completed.
- The dedicated Phase 3 workflow completed successfully, including focused unit tests and the isolated PostgreSQL migration/verification fixture.
- The full repository CI typecheck failed on existing errors in events, inventory-agent, masterdata, staffnova, router, and order-table modules. No reported TypeScript error was in the Phase 3 costing files. Lint and later full-suite steps were skipped after typecheck failed.

The UAT Tenant A transaction checks previously exercised expense payment state transitions, direct allocation, approved 60/40 allocation, recurring generation idempotency, direct consumption attribution, and activity-driver allocation. Those checks were rolled back; no permanent UAT business data or production migration was applied.

## Remaining closure gates

1. Complete the application expense lifecycle experience: create/list expenses, submit/approve, record payments, and initiate/review allocations. The current UI addition captures activity drivers; it is not a complete expense-management interface.
2. Add focused server/UI tests for those workflows and enforce separation of duties using the actual role contracts.
3. Extend database verification for concurrency, immutable rule versions, exception resolution, and negative authorization cases.
4. Re-run focused Phase 3 CI and the relevant changed-path tests after the application work.
5. Re-run and record the full repository CI baseline. The unrelated repository type errors remain separately tracked; do not misrepresent the full CI as green.
6. Repeat UAT Tenant A verification in rollback-only transactions. No production migration, merge, or deployment is authorized by this phase work.

## Current disposition

Implementation is materially advanced but Phase 3 is **not closed**. The allocation kernel, database fixture, and profitability integration have passing focused evidence. The expense lifecycle UI, expanded security/concurrency acceptance, and final CI evidence remain open.