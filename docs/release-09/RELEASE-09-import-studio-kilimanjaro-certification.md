# RELEASE-09 — Import Studio / Kilimanjaro Grill Operational Certification

## Objective

Certify LexiBite's restaurant onboarding/import surface for serious customer use, using the Kilimanjaro Grill demo tenant as the acceptance dataset and the existing Import Studio certification evidence as the engineering baseline.

## Certified surface

Import Studio supports two paths over the same staging and canonical write-path architecture:

1. Advanced Import: upload → parse → map → match → normalize → validate → human decision → commit → verify.
2. LexiBite Import Template: deterministic workbook onboarding path that feeds the same Import Studio staging/commit engine.

The canonical dependency order is:

supplier → inventory_item → supplier_product → menu → category → menu_item → product_station → variant → modifier_group → modifier → product_modifier_group → recipe_component → opening_stock.

The import layer does not directly mutate derived inventory quantities, payments, fiscal records, roles, or permissions.

## Prior engineering certification

ME-10 previously found and closed two real Import Studio defects:

- missing table-level grants on the four staging tables;
- missing application-layer property scope on workspace orchestration.

Those fixes were validated with a real PostgreSQL migration replay and adversarial authorization probes. The same ME-10 evidence also covers idempotent re-staging, commit replay, opening-stock ledger dedupe, natural-key protection, 400-row scale staging/commit, malformed-input handling, unsupported source handling, tenant isolation, property write isolation, and migration replay.

## Live production-schema verification

The live Supabase project now confirms:

- all four Import Studio staging tables grant SELECT/INSERT/UPDATE/DELETE to authenticated;
- the same four tables grant the corresponding administrative privileges to service_role;
- RLS policies remain active and property-scoped for writes;
- reads retain the intentional tenant-wide model;
- the ME-10 grants migration is present in the canonical migration history.

No active import workspace or staged import rows are present in the live database at certification time. This is treated as a clean-state result, not as a failed import.

## Kilimanjaro Grill acceptance dataset

Tenant: Kilimanjaro Grill (cebda97b-33b1-43bf-932e-d7fee992a6c3)

Current canonical acceptance state:

- 47 menu items
- 45 restaurant products
- 73 inventory items
- 74 supplier products
- 7 recipe components
- 81 stock movements
- Currency: TZS
- Trading name: Kilimanjaro Grill
- Legal/demo name: LexiBite Demo Restaurant

Protected acceptance fixture:

- Classic Chicken Burger
- SKU: KILI-009
- Price: TZS 18,000
- Must remain unchanged during onboarding/import certification.

## Acceptance gates

A customer onboarding import is accepted only when:

1. workbook/template is recognized as a LexiBite import source;
2. all supported sheets map to explicit domains;
3. unsupported/ambiguous rows are surfaced rather than guessed;
4. existing entities are matched deterministically where stable identifiers exist;
5. human approval is required for unresolved/ambiguous decisions;
6. dependency order is respected;
7. canonical writes use existing domain services;
8. opening stock reaches the stock-movement ledger with dedupe protection;
9. TZS/property currency is derived from the target property;
10. re-stage/re-commit does not duplicate canonical records;
11. cross-tenant and cross-property writes are rejected by authorization/RLS;
12. post-import counts and protected fixtures reconcile.

## Important operational boundary

The live environment currently has no active import workspace. Therefore this certification does not claim that a new customer workbook was uploaded through the production UI during this exact certification pass. It certifies the Import Studio implementation and live authorization/schema prerequisites against the already-certified ME-10 evidence, and validates the Kilimanjaro acceptance state in the live database.

A final customer onboarding rehearsal should use a disposable tenant/workspace before production customer data is introduced.

## Status

**RELEASE-09 — CERTIFIED**

Next gate: RELEASE-10 final release-candidate reconciliation and production verification, after RELEASE-01 through RELEASE-09 are certified.
