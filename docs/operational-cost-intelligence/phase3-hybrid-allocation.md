# Phase 3 — Hybrid Cost Allocation Engine

## Delivery boundary

This phase-3 workaround introduces a pure, deterministic allocation kernel against the current accessible `main` architecture. It does not claim to restore or replace the reported Phase 1 Operational Consumables or Phase 2 Operating Expense Management implementation.

The original P1/P2 branches and migrations are not present in the connected repository view. Therefore this change intentionally contains no database migration, table write, UI route, server action, or production integration. The kernel is designed to be called by the restored P1/P2 persistence services once their exact contracts are available.

## Existing architecture reused

- `restaurant_tenants`, `restaurant_properties`, and `restaurant_locations` remain the tenancy and operational scope authorities.
- `restaurant_stock_movements` remains the single stock-consumption ledger.
- `restaurant_inventory_items.average_cost` remains the weighted-average inventory valuation.
- Recipe and order-line cost snapshots remain authoritative for food-cost attribution.
- `restaurant_profitability_snapshots` remains the reporting extension point.
- Existing capability enforcement and database RLS remain the security boundary.

No second stock ledger, recipe-cost engine, or accounting ledger is introduced.

## Allocation precedence

1. Direct source property/outlet attribution.
2. Approved, effective-dated, tenant- and currency-matched versioned allocation rule.
3. Activity-driver allocation from a trusted operational projection.
4. Explicitly approved manual allocation.
5. Visible unallocated exception.

A draft, expired, cross-tenant, or wrong-currency rule is never applied. Invalid activity-driver input is rejected. Manual allocations require an approver and must reconcile exactly to the source amount.

## Financial integrity

- Monetary apportionment uses integer minor units and largest-remainder rounding.
- Allocated amounts plus the unallocated exception must equal the original source amount.
- Duplicate recognition is guarded by tenant + source type + source ID.
- Currency is carried through each allocation; no FX conversion is attempted.
- Rule ID and version are retained on rule-derived allocations.
- Expense recognition and payment remain separate concerns.
- Consumption sources are represented as references to the existing operational consumption ledger, not recreated as expense rows.

## Acceptance coverage in this branch

The unit suite covers direct attribution precedence, approved-rule allocation, exact rounding/reconciliation, activity-driver fallback, visible unallocated exceptions, manual approval and reconciliation, tenant/currency/effective-date rule rejection, invalid input, and duplicate source recognition.

## Required follow-on before production integration

1. Restore or recover the actual P1/P2 persistence contracts and migrations.
2. Add a server adapter using the repository's existing access/capability helpers and tenant/property/location scope checks.
3. Verify allocation-rule approval permissions and separation of duties against actual role contracts.
4. Add isolated PostgreSQL tests for constraints, RLS, transaction concurrency, idempotency and rule-version immutability.
5. Add E2E tests covering consumption + expenses + allocations + profitability without double counting.
6. Only after those checks, consider UI exposure and deployment.

## Status

Phase 3 domain kernel and unit tests are staged on a dedicated feature branch. Database acceptance, P1/P2 integration, E2E acceptance and production promotion are not claimed by this change.
