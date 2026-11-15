# Phase 3 — Hybrid Cost Allocation Engine

## Scope and architecture

Phase 3 adds deterministic hybrid allocation for operational expenses and operational consumption while preserving the existing restaurant stock-movement ledger as the authoritative consumption source. It does not introduce a second stock, recipe-cost, or accounting ledger.

**Implementation status: merged to `main` and repository CI certified. Production rollout remains separate and has not been performed.**

## Allocation precedence

1. Direct source property/location attribution.
2. Approved, effective-dated, tenant- and currency-matched versioned allocation rule.
3. Activity-driver allocation from persisted operational units.
4. Explicitly approved manual allocation.
5. Visible unallocated exception.

Draft, expired, cross-tenant, wrong-currency, or inapplicable rules must not be applied. Monetary allocation uses integer minor units and deterministic largest-remainder apportionment. Allocations plus any unallocated exception must reconcile exactly to the source amount. Rule-derived allocations retain rule ID and version. Duplicate source recognition is guarded by tenant, source type, and source ID.

## Implemented

- Pure allocation kernel and focused unit tests.
- Migration `0040_operational_cost_intelligence.sql` defining tenant-scoped operational expense categories, expenses, payments, recurring schedules/occurrences, allocation rules, allocations, exceptions, and activity drivers.
- Migration `0041_operational_cost_intelligence_privilege_hardening.sql` hardening database privileges.
- Database functions for expense allocation, recurring expense generation, and stock-consumption allocation.
- Payment-status trigger and database-side checks for overpayment, approval, tenant/property scope, allocation method, rule validity, and reconciliation.
- Activity-driver server functions and capture/list UI in the restaurant costing route.
- Expense lifecycle UI and authenticated server actions: category creation, expense capture/listing, independent approval, payment recording, and direct property allocation.
- Shared-expense allocation-rule lifecycle: versioned draft creation, tenant/property validation, independent approval, effective-date/currency checks, deterministic minor-unit apportionment, and rule-backed allocation from the costing workspace.
- Consumption-allocation server function.
- Profitability aggregation includes allocated operating expenses, contribution profit, and contribution margin while retaining food-cost metrics separately.

## Verification and acceptance evidence

- Dedicated Phase 3 Hybrid Allocation workflow run #138: **PASS**, including allocation tests and isolated PostgreSQL migration, expense lifecycle, payment trigger, RLS, tenant isolation, and property-scoped read/write isolation.
- Full LexiBite CI run #1256: **PASS** across strict repository typecheck, changed-source lint, migration verification, complete migration chain, Phase 3 isolated PostgreSQL verification, scoped functional tests, full test suite, and bundle-origin verification.
- Vercel commit preview: **Ready**. This is a preview deployment, not a production promotion.
- Phase 3 implementation PR #181 merged.
- Property-scoped isolation acceptance PR #182 merged.
- Final acceptance merge commit: `471cf384c76ff7ebbeb9d3d50d6dd40b7238f6fe`.

## Release boundary

- Phase 3 implementation and repository acceptance are closed on `main`.
- The production database migration has **not** been applied.
- No production business data has been written or modified.
- No production deployment or promotion has been performed.
- Production rollout requires a separately authorized release, production migration preflight, and post-migration verification. The preview deployment must not be treated as production.

## Final disposition

**Phase 3: IMPLEMENTATION CLOSED — MERGED — CI CERTIFIED.**

**Production rollout: NOT PERFORMED.**