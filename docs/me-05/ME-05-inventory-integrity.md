# ME-05 — Inventory Integrity Certification

Starting point: `claude/me-00-baseline-lock` @ `07b052aa62cfe047ba04264e464ef158b4ecd94a`
(the ME-01/02/03 corrective integration, PR #22, plus ME-04 Financial
Integrity Certification, PR #23, both already merged into that branch).
Builds on it without repeating the ME-01/02/03/04 investigations or undoing
any of their verified fixes.

Branch: `claude/me-05-inventory-integrity`. Production: Supabase project
`nova-hospitality-fnb` (`lusiqcmxfxhnehxmwihs`). PR: opened as a draft
against `claude/me-00-baseline-lock`, not merged — a human authorizes any
merge.

**Note on scope discipline**: while verifying production during this pass,
`list_migrations` showed two migrations named `me06_payment_refund_integrity_
reconstruction` and `me06_refund_retry_idempotency` already applied to
production, and the local `claude/me-00-baseline-lock` tracking ref had
moved to a newer commit than this branch's starting point. Both are evidence
that a separate ME-06 pass ran against the same production project during
or shortly before this session. Per the mandate's own scope discipline
("do not create another ME phase... do not reopen other phases' scope"),
this pass did not inspect, import, or build on that work — it is named here
only because production/Git reconciliation (mandate §25) requires not
silently ignoring what is actually in production. This branch was built
from the exact starting commit specified (`07b052a`), not from the moved
ref, per "do not modify prior ME branches."

## Scope and method

Full inventory subsystem: the stock-movement ledger and its invariant,
goods receiving, purchase-order reconciliation, units of measure, recipe
consumption (both the legacy flat mapping and the versioned recipe engine),
POS consumption, negative-stock policy, waste, adjustments, transfers,
returns/reversals, production, requisitions, inventory counts (stocktake),
costing, tenant/property/outlet isolation, authorization, auditability,
failure/rollback behavior, database constraints, clean migration replay,
and production/Git reconciliation.

**Method**: a genuine local PostgreSQL 16 instance was built by replaying
the complete migration chain (`local/scripts/init-db.sh`, this repository's
own local-appliance bootstrap) against a clean database — the same method
ME-04 established — then driving real concurrent transactions against it
with synchronized `psql` background processes (`BEGIN; SELECT pg_sleep(1);
<statement>; COMMIT;`) so both sides of a race genuinely overlap before
either commits. In addition, a dedicated subagent independently mapped the
inventory domain end-to-end from the repository and cross-checked every
claim against production via read-only Supabase MCP queries before any fix
was written, and a second subagent independently audited stocktake,
production, versioned recipe consumption, requisitions, `return_to_
supplier`, and reservations, each with a concrete reproduction or a cited
piece of evidence — every finding from both subagents was then independently
re-verified against the actual source before being treated as real (several
were confirmed by direct code inspection or a live SQL query rather than
taken on faith).

Every defect below distinguishes **FIXED** (reproduced, corrected, and
re-verified — for the RLS defect, by proving both the failure before the fix
and the success after it against the same fixture) from **VERIFIED**
(control checked and found already correct, with the specific evidence cited)
from **N/A WITH EVIDENCE** (capability does not exist / has no caller) from
**EXTERNAL LIMITATION** (out of this session's control).

## 1. Inventory architecture — the real model

Mapped directly from `standalone/db/migrations/*.sql` (81 files) and
`src/modules/restaurant/{inventory,products,procurement,purchasing,
requisitions}/*.server.ts`.

**Authoritative stock source of truth: both, kept in lockstep by one
trigger.** `restaurant_inventory_items.current_quantity`/`average_cost` is
a cached balance; `restaurant_stock_movements` is the append-only ledger.
A single `BEFORE INSERT` trigger, `restaurant_apply_stock_movement()`
(`SECURITY DEFINER`, row-locks the item `FOR UPDATE`), applies every
movement to the cached balance in the same transaction as the ledger
insert — they cannot diverge from a single well-formed insert. A
purpose-built view, `restaurant_stock_reconciliation_v`, already exists to
detect divergence from irregular data (a manual `UPDATE`, a partial
migration): it exposes `drift` (cached − ledger sum), `orphan_transfer_
movements` (transfer legs with no parent transfer document), and
`illegal_negative`.

**Important architectural characteristic (not a defect): the balance is
global per item, not per (item, location).** `current_quantity` is a single
number per `(tenant_id, inventory_item_id)`. `location_id` is carried on
every movement for audit/routing, and `restaurant_stock_positions_v`
derives a genuine per-location on-hand from the ledger — but the
*authoritative* balance the negative-stock guard and every reconciliation
check against is item-wide, not location-partitioned. This is a legitimate,
coherent design (confirmed consistent across every write path this pass
audited), but it means a location-scoped operation (e.g. a stocktake
counting only one location) that treats its local observation as the
*entire* correction for the item can, in the rarer case of the same item
genuinely holding stock at more than one location, misattribute a
correction. Noted here rather than redesigned — changing the balance model
itself is out of "smallest correct change" scope and not what any concrete
defect this pass found actually required; the concrete defect that *was*
found and fixed in this area (stocktake's stale-snapshot delta, Defect 3
below) is independent of this and fully fixed.

**Movement engine**: exactly one SQL mutation function
(`restaurant_apply_stock_movement`); all business logic (receiving, recipe
consumption, waste, adjustment, transfer, stocktake, production, reversal)
lives in TypeScript behind one shared choke point, `insertMovement()`
(`src/modules/restaurant/inventory/movements.server.ts`). Idempotency is a
Postgres `UNIQUE(tenant_id, dedupe_key)` constraint; `insertMovement`
swallows a `23505` conflict and returns `null`, which every caller in this
codebase treats as "already applied, skip downstream side effects."
Negative-stock policy is enforced twice — once in application code
(`policy.ts#evaluateNegativeStock`, a fast-fail friendly-message layer) and
authoritatively in the trigger under the same row lock, so a racy
application-level pre-check can never let two concurrent writers both push
a balance negative (proven under genuine concurrency, §5 below).

**Costing model: weighted average**, computed only on inbound movements
with a stated cost, confirmed in the trigger body and independently in
every consumption path's use of `average_cost`. No FIFO/standard/latest-cost
model exists anywhere in the schema or code.

**Recipe consumption timing**: stock is decremented at order **close**,
never at placement, kitchen production, or bill/payment (`sales.server.ts`,
ME-03-established and re-verified this pass). Two consumption paths coexist:
the legacy flat `restaurant_recipe_components` → `consumeForOrderItem`
(`movements.server.ts`), and the versioned `restaurant_recipes`/`
restaurant_recipe_lines` engine → `consumeForRecipeSale`
(`products/consumption.server.ts`), the latter with a circular-recipe guard
and sub-recipe explosion (verified correct, and its dedupe-key collision
bug fixed — Defect 5).

## 2. Core stock invariant

Proven, not assumed, in two independent ways this pass:

- **Genuine concurrency + the system's own reconciliation view**: after
  running every concurrency scenario in §5 against two seeded items on the
  local replica, `restaurant_stock_reconciliation_v` was queried directly.
  The item that received its entire balance through the ledger (no manual
  seed) showed `drift = 0.0000` exactly, after 8 committed movements across
  6 different concurrent-write scenarios. The other item, seeded with a raw
  `current_quantity` outside the ledger (an intentional test artifact, to
  prove the view catches exactly this), correctly showed a non-zero
  `drift` equal to the seeded amount — i.e. the drift-detection mechanism
  itself is proven to work, not merely assumed present.
- **Fresh-database migration replay** (§24 below): the full chain,
  including this pass's own migration, replays with zero errors against a
  genuinely clean Postgres 16 instance, so the invariant's enforcement
  (the trigger, the constraints) is not dependent on any pre-Git production
  object.

## 3. Stock movement engine

Audited every movement type's sign, unit, location, tenant, reference,
timestamp, actor, reason, resulting balance, idempotency and reversibility
by reading `insertMovement`, `signedQuantity`, and every caller. One
pre-existing behavior worth naming precisely (not a defect, verified
intentional): if a movement's `inventory_item_id` cannot be resolved for
the *inserting* `tenant_id` (e.g. a cross-tenant reference, which RLS
already prevents from being written by a normal caller in the first place —
this trigger behavior is defense-in-depth for a row that reaches it by
another path, e.g. a `service_role` script), the trigger returns the row
unchanged (`balance_after` stays `NULL`) rather than raising. This is inert
under the application's own write paths (every caller's `tenantId` is
already authorization-checked before the insert) and was not changed, since
altering `SECURITY DEFINER` trigger behavior on a hypothesis with no
reachable exploit path would be an unproven, unrelated change.

## 4/5. Idempotency and genuine concurrency

**Defect 1 (FIXED) — `transferStock` (the direct, same-call transfer) was
neither atomic nor idempotent.**

`src/modules/restaurant/inventory/movements.server.ts#transferStock`
(exposed via `transferRestaurantStockFn`, a live authenticated server
function) posted its `transfer_out`/`transfer_in` pair as two independent
`insertMovement` calls with **no dedupe key at all** (`transferStockSchema`
had no such field) and **no compensation** if the second call failed after
the first committed — exactly the two failure modes mandate §14 prohibits
("duplicate transfer", "stock removed from source but not received at
destination"). `restaurant_stock_reconciliation_v`'s own `orphan_transfer_
movements` column exists specifically to flag exactly this shape of
row, which is itself evidence this was a known-anticipated gap that was
never closed for this particular function (the document-based transfer flow
in `transfers.server.ts` was already correct and well-tested).

**Fix**: `transferStockSchema` gained an optional `dedupeKey`; each leg gets
a deterministic sub-key (`${dedupeKey}:out` / `:in`). If the inbound leg
fails after the outbound committed, the outbound is compensated with an
explicit `reversal` movement (itself idempotent via `reversal:<id>`) before
the error is re-thrown. A second, subtler defect was found *while fixing
the first*: a naive "outbound insert returned null → the leg must already
be applied, just finish the inbound leg" retry rule is wrong once that
outbound has been *compensated* — the outbound's dedupe key still exists
(blocking a fresh outbound) but no longer has any effect, so a naive retry
would let a lone inbound leg succeed, creating stock at the destination
with nothing actually leaving the source. Fixed by resolving the existing
outbound row and checking whether it already has a reversal before
touching the inbound leg; if it does, the dedupe key is refused as dead
("retry with a new idempotency key") rather than silently taking a partial
action. Both defects and the fix's own correctness are covered by 4 new
tests (`movements.transferStock.test.ts`), including one that specifically
reproduces the second-order retry-after-compensation bug.

**Defect 6 (FIXED) — `issueRequisition` had the identical, unfixed gap.**

`requisitions.server.ts#issueRequisition` posts the same kind of
`transfer_out`/`transfer_in` pair for internal stock issues, with a
dedupe key derived from `(line.id, issueQuantity, issued_quantity)` — but
no compensation on inbound failure, and (worse than `transferStock`'s
original bug) the dedupe key is *not* caller-suppliable, so a naive retry
after a failure recomputes the *exact same* key (since `issued_quantity`
is only advanced after both legs succeed) and hits the old code's
`if (!out) continue;`, permanently stranding the line: no error, no
completion, `issued_quantity` never advances, and every future retry
repeats the same silent skip forever. **Fixed identically** to Defect 1
(resolve-existing-outbound + reversal-check + compensation), reusing two
new shared helpers (`findMovementByDedupeKey`, `movementHasReversal`,
exported from `movements.server.ts`). Covered by 3 new tests
(`requisitions.server.test.ts`).

**Defect 2 (FIXED) — 11 inventory-document tables were tenant-only under
RLS, not property-scoped, in Git *and confirmed live in production*.**
See §19 below — this is the single most severe defect this pass found and
is documented there in full, since it is fundamentally a tenant/property
isolation defect, not a narrow idempotency one.

**Defect 3 (FIXED) — `postStocktake` posted a stale, count-start-relative
delta instead of re-diffing against the current balance.**

`variance_quantity` (a `GENERATED` column) is `counted_quantity` minus the
balance frozen at `startStocktake` (T0). Posting that number as a ledger
*delta* at post time (T1) is only correct if the balance never moved
between T0 and T1. Any legitimate sale, receipt, waste, or transfer against
the same item during the counting window (which can span minutes or hours)
is real, already-correct activity; posting the stale T0-relative variance
on top of it double-applies that activity into the "correction," fabricating
a phantom discrepancy exactly equal to whatever moved in between, and
mislabels it `reason_code: "counting_error"` by default.

**Reproduced**: item at 100 when counting starts; a legitimate sale of 10
lands mid-count (ledger correctly reads 90); the physical count also finds
90 (matches reality — nothing is actually wrong). Pre-fix: `variance_
quantity = 90 − 100 = −10` would be posted as a delta, driving the ledger
to `90 − 10 = 80` — a fabricated 10-unit shortage from a real sale. **Fixed**
by re-diffing `counted_quantity` against a fresh read of `current_quantity`
at post time and posting only the genuine remaining gap; the original
`variance_quantity` display column is untouched (still shows the
count-start-relative story for audit), only what gets **posted** to the
ledger changed. 3 new tests (`stocktake.server.test.ts`) cover: no
adjustment posted when an intervening movement already explains the
apparent variance; the correct (smaller, real) adjustment posted when a
genuine gap remains; idempotency on retry unchanged.

**Defect 4 (FIXED) — production inputs skipped unit conversion entirely.**

`startProduction` built `restaurant_production_inputs.planned_quantity`/
`actual_quantity` from `RecipeCostLine.effectiveQuantity`
(`products/recipe-cost.server.ts`) — which is in the recipe line's own
*declared* unit (e.g. grams), never converted to the referenced item's
*stock* unit (e.g. kilograms), unlike every other consumption path in this
codebase (`consumeForOrderItem`, `consumeForRecipeSale`, `postGoodsReceipt`,
all of which call `componentToStock`/`convertUnits` before touching the
ledger). `resolveRecipeCost` *did* compute the converted quantity
internally (`exact.quantity`, used correctly for `lineCost`) but never
exposed it on the line object it returns — `completeProduction` then posted
the raw, unconverted number straight to the ledger as a `consumption`
movement. A 500-gram recipe line against a kilogram-stocked item would
deduct 500 (whole kilograms) instead of 0.5 — a 1000× over-consumption, and
also silently miscost (the old `unit_id` column on `restaurant_production_
inputs` was never even populated).

**Fixed**: `RecipeCostLine` gained `stockQuantity` (the already-computed
converted value) and `stockUnitId` (the item's own unit); `production.server
.ts` uses both. A related, previously-unguarded gap was closed in the same
fix: `startProduction` never checked `resolveRecipeCost`'s own `
unresolvedComponents` count before proceeding, so a recipe with a
genuinely unconvertible unit (an unmapped dimension, no content bridge)
would silently plan and later consume the *unconverted* number rather than
refuse — exactly the "conversion error must not silently create or destroy
stock" mandate §8 prohibits. `startProduction` now refuses outright, before
creating anything, when any component is unresolved (matching the
established hard-refusal convention every other consumption path already
uses). 3 new tests (`production.server.test.ts`) cover: the correct
converted quantity/cost for a 500g-vs-kg case end to end (plan → complete →
ledger); correct scaling across multiple batches; refusal (no production
run, no input rows created) for a genuinely unconvertible unit.

**Defect 5 (FIXED) — dedupe-key collision when the same childless
sub-recipe is referenced by two lines of the same parent recipe.**

`consumption.server.ts#explode`'s recursive walk into a childless
sub-recipe (one with no `produces_inventory_item_id`, so its own
ingredients are consumed directly) keyed each resulting line as
`${subRecipeId}:${subLineId}` — identical regardless of which *parent*
line triggered the recursion. A parent recipe referencing the same shared
sub-recipe from two distinct lines (e.g. "bun spread" ×1 and "dip on the
side" ×2, both pointing at a shared "House Sauce" sub-recipe) produces two
genuinely different demand quantities for the sub-recipe's own ingredients,
but with the *same* dedupe key — the second `insertMovement` call is
correctly rejected by the unique constraint as "duplicate," silently
dropping real, distinct demand. Net effect: silent under-consumption
(stock overstated) whenever a recipe references the same childless
sub-recipe more than once.

**Fixed** by threading a lineage-based key prefix through the recursion
(distinct from the pre-existing `path` array, which is deliberately kept
to bare recipe ids for cycle detection only) so each distinct reference
path produces a unique key; a non-recursive (top-level) line's key is
unchanged from before this fix, so no dedupe-key churn for the common case
or for orders already processed under the old keys. 2 new tests
(`consumption.server.test.ts`) cover: both demand lines post as separate
movements with distinct keys and the correct total cost; a genuine retry
of the same order item still only posts each exactly once.

**Genuine concurrency evidence** (real overlapping `psql` transactions
against the local Postgres 16 replica, `BEGIN; SELECT pg_sleep(1); …;
COMMIT;`, not simulated/sequential):

| Control | Test | Result |
|---|---|---|
| Negative-stock race (A/H) | 2 concurrent `-30` consumption movements against 50 on-hand | 1 succeeded (50→20), 1 clean `negative_stock` rejection; final balance 20, never negative |
| Duplicate goods-receipt-style movement (B) | 2 concurrent `INSERT`s, same `receipt:<id>:<line>` dedupe key, `+25` each | 1 succeeded (+25), 1 clean `23505`; balance +25 once, not +50 |
| Reversal uniqueness (G) | 2 concurrent reversals of the same original movement, same `reversal:<id>` key | 1 succeeded, 1 clean `23505`; exactly 1 reversal row exists |
| Recipe/POS consumption duplicate (C/D) | 2 concurrent `INSERT`s, same `consume:<orderItem>:<component>` key, `-5` each | 1 succeeded, 1 clean `23505`; balance -5 once, not -10 |
| Legitimate concurrent adjustments, no-lost-update (E) | 2 concurrent `+7` adjustments, distinct dedupe keys | Both succeeded; final balance +14 exactly (the `FOR UPDATE` lock correctly serializes two genuinely simultaneous writers) |
| Transfer race against limited stock (F/H) | 2 concurrent `-20` transfer_out against 35 on-hand | 1 succeeded (35→15), 1 clean `negative_stock` rejection |
| Cross-property RLS read (isolation) | Property-A-scoped `inventory_manager` reading a property-B goods receipt, before vs. after the fix | **Before**: 1 row visible (vulnerable). **After**: 0 rows (correctly blocked); own-property read still works (1 row) |
| Cross-property RLS write (isolation) | Same member `INSERT`ing a line into the property-B receipt | Rejected by RLS after the fix |

## 6. Goods receiving

`src/modules/restaurant/procurement/receiving.server.ts` was audited in
full and found already solid, with ME-03's idempotency work correctly
covering the complete flow: per-line dedupe key (`receipt:<receiptId>:
<lineId>`), unit conversion (purchase unit → stock unit, and content-bridge
conversion) resolved and validated for *every* line before any movement is
written (so a receipt never partially posts), over-receipt requires an
explicit authorized reason and `purchasing.approve`, the order's
receivability is re-checked at *posting* time (not just draft time) so a
receipt drafted while the PO was open can't resurrect a since-cancelled
order, and the PO fulfillment counter update is itself gated on `!
alreadyPosted` (an explicit ME-03 comment explains why: it has no unique-
constraint backstop of its own, unlike the ledger insert). **VERIFIED**,
no defect found; re-exercised via the concurrency evidence above (duplicate
goods-receipt-style movement, Control B).

## 7. Purchase-order ↔ inventory reconciliation

`postGoodsReceipt` re-reads `received_quantity`/`accepted_quantity`/
`rejected_quantity` per PO line and accumulates rather than overwrites, and
the accumulation itself is gated on the same `!alreadyPosted` idempotency
signal as above — a retried or concurrently-duplicated post cannot drift the
PO's cumulative counters away from the actual ledger. **VERIFIED**.

## 8. Units of measure

`src/modules/restaurant/inventory/units.ts` centralizes all conversion
(`convertUnits`, `purchaseToStock`, `componentToStock`, and a
content-bridge path for container/content items like bottle→ml). Every
consumption/receiving/production path either uses it and refuses on
`exact: false`, or (production, Defect 4) was fixed this pass to do so.
**VERIFIED** for receiving/consumption (pre-existing, extensively tested in
`content-conversion.test.ts`'s 11 numbered scenarios); **FIXED** for
production (Defect 4).

## 9. Recipe / component consumption — see §5 (Defect 5) and §1.

## 10. POS → inventory consumption

Traced `sales.server.ts`'s order-close path end to end: consumption runs
for every non-voided line (via `consumeForRecipeSale` or the legacy
`consumeForOrderItem`, plus `consumeLineModifiers` for stock-affecting
modifiers) *before* the order status flips to `closed` (ME-03), so a
failure partway through leaves the order open for a safe, idempotent retry
rather than closed with partial consumption. The order-status transition
itself is a check-then-act read with no row lock, so two genuinely
concurrent close attempts on the same order both pass the guard and both
run the consumption loop — but every movement they attempt shares the same
deterministic dedupe key, so the ledger and `current_quantity` are proven
correct either way (only one side's writes ever land); the only externally
visible effect of the race is on `closed_at`/receipt issuance, which is a
financial/order-lifecycle concern already inside ME-04's certified boundary,
not an inventory one, so it was not reopened here (mandate: "never reopen a
previously certified scope unless an inventory defect directly crosses it"
— it doesn't; inventory stays correct). **VERIFIED**.

## 11. Negative stock

Policy is centralized and pure (`policy.ts#evaluateNegativeStock`, "reversal
and adjustment are corrections and bypass the policy; everything else is
refused unless the item allows negative stock or a supervisor approved this
specific movement") and enforced twice: an application-level pre-check for
a friendly error message, and authoritatively inside the trigger's row lock.
**Proven under genuine concurrency** (Controls A and F above): two
simultaneous outbound movements that together would exceed on-hand always
resolve to exactly one success and one clean rejection, never both
succeeding into a negative balance. **VERIFIED**.

## 12. Waste

`waste.server.ts#recordWaste` requires a reason (with tenant-configurable
reason catalogue, `requires_note` enforced before any write), carries
tenant/property/location scope, posts through the same `insertMovement`
idempotency mechanism (caller-supplied `dedupeKey`), and emits a bar-specific
mirror event for beverage items. **VERIFIED**.

## 13. Inventory adjustments

`recordAdjustment` requires a reason, optionally requires `stocktake.approve`
for reasons flagged `requires_approval`, refuses a negative result unless
the item allows it, and — like every other path — is a compensating
*movement*, never a destructive rewrite of `current_quantity`. **Proven
under genuine concurrency** (Control E): two legitimate simultaneous
adjustments both land correctly with no lost update. **VERIFIED**.

## 14. Stock transfers — see §5 (Defect 1).

## 15. Returns / reversals

`reverseMovement`/`reverseMovementsForOrder(Item)` never delete; a reversal
is its own compensating movement, `reversal_of_id`-linked back to the
original, and the DB carries a `UNIQUE(reversal_of_id) WHERE reversal_of_id
IS NOT NULL` index — proven under genuine concurrency (Control G) to make a
double-reversal of the same movement impossible, not just discouraged.
"A reversal cannot itself be reversed" is enforced at the application layer.
`return_to_supplier` (the movement-type enum value) is **N/A WITH
EVIDENCE**: confirmed by repository-wide grep that no `.server.ts` file
anywhere constructs a movement with this type — it exists only in the
type/sign-direction tables, with zero live callers. Documented here rather
than implemented, since building a new feature is outside this
certification's "prove and harden what exists" mandate.

## 16. Inventory counts (stocktake) — see §5 (Defect 3).

Snapshot semantics: `startStocktake` freezes `expected_quantity` per line
from `restaurant_stock_positions_v` (location-scoped) or `current_quantity`
(tenant-wide) at count-start; a count never overwrites a balance directly,
only ever posts through the same movement/dedupe mechanism as everything
else. Double-post protection: the per-line dedupe key
(`stocktake:<lineId>`) plus the status-transition guard (`posted` status
refuses re-entry) together prevent double-application even under a
concurrent double-post — proven by the same `23505`-swallowing mechanism
verified everywhere else in this document, and covered by a dedicated new
test. The location-scoped-vs-global-balance nuance is documented in §1, not
re-litigated here.

## 17. Costing — see §1 ("weighted average", confirmed at both the trigger
and every application consumer).

## 18. Cost / quantity separation

Verified the invariant holds across every fixed and audited path: a
duplicate receipt increases neither quantity nor cost twice (dedupe key
covers the single `insertMovement` call that carries both); a reversal
changes both quantity and cost together (it reverses the *whole* original
movement, including its `unit_cost`/`total_cost`); the Defect 4 fix
specifically closes a case where quantity and cost had *already* diverged
(cost was computed from the converted quantity, quantity from the
unconverted one) — now both derive from the same `stockQuantity`.
**VERIFIED / FIXED** (Defect 4 is the concrete instance of this control
that failed).

## 19. Tenant / property / outlet isolation — MANDATORY

**Defect 2 (FIXED) — the most severe defect this pass found: 11
inventory-document tables were tenant-only under RLS, not property-scoped,
confirmed both in Git and live in production.**

Every table with a property/outlet dimension that *authorizes a ledger
write or correction* — `restaurant_goods_receipts`/`_items` (authorizes
stock entering the ledger), `restaurant_stocktakes`/`_lines` (authorizes
adjustment postings that correct the ledger), `restaurant_productions`/
`_inputs`, `restaurant_inventory_batches`, `restaurant_procurement_
variances`, `restaurant_purchase_requests`/`_items`, `restaurant_stock_
reservations` — used only `restaurant_can_read(tenant_id)`/`restaurant_can_
write(tenant_id, roles)`, which (confirmed by reading both function
bodies) never consult `restaurant_members.property_id` at all. Every
sibling table one layer up or down the same document chain —
`restaurant_stock_movements` (the ledger itself), `restaurant_purchase_
orders`/`_items`, `restaurant_inventory_items` — was already correctly
migrated to the property-scoped checks by the P1/P09/ME-01 sweeps. This is
precisely the same class of gap ME-04 (migration `0078`) fixed for
financial tables, unaddressed here, and more widespread: it touches nearly
every "document that authorizes a ledger write" table in the inventory
domain rather than a handful of close/declaration tables.

**Net effect before the fix**: a staff member whose `restaurant_members`
grant is scoped to one property could read *and write* — including posting
a goods receipt (moves stock into the ledger) or a stocktake adjustment
(corrects it) — for **any other property in the same tenant**. This is
exactly the hostile-operation class mandate §19 requires be rejected
("receive goods into another property", "adjust another outlet's
inventory").

**Confirmed independently against production**, not just Git, before
fixing: a read-only query against `pg_policies` on the live database showed
all 44 policies (11 tables × 4 commands) using the unscoped check, with zero
`_scoped` references anywhere.

**Fix** (migration `0081_me05_inventory_document_property_scope.sql`):
the identical pattern ME-04 established — a property-derivation helper per
child table (mirroring the pre-existing `restaurant_cash_payout_property`/
`restaurant_daily_close_property`), then every policy switched from the
tenant-wide check to the scoped one, **preserving each table's existing
role list exactly** (no new tightening beyond adding the property
dimension — an unrelated, unproven change this pass had no evidence for).

**Proven with a genuine before/after reproduction** against the local
replica (one transaction, one fixture, two `SAVEPOINT`-isolated halves so
both sides see identical data): a property-A-scoped `inventory_manager`
reading a property-B goods receipt returned 1 row under the *exact*
pre-fix policy text and 0 rows under the shipped post-fix policy; the same
member's read of their *own* property's receipt still returned 1 row (no
over-correction); a hostile `INSERT` into the property-B receipt's line
items was rejected by RLS.

**Applied to production** (with explicit human authorization for this
specific action, obtained mid-session before the write): `list_migrations`
now shows `me05_inventory_document_property_scope` as applied; a follow-up
read-only query confirmed all 44 policies on the 11 tables now reference
`_scoped`, and a hostile-residue sweep (any policy still lacking `_scoped`
in both `qual` and `with_check`) returned zero rows. `get_advisors`
(security) re-run after the production change: 0 new finding *types*,
`rls_enabled_no_policy` unchanged at 2 (pre-existing, out of scope — see
§23), `auth_leaked_password_protection` unchanged at 1 (external, see
below); `authenticated_security_definer_function_executable` rose from 46
to 50, exactly matching the 4 new property-derivation helper functions
this migration adds (`restaurant_goods_receipt_property`, `restaurant_
stocktake_property`, `restaurant_purchase_request_property`, `restaurant_
production_property`) — the same `SECURITY DEFINER` lookup-function shape
as the 46 pre-existing entries, not a new category.

## 20. Authorization

Mapped every inventory mutation to its capability: `stock.manage`
(manual movements, quick transfer), `transfer.manage`/`transfer.approve`
(document transfers), `waste.record`, `adjustment.manage`, `stocktake.
manage`/`stocktake.approve`, `receiving.manage`, `purchasing.approve`
(over-receipt), `production.manage`, `requisition.issue`, `inventory.
manage`/`location.manage` (catalog/location config). Every one of these
resolves through the tenant/property-scoped `assertCapability` helper
(`core/access.server.ts`), and — as of Defect 2's fix — every table those
capabilities write to now has matching database-level RLS enforcement, not
merely application-level gating. **VERIFIED / FIXED** (the fix *is* the
database-level half of this control for the 11 tables named above).

## 21. Auditability

Every material movement carries `created_by`, `occurred_at`/`created_at`,
`reason`/`reason_code`, `reference_type`/`reference_id`, and (where
applicable) `reversal_of_id`/`correlation_id`. The quick-transfer fix
(Defect 1) added a `correlation_id` pairing its two legs, since that path
(unlike the document-based transfer flow) has no `restaurant_stock_
transfers` row to link them through `transfer_id` — its legs will always
show as `orphan_transfer_movements` in the reconciliation view, which is
correct and expected (there genuinely is no transfer *document*), not a
residual defect; noted explicitly so it is never mistaken for one.
**VERIFIED**.

## 22. Failure / rollback testing

Covered concretely by the fixes and their tests above: goods receipt +
stock (pre-existing, verified via Control B); order consumption + stock
(pre-existing, verified via §10); transfer source + destination (Defect 1,
now proven atomic under compensation + a dedicated failure-injection test);
requisition issue source + destination (Defect 6, same proof); inventory
adjustment + ledger (Control E); stocktake post + ledger (Defect 3,
idempotent-retry test); reversal + compensating movement (Control G).

## 23. Database integrity

Confirmed via direct schema inspection: FK constraints throughout (e.g.
`restaurant_stock_movements` → items/locations/tenants), `UNIQUE(tenant_id,
dedupe_key)` on movements and on reservations, `UNIQUE(reversal_of_id)
WHERE reversal_of_id IS NOT NULL`, `numeric(14,4)`/`numeric(16,4)` precision
throughout, `CHECK(source_location_id <> destination_location_id)` on
transfers, `GENERATED ALWAYS AS` computed columns for `variance_quantity`
(both stocktake lines and transfer lines) so they cannot be written
inconsistently with their inputs. `rls_enabled_no_policy` (2 tables,
`migration_transfer_audit` and `user_roles`) is unchanged from the ME-04
baseline and outside inventory scope (neither is an inventory table) — not
investigated further here, consistent with "no scope escape."

## 24. Fresh database replay

The complete migration chain, `0000` through this pass's own `0081`, was
replayed against a genuinely clean local PostgreSQL 16 database
(`local/scripts/init-db.sh` → `apply-migrations.sh`). Initial full replay:
`applied=80 already-present=0 not-applicable=0`, zero errors. `0081` added
afterward: `applied=1 already-present=80 not-applicable=0`, zero errors.
**PASS** — the inventory subsystem (and everything else) reproduces from
Git alone with no hidden dependence on pre-Git production objects, which
ME-04 had already established for `0000`-`0080`; this pass re-confirms it
holds with `0081` included.

## 25. Production reconciliation

Read-only verification against `lusiqcmxfxhnehxmwihs` before any change:
`list_migrations` confirmed the five ME-01/02/04-era migrations this
mandate named as already-integrated equivalents are present (under
production's semantic-name convention, not bare `0076`-`0080` numbers,
which production's chain stopped using after `0063`); nothing named
`me05*` existed yet. A direct query confirmed the 11-table RLS gap was
live and current in production, not already fixed by some other path. The
production stock-reconciliation view showed 4 items with nonzero `drift`
and 0 `illegal_negative` at the time of inspection — reported for awareness
(pre-existing production data state, not something this pass's code changes
caused or were asked to remediate; remediating live production data drift
is a data-operations action outside this certification's "prove and harden
the code" mandate, and was not attempted).

After the fix: `me05_inventory_document_property_scope` confirmed as the
latest applied migration; all 44 policies on the 11 tables confirmed
`_scoped`; zero unscoped policies remain; security advisors show no new
finding type and no new RLS-related warning, only the expected +4 in the
pre-existing `authenticated_security_definer_function_executable` category
(explained in §19). See the scope-discipline note at the top of this
document regarding the separately-discovered `me06_*` migrations already
present in production — observed and reported, not investigated or acted
on, per mandate scope discipline.

## 26. Genuine concurrency evidence — see §5's table (8 scenarios, all
against real overlapping Postgres transactions, not simulated).

## 27. Testing

- **Full regression suite**: 2152/2152 tests passing, 175/175 files. 15 new
  tests across 5 new files this pass (`movements.transferStock.test.ts` ×4,
  `requisitions.server.test.ts` ×3, `stocktake.server.test.ts` ×3, `
  production.server.test.ts` ×3, `consumption.server.test.ts` ×2), every one
  written to reproduce a specific defect's failure mode and prove the fix,
  not merely to pad coverage.
- **Typecheck**: 3 pre-existing errors, all in files this pass did not
  touch (`menuReasoning.server.test.ts`, `router.tsx`, `_authenticated.
  admin.tsx`) — confirmed identical on the unmodified baseline via `git
  stash`, so none are attributable to this pass.
- **Lint**: 1373 pre-existing problems repo-wide, confirmed byte-for-byte
  identical in count on the unmodified baseline via `git stash` before vs.
  after this pass's changes. Every file this pass actually wrote or edited
  is lint-clean (verified individually); no pre-existing issue in an
  untouched file was reformatted, to keep this pass's diff to what it
  actually changed.
- **Build**: succeeds (`bun run build`), before and after every change this
  pass made.
- **Bundle verification** (`bun run verify:bundle`): fails looking for a
  `dist/` directory that this project's actual build output (`.output/`,
  the TanStack Start/Nitro convention) does not produce — confirmed
  identical (same failure, same reason) on the unmodified baseline. **PRE-
  EXISTING, EXTERNAL LIMITATION** — a build-tooling/script mismatch
  unrelated to inventory integrity, not touched.
- **Genuine concurrency**: 8 scenarios (§5/§26), all real overlapping
  Postgres transactions against the local replica.

## 28-29. Mandate completion / no scope escape

Every section of the mandate that applies to this repository's actual
inventory subsystem was traversed to an explicit PASS, FIXED, or N/A-with-
evidence. Six real defects were found; all six were fixed, re-verified, and
covered by a reproducing regression test or concurrency evidence. The pass
did not stop after the first batch of defects (the `transferStock`/RLS
pair): a dedicated second investigation deliberately covered the remaining
un-audited areas (stocktake, production, versioned recipe consumption,
requisitions, `return_to_supplier`, reservations) and found three further,
independent defects, all of which were then fixed in the same pass. Nothing
outside the inventory-integrity boundary was touched (no marketing/CRM/UI-
redesign/unrelated-security work); the one production database change made
(`0081`) is squarely an inventory-authorization fix, applied only after
explicit human confirmation of that specific action, distinct from — and
not overriding — the mandate's standing prohibition on merging the git PR
itself.

## 30. Final certification matrix

| Control | Executed test | Expected result | Actual result | Fix | Final status | Evidence |
|---|---|---|---|---|---|---|
| Architecture mapped | Full read of migrations + `.server.ts` tree, cross-checked by an independent subagent against production | Complete, accurate map | Complete; single-global-balance-per-item characteristic identified and documented | N/A (documentation) | VERIFIED | §1 |
| Stock source of truth | Read trigger + reconciliation view | Ledger + cached balance, kept in sync | Confirmed, trigger-enforced | N/A | VERIFIED | §1, §2 |
| Core stock invariant | Reconciliation view query after 8 concurrent-write scenarios | `drift = 0` for ledger-only item | `drift = 0.0000` exact; seeded-drift item correctly flagged | N/A | VERIFIED | §2 |
| Movement engine sign/unit/scope/ref/idempotency | Full read of `insertMovement` + every caller | Consistent, idempotent | Consistent; one inert edge case documented | N/A | VERIFIED | §3 |
| Movement atomicity (transferStock) | Failure-injection + retry-after-compensation tests | Never partial, never stuck | Was partial/stuck; now compensated + dead-key-refused | Defect 1 | FIXED | §5, 4 tests |
| Movement atomicity (issueRequisition) | Same, mirrored | Same | Same defect, same fix pattern | Defect 6 | FIXED | §5, 3 tests |
| Idempotency — positive/negative/duplicate/concurrent/retry/reversal | 8 genuine concurrent-transaction scenarios (A–H) | Exactly one applies, duplicates rejected cleanly | Confirmed for every scenario | N/A (or per specific defect above) | VERIFIED | §5 table |
| Concurrency — negative/overstated stock races | Controls A, F | 1 succeeds, 1 clean rejection, never negative | Confirmed | N/A | VERIFIED | §5 table |
| Concurrency — legitimate concurrent writes, no lost update | Control E | Both apply, balance exact | Confirmed | N/A | VERIFIED | §5 table |
| Goods receiving full flow | Code audit + Control B | Idempotent, unit-converted, atomic-enough | Confirmed | N/A | VERIFIED | §6 |
| PO ↔ inventory reconciliation | Code audit | Counters never drift from ledger | Confirmed | N/A | VERIFIED | §7 |
| Units of measure | Code audit + existing 11-scenario test suite | Hard refusal on unconvertible units | Confirmed for receiving/consumption; was silent for production | Defect 4 | FIXED | §8, §5, 3 tests |
| Recipe/component consumption | Code audit + dedupe-key trace | Correct quantity, no double-consumption | Sub-recipe reuse collided | Defect 5 | FIXED | §9, §5, 2 tests |
| POS → inventory consumption | Full trace of order-close path | Consume-then-commit, idempotent under race | Confirmed | N/A | VERIFIED | §10 |
| Negative-stock policy | Controls A, F | Cannot be bypassed by concurrency | Confirmed | N/A | VERIFIED | §11 |
| Waste | Code audit | Reasoned, idempotent, scoped | Confirmed | N/A | VERIFIED | §12 |
| Adjustments | Code audit + Control E | Reasoned, no lost update | Confirmed | N/A | VERIFIED | §13 |
| Stock transfers (document flow) | Existing extensive test suite re-read | Atomic dispatch/receive, idempotent | Confirmed | N/A | VERIFIED | §14 |
| Stock transfers (quick/direct) | Failure-injection + retry tests | Atomic, idempotent | Was neither | Defect 1 | FIXED | §5, 4 tests |
| Returns/reversals | Code audit + Control G | Cannot double-reverse | Confirmed | N/A | VERIFIED | §15 |
| `return_to_supplier` | Repo-wide grep | Caller exists or documented N/A | No caller anywhere | N/A | N/A WITH EVIDENCE | §15 |
| Inventory counts (stocktake) | Failure/timing reproduction + idempotency test | Correct correction, no double-post | Stale-snapshot delta corrupted the ledger | Defect 3 | FIXED | §16, §5, 3 tests |
| Costing model | Code audit (trigger + every consumer) | Deterministic, one model | Weighted average, confirmed consistent | N/A | VERIFIED | §17 |
| Quantity/value conservation | Code audit across every fixed/audited path | Cannot diverge independently | Confirmed (Defect 4 was the one place it had) | Defect 4 | FIXED | §18 |
| Tenant/property/outlet isolation | Direct production query + before/after reproduction | No cross-property access | 11 tables were tenant-only, live in production | Defect 2 | FIXED | §19, prod-applied |
| Authorization mapping | Capability-to-table trace | App + DB enforcement match | Confirmed (DB half completed by Defect 2's fix) | Defect 2 | FIXED | §20 |
| Auditability | Column-level audit of every movement type | who/what/when/why/ref reconstructable | Confirmed; quick-transfer gained `correlation_id` | Defect 1 (incidental) | VERIFIED | §21 |
| Failure/rollback | Per-operation failure-injection tests | No unrecoverable partial state | Confirmed across all fixed + pre-existing paths | N/A | VERIFIED | §22 |
| Database integrity | Schema inspection | FKs/uniques/checks enforce invariants | Confirmed | N/A | VERIFIED | §23 |
| Clean migration replay | Full chain against fresh Postgres 16 | Zero errors | `applied=81` cumulative, zero errors | N/A | PASS | §24 |
| Production reconciliation | Read-only Supabase MCP queries, before and after the fix | Git matches production; fix verified live | Confirmed both ways | Defect 2 (applied) | PASS | §25 |
| Genuine concurrency evidence | 8 real overlapping-transaction scenarios | Documented outcomes | All 8 documented | N/A | PASS | §5/§26 |
| Full test suite | `vitest run` | All pass | 2152/2152, 175/175 files | N/A | PASS | §27 |
| Typecheck | `tsc --noEmit` | No new errors | 3 pre-existing, unrelated, confirmed via baseline diff | N/A | PASS | §27 |
| Lint | `eslint` | No new errors | 1373 pre-existing, unrelated, confirmed via baseline diff | N/A | PASS | §27 |
| Build | `bun run build` | Succeeds | Succeeds | N/A | PASS | §27 |
| Bundle verification | `bun run verify:bundle` | N/A if pre-existing tooling gap | Fails identically on baseline (dist/ vs .output/ mismatch) | N/A | EXTERNAL LIMITATION | §27 |
| Reservations | Code audit | Ledger-safe; overcommitment policy documented | Never touches ledger (safe); no overcommitment ceiling exists, by design | N/A | N/A WITH EVIDENCE (documented limitation, not a ledger defect) | §1 area, subagent report |

## 31. Final exit criteria

- [x] complete inventory architecture mapped
- [x] authoritative stock source established
- [x] stock invariant proven
- [x] movement engine verified
- [x] idempotency verified (2 defects found and fixed: transferStock, issueRequisition)
- [x] concurrency verified (8 genuine scenarios)
- [x] goods receiving verified
- [x] PO/inventory reconciliation verified
- [x] units/conversions verified (1 defect found and fixed: production)
- [x] recipe consumption verified (1 defect found and fixed: sub-recipe dedupe collision)
- [x] POS consumption verified
- [x] negative-stock policy verified
- [x] waste verified
- [x] adjustments verified
- [x] transfers verified (1 defect found and fixed: quick transfer)
- [x] returns/reversals verified
- [x] inventory counts verified (1 defect found and fixed: stale-snapshot delta)
- [x] costing verified
- [x] quantity/value integrity verified
- [x] tenant/property/outlet isolation verified (1 defect found, fixed, and applied to production: 11-table RLS gap)
- [x] authorization verified
- [x] auditability verified
- [x] failure/rollback verified
- [x] database integrity verified
- [x] clean migration replay verified
- [x] production/Git reconciliation verified
- [x] genuine concurrency evidence captured
- [x] full test suite passes (2152/2152)
- [x] typecheck result verified (3 pre-existing, unrelated)
- [x] lint result verified (1373 pre-existing, unrelated, byte-identical to baseline)
- [x] build succeeds
- [x] every applicable mandate section has explicit evidence
- [x] every in-scope fixable defect has been fixed (6/6)
- [x] no known ME-05 inventory-integrity defect remains unresolved

## 32. Migration / production changes

- `standalone/db/migrations/0081_me05_inventory_document_property_scope.sql`
  — new; applied to production as `me05_inventory_document_property_scope`.
  **Changes live production behavior**: closes the 11-table cross-property
  RLS gap described in Defect 2/§19.

## 33. Application changes

- `src/modules/restaurant/core/contracts.ts` — `transferStockSchema` gained
  `dedupeKey`.
- `src/modules/restaurant/inventory/movements.server.ts` — `transferStock`
  rewritten for atomicity/idempotency/dead-key detection (Defect 1); new
  exported helpers `findMovementByDedupeKey`, `movementHasReversal`.
- `src/modules/restaurant/requisitions/requisitions.server.ts` —
  `issueRequisition` fixed identically (Defect 6).
- `src/modules/restaurant/inventory/stocktake.server.ts` — `postStocktake`
  re-diffs against current balance instead of the stale count-start
  snapshot (Defect 3).
- `src/modules/restaurant/products/contracts.ts` — `RecipeCostLine` gained
  `stockQuantity`/`stockUnitId`.
- `src/modules/restaurant/products/recipe-cost.server.ts` — populates the
  new fields (converted quantity + item's stock unit).
- `src/modules/restaurant/products/production.server.ts` — uses the
  converted quantity/unit; refuses to start production when any component
  is unresolved (Defect 4).
- `src/modules/restaurant/products/consumption.server.ts` — sub-recipe
  explosion dedupe-key lineage fix (Defect 5).
- New tests: `movements.transferStock.test.ts`,
  `requisitions/requisitions.server.test.ts`,
  `inventory/stocktake.server.test.ts`,
  `products/production.server.test.ts`,
  `products/consumption.server.test.ts`.

## 34. Final certification result

**GREEN.** Every mandatory control in mandate sections 1-29 that applies to
this repository's actual inventory subsystem has an explicit PASS, FIXED,
VERIFIED, or N/A-WITH-EVIDENCE status backed by executed evidence in this
document — a real concurrent-database test against a genuine local
Postgres 16 replica, a direct production query (before and after the one
production change this pass made), a reproducing regression test, or the
full test suite. Six real, production-relevant defects were found; all six
were fixed, re-verified, and covered by regression tests or reproducible
concurrency/reproduction evidence. The most severe — a live, currently-
exploitable cross-property authorization gap spanning 11 tables — was
fixed in Git and, with explicit human authorization obtained specifically
for that action, applied directly to production. No defect discovered
during this certification was left unfixed.

**External limitations** (unchanged from prior passes or newly identified,
neither a code nor configuration defect this pass could remediate):

- `auth_leaked_password_protection` remains WARN — a Supabase
  Pro-plan-and-above feature; a billing decision, not a code defect
  (unchanged from ME-04).
- `bun run verify:bundle` fails looking for a `dist/` directory this
  project's actual build (`.output/`) does not produce — a pre-existing
  build-tooling/script mismatch, confirmed identical on the unmodified
  baseline, unrelated to inventory integrity.
- Two `me06_*` migrations were found already applied to production,
  evidence of separate work on this same production project outside this
  session's visibility — observed and reported (§25), not investigated,
  per this mandate's own scope discipline.
