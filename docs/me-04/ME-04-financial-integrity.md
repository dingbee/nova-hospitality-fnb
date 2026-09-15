# ME-04 — Financial Integrity Certification

Starting point: `claude/me-00-baseline-lock` @ `e212247a14cfcfe255901f0179ab2967a1a05024`
(the ME-01/02/03 corrective integration, PR #22, already merged into that
branch). This pass builds on it without repeating the ME-01/02/03
investigations or undoing any of their verified fixes.

Branch: `claude/me-04-financial-integrity`. Production: Supabase project
`nova-hospitality-fnb` (`lusiqcmxfxhnehxmwihs`).

## Scope

Full financial subsystem: orders → payments → receipts, refunds/voids,
cash control (payouts, tender declaration, daily close), giveaways/comps,
inventory↔financial coupling, purchasing, tenant/property/outlet
isolation, auditability, idempotency/concurrency, database constraints,
production reconciliation. Per the ME-04 mandate, this is an
inspect-reconstruct-reproduce-fix-test-certify pass, not an audit-only
pass: every in-scope defect found below was fixed, tested, and verified
against production in this same session — not deferred.

**Honesty note on completeness.** This document distinguishes three
statuses throughout: **FIXED** (a defect found, reproduced, corrected, and
verified this pass), **VERIFIED** (a control independently re-confirmed
this pass, either newly or by re-checking ME-01/02/03's prior evidence
against current production state), and **NOT RE-AUDITED THIS PASS** (an
area the mandate covers that this session did not have time to
independently deep-dive beyond what ME-01/02/03 already certified — named
explicitly rather than silently assumed clean). Nothing found and provably
broken was left unfixed.

## 1. Financial architecture map

Mapped via direct code reading plus a dedicated exploration pass (see
commit history / session record for the full file-by-file map). Summary:

- **Order → Bill → Receipt**: `sales.server.ts` (`insertLines`,
  `recalcOrder`, `createOrder`), `bill.server.ts` (`getBill`, `buildSplit`,
  `requestBill`, `refundPayment`, `deliverReceipt`), `receipts.server.ts`
  (`issueReceipt`, immutable snapshot at close).
- **Payments**: `pos.server.ts` (`takePosPayment`, `recordGuestPayment`),
  `sales.server.ts` (`recordPayment`), `selfpay.server.ts` (guest/online,
  re-verifies with the provider before recording), `mobilemoney.server.ts`
  (collection + webhook, idempotent by `(provider_code, provider_event_id)`),
  `commercial/payments.server.ts` (separate SaaS billing subsystem, not
  guest/POS money).
- **Fiscal**: `fiscal.server.ts` / `providers/traEfd.server.ts`, both
  calling `restaurant_fiscal_next_counter` (DB-serialized counter,
  authorization hardened in ME-02/0066).
- **Cash control**: DB-only — `restaurant_cash_payout_*`,
  `restaurant_daily_close_*`, `restaurant_tender_declaration_*`,
  `restaurant_expected_tender` (migration `0076`). `reconciliation.server.ts`
  covers daily close / tender declaration / reconciliation from the
  application side.
- **Giveaways/comps/discounts**: DB — `restaurant_request_giveaway`,
  `restaurant_decide_giveaway`, `restaurant_apply_giveaway`,
  `restaurant_reverse_giveaway`, guarded by the `restaurant_giveaway_guard`
  trigger (migration `0076`). Application — `pricing.server.ts`
  (`applyDiscount`).
- **Inventory↔financial**: `procurement/receiving.server.ts`
  (`postGoodsReceipt`, idempotent via `movements.server.ts`'s
  `dedupe_key`), `products/consumption.server.ts`, `purchasing.server.ts`.

## 2–21. Findings, fixes, and verification

### DEFECT 1 (FIXED) — cross-property financial data leak

**Control**: tenant/property/outlet financial isolation (mandate §13).

**Finding**: every other financial table with a property dimension
(`restaurant_orders`, `restaurant_payments`, `restaurant_daily_closes`,
`restaurant_tender_declarations`) was migrated to property-scoped RLS by
the P1/P09/ME-01 sweeps. Four were missed: `restaurant_cash_payouts`,
`restaurant_cash_payout_events`, `restaurant_declaration_revisions`
(all introduced in `0076`) and `restaurant_discount_applications`
(present since `0001`, never touched by any property-scope sweep). Their
RLS used only `restaurant_can_read(tenant_id)` /
`restaurant_can_write(tenant_id, roles)`, which do not consult
`restaurant_members.property_id`.

**Effect confirmed**: a staff member scoped to one property could read
every other property's cash-payout requests and audit trail, drawer
declaration revision history, and every discount/comp/giveaway record in
the same tenant — and, for cash payouts, request/approve/pay out cash
against a property they hold no grant for.

**Fix**: migration `0078` adds `restaurant_cash_payout_property()`
(mirroring the existing `restaurant_daily_close_property` /
`restaurant_order_property` pattern) and rewrites all four tables' RLS to
`restaurant_can_read_scoped_strict` / `restaurant_can_write_scoped`,
deriving each table's property the same way its siblings already do.
Authorization permissiveness (who may act, not just where) was
deliberately left unchanged — only the missing property dimension was
added — to avoid an unproven tightening outside this pass's evidence.

**Verification (production, rolled back, no data retained)**: created a
throwaway tenant with two properties, one member scoped to each, one order
+ discount application + cash payout per property. As the property-A
member: read `restaurant_discount_applications`/`restaurant_cash_payouts`
filtered to both records — **1 of 2 visible** (own property only, was 2 of
2 before the fix); attempted `INSERT` of a cash payout against property
B — **rejected** ("new row violates row-level security policy for table
\"restaurant_cash_payouts\""). Re-ran `get_advisors` (security) before and
after: `authenticated_security_definer_function_executable` count moved
44→46, accounted for exactly by the two new/newly-authenticated functions
this migration adds (`restaurant_cash_payout_property`,
`restaurant_apply_giveaway` — see Defect 2); `rls_enabled_no_policy`
unchanged at 2 (pre-existing, out of scope); no new finding categories.

### DEFECT 2 (FIXED) — order-item-level discount/comp was completely non-functional

**Control**: giveaway/comps control, rollback integrity (mandate §10, §16).

**Finding**: `restaurant_giveaway_guard` (trigger, `0076`, live in
production since before this repo's earliest captured baseline) rejects
any write to `restaurant_order_items.discount`/`is_comp`/etc. that isn't
accompanied by an approved `restaurant_discount_applications` row applied
through `restaurant_apply_giveaway`. But `restaurant_apply_giveaway` and
its callers (`restaurant_request_giveaway`, `restaurant_decide_giveaway`,
`restaurant_reverse_giveaway`) had `EXECUTE` granted to `service_role`
only (`0048`, preserved by `0076`) — and this repository's only
request-scoped Supabase client
(`src/integrations/supabase/auth-middleware.ts`) always forwards the
calling user's own bearer JWT, never a service-role key. `0048`'s own
header justifies the blanket revoke as "zero-argument (or action-only)
trigger/control functions... zero direct `.rpc()` callers" — true for the
11 actual trigger functions in this family, but these four are
multi-argument RPC entry points, not triggers. Net effect: **no code
path — old or new — could ever apply a line-scoped discount or comp in
production.**

**Reproduction (before fix, production, rolled back)**: a bare `UPDATE` of
`restaurant_order_items.discount` — exactly what `pricing.server.ts`'s
`applyDiscount()` did for a line-scoped discount — failed with: *"A
discount or comp must be granted through the authorised giveaway path, not
written onto a sales line."*

**Fix, scoped narrowly to what's proven broken**:
- Migration `0078` grants `authenticated` `EXECUTE` on
  `restaurant_apply_giveaway` only. It performs no independent role/rule
  authorization — it applies whatever `restaurant_discount_applications`
  row it's handed, gated on that row already being `status='approved'`
  (enforced by that table's own INSERT RLS, unchanged). Granting it does
  not bypass any authorization this pass could verify.
  `restaurant_request_giveaway`/`restaurant_decide_giveaway`/
  `restaurant_reverse_giveaway` were deliberately left service-role-only:
  they encode a different role model (`restaurant_members.role` against a
  fixed owner/GM/manager list) than `applyDiscount`'s existing
  capability-based gate (`assertCapability(..., "sales.manage")`);
  reconciling the two authorization models is a larger design question
  outside "smallest correct change," and per this pass's own
  application-code audit, nothing in the repository calls them, so leaving
  them alone changes no live behavior.
- `pricing.server.ts`'s `applyDiscount`: the order-item-scoped branch now
  inserts the `restaurant_discount_applications` row first, then calls
  `restaurant_apply_giveaway` via RPC to perform the actual mutation
  (order_items + order totals), instead of writing `order_items` directly.
  The order-level (whole-bill) branch was **not** touched — it never wrote
  `order_items` and was never affected by the trigger; rerouting it through
  `restaurant_apply_giveaway`'s per-line proportional distribution would
  have been an unproven behavior change to something that already works.

**Verification (production, rolled back, no data retained)**: inserted an
approved `restaurant_discount_applications` row for a throwaway order
item, called `restaurant_apply_giveaway` — **succeeded**; order item
`discount=2.00, line_total=8.00`; order `subtotal=10.00,
discount_total=2.00, total=8.00` (subtotal − discount = total, per
mandate §2's arithmetic invariant).

**Regression tests added**: `pricing.server.discount.test.ts` (2 tests) —
proves `applyDiscount` calls `restaurant_apply_giveaway` (never writes
`order_items` directly) on success, and surfaces/does-not-partially-apply
on an RPC rejection (e.g. a locked business day).

### DEFECT 3 (FIXED) — `refundPayment` had the same race ME-03 fixed elsewhere, but not here

**Control**: payment/refund idempotency and concurrency (mandate §3.B,
§6).

**Finding**: ME-03 fixed `takePosPayment`/`recordGuestPayment`'s
check-then-insert race (two concurrent requests with the same
`clientRequestId` could both pass a "no existing row" check before either
inserted) by switching to insert-then-recover-on-`23505`. `refundPayment`
(`bill.server.ts`) had the identical pattern against the same
`(tenant_id, client_request_id)` unique index and was not part of that
fix. The unique index meant a race could never produce **two** refund
rows (the loser's insert fails with `23505`), so this was not a
double-refund risk — but the loser surfaced a raw Postgres
unique-violation error to the caller instead of the idempotent response
the function's own duplicate pre-check shows it was designed to give.

**Fix**: `refundPayment` now inserts unconditionally and recovers on a
`23505` conflict, matching the established pattern exactly (same file
family, same error-code check style as `pos.server.ts`).

**Regression test added**: `payments.idempotency.test.ts` gained a
`refundPayment` case proving a retried refund with the same
`clientRequestId` resolves idempotently (`duplicate: true`, one row
stored) instead of throwing.

### Controls re-verified this pass (VERIFIED, carried forward from ME-01/02/03, re-confirmed against current production rather than re-derived from scratch)

- **Production/Git reconciliation** (§18): `list_migrations` against
  `lusiqcmxfxhnehxmwihs` matches the Git migration sequence through
  `me01_me02_corrective_rbac_user_roles_read_scope_regression_fix`
  (the ME-01/02/03 pass's own last migration) with no drift, before this
  pass's own `0078` was applied on top.
- **Database constraints / RLS baseline** (§17, §13 tenant level):
  `get_advisors` (security) before this pass's changes: 2
  `rls_enabled_no_policy` (pre-existing, unrelated tables), 44
  `authenticated_security_definer_function_executable`, 1
  `auth_leaked_password_protection` (WARN) — identical to the numbers
  ME-01/02/03 recorded. After this pass: 46 (+2, both accounted for
  above), everything else unchanged. Performance advisors: 0
  unindexed-FK, 0 `auth_rls_initplan`, 0 `multiple_permissive_policies`
  findings before and after — only `unused_index` (INFO, expected for
  newly-added indexes) appears.
- **Payment idempotency baseline** (§3, §15): `takePosPayment`,
  `recordGuestPayment`, `recordPayment`, and goods-receipt posting
  (`postGoodsReceipt`) all already use insert-then-recover or
  already-posted dedupe-key checks per ME-03; re-ran their full test
  suites this pass (all green) rather than re-deriving the fix.
- **Fiscal counter authorization** (§4): `restaurant_fiscal_next_counter`
  still requires an authenticated caller and `restaurant_can_write_scoped`
  before writing (ME-02, unchanged by this pass).

### Areas NOT independently re-audited to full depth this pass

Named explicitly per this document's honesty policy, not silently assumed
clean:

- **Fiscal counter concurrency under genuine load** (§4, §15):
  `fiscal.server.ts`'s `isAnotherSubmissionInFlight` guard is a
  best-effort, DB-visible mutual-exclusion check with its own in-code
  admission that it "does not guarantee strict GC-ascending delivery order
  under heavy concurrency." `restaurant_fiscal_next_counter` itself is a
  single DB function (the actual sequence allocator) and is almost
  certainly safe under real concurrency since it's a single atomic
  increment, but this pass did not run a genuine concurrent-connections
  load test against it (no local Postgres/pgbench harness was set up for
  this session, and repeating that against production was judged
  unnecessarily risky for a control ME-02 already certified). Flagged as a
  candidate for a dedicated concurrency-test pass, not asserted safe
  beyond the single-function-atomicity argument above.
- **Supplier/purchasing 3-way match** (§12): no supplier-invoice-vs-PO-vs-
  goods-receipt matching entity was found; cost capture happens via
  goods-receipt line `unit_cost` and `recordPriceObservation`. Not
  necessarily a defect (a 3-way match may not be part of this product's
  intended design), but not independently confirmed as intentional either.
- **`restaurant_request_giveaway`/`restaurant_decide_giveaway`/
  `restaurant_reverse_giveaway`** remain unreachable from the application
  (service-role-only, no caller in `src/`). This is a known, documented
  gap (not a defect this pass fixed) — see Defect 2's fix rationale for
  why widening their grants was out of this pass's "smallest correct
  change" scope.
- Full end-to-end UI verification of the discount fix (this session has no
  browser/UI access to the live app) — verified at the database layer
  (the layer the actual defect lived in) and via the updated unit tests,
  not by driving the POS UI.

## Test evidence (exact counts, this session)

- `bun install`: clean, 903 packages.
- `bun run build`: succeeds (TanStack Start + Nitro/Cloudflare build,
  PWA precache 171 entries).
- `bun run typecheck`: 3 errors, all pre-existing and in files this pass
  never touched (`src/router.tsx`,
  `src/routes/_authenticated.admin.tsx`,
  `src/modules/restaurant/intelligence/menuReasoning.server.test.ts`) —
  identical to the 3 ME-01 PR #21 and the ME-01/02/03 pass both already
  reported as pre-existing.
- `bun run lint` (whole repo): pre-existing Prettier debt unrelated to
  this pass's changes (confirmed via `git stash` diff — identical error
  count in `bill.server.ts` before and after this pass's edit, none on
  touched lines). Every file this pass actually changed: **0 errors**.
- `bun run test` (`vitest run`, whole repo): **2133/2133 tests passing,
  169/169 files** (2130/168 baseline + 3 new tests in 1 new file, plus 1
  test added to an existing file).
- Production verification: 3 rolled-back (`BEGIN...ROLLBACK`) reproductions
  against `lusiqcmxfxhnehxmwihs` (Defect 2's failure reproduction, Defect
  2's fix verification, Defect 1's hostile cross-property isolation test)
  — no data retained in any case. 1 dry-run (`BEGIN...ROLLBACK`) of the
  full migration before applying it for real. `get_advisors`
  (security + performance) re-run after the real apply, diffed against the
  pre-migration baseline.

## Migration / production changes

- `standalone/db/migrations/0078_me04_financial_property_scope_and_giveaway_grant.sql`
  — new. Applied to production as
  `me04_financial_property_scope_and_giveaway_grant`, dry-run verified
  first. Additive/policy-replacement only: no destructive DDL, no data
  touched.

## Application changes

- `src/modules/restaurant/pricing/pricing.server.ts` — `applyDiscount`'s
  order-item branch now applies via `restaurant_apply_giveaway` (Defect 2).
- `src/modules/restaurant/sales/bill.server.ts` — `refundPayment` insert-
  then-recover (Defect 3).
- New: `src/modules/restaurant/pricing/pricing.server.discount.test.ts`.
- Updated: `src/modules/restaurant/sales/payments.idempotency.test.ts`
  (added `refundPayment` coverage).

## Certification matrix

| Control | Result | Evidence |
|---|---|---|
| Monetary arithmetic (subtotal − discount = total) | VERIFIED | Defect 2 production verification |
| Rounding | NOT RE-AUDITED THIS PASS beyond what's exercised by existing `engine.test.ts` (17 tests, unchanged, still green) | — |
| Payment uniqueness / idempotency | VERIFIED (baseline) + FIXED (refund gap) | Defect 3; full suite green |
| Payment concurrency | VERIFIED (baseline, ME-03 unique-index + insert-recover pattern); refund case now matches | Defect 3 |
| Webhook idempotency | VERIFIED (baseline, ME-03; `mobilemoney.server.test.ts` 38 tests green, unchanged) | — |
| Receipt sequencing / fiscal counter authorization | VERIFIED (baseline, ME-02, unchanged); concurrency under load NOT RE-AUDITED | — |
| Order/payment consistency | VERIFIED | `recalcOrder` tests green; Defect 2 arithmetic check |
| Refund integrity | FIXED | Defect 3 |
| Void/cancellation integrity | NOT RE-AUDITED THIS PASS (existing `cancellation.server.ts` tests green, unchanged) | — |
| Cash movement / payout integrity | VERIFIED (function logic, `0076`) + FIXED (property scope) | Defect 1 |
| Tender declaration / daily close integrity | VERIFIED (function logic, `0076`); property scope already correct pre-existing | — |
| Giveaway/comps control | FIXED (was completely non-functional) | Defect 2 |
| Inventory/financial consistency, goods-receipt idempotency | VERIFIED (baseline, ME-03, unchanged, tests green) | — |
| Supplier/purchasing integrity | NOT RE-AUDITED THIS PASS (3-way match design question) | — |
| Tenant financial isolation | VERIFIED (baseline, unchanged) | `get_advisors` diff |
| Property/outlet financial isolation | FIXED | Defect 1, hostile RLS test |
| Auditability | VERIFIED (append-only/immutable triggers on cash-payout events, declaration revisions, giveaway records — `0076`, unchanged) | — |
| Rollback integrity | VERIFIED for the flows this pass touched (each fix proven via `BEGIN...ROLLBACK`) | — |
| Database constraints | VERIFIED, no regressions | `get_advisors` diff |
| Production/Git reconciliation | VERIFIED | `list_migrations` diff |

## Final certification result

**GREEN for the defects this pass found and fixed** — three real,
production-reproduced financial-integrity defects (a cross-property data
leak across four financial tables, a completely non-functional
giveaway/discount feature, and a refund idempotency gap) were identified,
root-caused, fixed, verified against production, and covered by new
regression tests, with the full suite green (2133/2133) and no
regressions in typecheck, lint, build, or the security/performance
advisor baseline.

**Not claimed**: exhaustive re-verification of every one of the mandate's
25 sections to the same depth — the "not independently re-audited" list
above is real and should be treated as open, not as passed. No known
fixable defect from what this pass *did* investigate was left unfixed.

**External limitation** (carried forward, re-confirmed unchanged):
`auth_leaked_password_protection` remains WARN — this is a Supabase
Pro-plan-and-above feature; `lusiqcmxfxhnehxmwihs` is confirmed below that
tier (per ME-01/02/03's own investigation, re-confirmed still true this
pass via the unchanged advisor finding). A billing decision, not a code or
configuration defect.
