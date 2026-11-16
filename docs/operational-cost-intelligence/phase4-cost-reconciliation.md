# Phase 4 — Cost Reconciliation and Variance Intelligence

Phase 4 adds a reconciliation projection over existing operational expense and hybrid allocation ledgers. Source ledgers remain authoritative; reconciliation never rewrites them.

## Implemented
- Additive persistence for reconciliation runs, source-linked variance lines, case investigation, event history, evidence references and thresholds.
- Tenant/property-scoped RLS for reads and writes; case updates are restricted to investigation fields.
- Deterministic minor-unit variance arithmetic, exact allocation reconciliation, comparable-unit purchase-price checks and duplicate-source guards.
- Authenticated server orchestration for approved operating expenses versus their property allocations, with idempotent run fingerprints.
- Variance case lifecycle updates and event recording.
- Finance navigation entry and a property-scoped dashboard with run history, severity/open-case counts and investigation actions.
- Isolated PostgreSQL migration and property-isolation verification passed in the Phase 3 workflow.

## Explicit coverage boundary
The first executable reconciliation scope verifies approved operating-expense allocation completeness only. It does not claim stock-consumption, purchase-price, recipe-usage or budget variance coverage. No expected consumption, budget or currency conversion is fabricated. Those comparisons require approved source baselines and matching units/currencies.

## Acceptance
Still required: latest full LexiBite CI and dedicated Phase 4 kernel/database workflow must pass on the same final commit; review of server/UI integration and idempotent rerun behavior; then merge/release approval. No production migration or deployment is authorized by this phase work.
