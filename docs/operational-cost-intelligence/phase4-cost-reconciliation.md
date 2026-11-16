# Phase 4 — Cost Reconciliation and Variance Intelligence

Phase 4 adds a reconciliation projection over existing stock movement, purchasing/receipt, operating expense and hybrid allocation ledgers. These source ledgers remain authoritative; reconciliation never rewrites them.

Included in this slice:
- additive persistence for reconciliation runs, source-linked variance lines, case investigation, event history, evidence references and thresholds;
- tenant/property-scoped read policies and restricted case-update columns;
- deterministic minor-unit variance arithmetic, exact allocation reconciliation, comparable-unit purchase-price checks and duplicate-source guards.

No expected consumption, budget or currency conversion is fabricated. Expected-consumption variances require an approved profile; expense variances require a like-for-like baseline; purchase price comparisons require identical units and currencies.

Acceptance still requires server orchestration, dashboard wiring, isolated PostgreSQL migration/RLS tests and full repository CI. No production migration or deployment is authorized.
