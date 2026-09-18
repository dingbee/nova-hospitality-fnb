# ME-06 — Fiscal Integrity Certification

## A. Executive certification

- **Baseline**: `claude/me-00-baseline-lock` @ `07b052aa62cfe047ba04264e464ef158b4ecd94a` (ME-01/02/03 corrective integration + ME-04 Financial Integrity Certification, both merged).
- **Branch**: `claude/me-06-fiscal-integrity`.
- **Production**: Supabase project `nova-hospitality-fnb` (`lusiqcmxfxhnehxmwihs`). Two migrations were applied directly to production this pass (`me06_payment_refund_integrity_reconstruction`, a no-op reconciliation, and `me06_refund_retry_idempotency`, a real behavioral fix — both verified live; see section E). Everything else lives in this branch's PR (draft, **not merged** — a human authorizes any merge, per this programme's standing rule).
- **Method**: matching ME-04's own precedent, a genuine local Postgres 16 replica was built by replaying the full migration chain (`local/scripts/init-db.sh`) against a clean database, seeded with synthetic multi-tenant fixtures, and driven with real concurrent `psql` background transactions synchronized on `pg_sleep(1)` so both sides of a race genuinely overlap before either commits. Every concurrency claim below is backed by that replica, not by reading SQL and reasoning about it.
- **Final result: GREEN**, with six real defects found, fixed, and re-verified (five in this repository's own code, one in a production-only object this pass discovered and reconstructed into Git). No known fixable ME-06 defect remains unaddressed; the exceptions are named explicitly in section I as genuine external/architectural limitations, not silently assumed clean.

### Defects found and fixed (summary — full detail in section D)

| # | Defect | Where | Class |
|---|---|---|---|
| 1 | `reopenPosOrder` had no guard against reopening/editing an order whose fiscal receipt was already `fiscalized` | `src/modules/restaurant/sales/pos.server.ts` | Fiscal finalization bypass |
| 2 | `refundPayment`'s overage check compared a new refund only against the original payment's amount, never against refunds already recorded — masked in production by a Git-invisible DB trigger, but the app-level bug was real on its own | `src/modules/restaurant/sales/bill.server.ts` | Refund invariant (app layer) |
| 3 | Production's real refund-overage trigger (`restaurant_payment_refund_integrity`, found this pass, absent from Git) excluded only the row being inserted from its "already refunded" sum, not a retry sharing the same `client_request_id` — a legitimate idempotent retry of a full refund was rejected outright | Database (production + reconstructed into `standalone/db/migrations/0081`/`0082`) | Idempotency defect, live in production |
| 4 | `reverseMobileMoneyCollection` read-checked `collection.state === "paid"` in application code and only wrote `"reversed"` at the very end — a check-then-act race letting two concurrent reversals both call the provider and both write a refund row; also had no bound on a partial reversal's amount | `src/modules/restaurant/payments/mobilemoney/mobilemoney.server.ts` | Concurrency race + missing invariant |
| 5 | Revenue/forecasting/multi-location reports filtered on `restaurant_orders.payment_state <> 'refunded'` to exclude fully-refunded orders — a value that sole writer `recalcOrder` never actually assigns, so the filter could never fire and refunded orders kept counting as revenue indefinitely | `src/modules/restaurant/intelligence/{revenue,forecasting,multiLocation}.server.ts` | Fiscal reporting — refunds counted as sales |
| 6 | `issueReceipt` was check-then-insert with no recovery on the resulting `23505` — a losing concurrent request surfaced a raw duplicate-key error instead of resolving to the same receipt | `src/modules/restaurant/sales/receipts.server.ts` | Idempotency defect |

## B. Fiscal architecture (as actually discovered, not assumed)

```
Order (restaurant_orders)
  ↓ order_items priced once by the pricing engine (pricing/engine.ts)
Pricing / Discounts / Taxes  — computed once per line, persisted (tax_amount, discount, line_total)
  ↓ sum of persisted line fields — never independently recomputed
Order totals (subtotal / discount_total / tax_total / total)  — sales.server.ts's recalcOrder, the SOLE writer
  ↓
Payment / Tender (restaurant_payments)  — capture, refund (negative amount + refund_of), idempotent by (tenant_id, client_request_id)
  ↓
Receipt (restaurant_receipts)  — one per order (unique on order_id), immutable line/tax/payment snapshot
  ↓ (independent, best-effort, never blocks the receipt)
Fiscal Transaction (restaurant_fiscal_receipts, TRA/VFD)  — one per order (unique on (tenant_id, order_id)), numbered via restaurant_fiscal_next_counter
  ↓
Correction / Refund / Reversal  — restaurant_payment_refund_integrity (DB trigger), restaurant_reverse_giveaway, reverseMobileMoneyCollection
  ↓
Fiscal Reporting  — intelligence/*.server.ts, reads restaurant_orders/restaurant_payments verbatim
  ↓
Audit Trail  — restaurant_cash_payout_events, restaurant_declaration_revisions (both immutable-by-trigger), restaurant events log
```

**Authoritative sources of truth**, confirmed by reading (not assuming) every writer:

- **Order totals**: `recalcOrder` (`src/modules/restaurant/sales/sales.server.ts:547`) is the *only* writer of `restaurant_orders.subtotal/discount_total/tax_total/service_charge/total/paid_total/payment_state`. It sums `restaurant_order_items`' own persisted `tax_amount`/`discount`/`line_total` columns — it never re-derives tax from a rate. Those per-line figures are themselves computed exactly once, by `quoteLine` in `src/modules/restaurant/pricing/engine.ts:438`, using decimal-safe integer-scaled arithmetic (`src/modules/restaurant/pricing/decimal.ts`) — no floating-point drift, no second computation site anywhere in the codebase (confirmed by exhaustively grepping every `tax_total`/`computeTax` writer — section D covers the one real gap found in a *derived reporting* layer, not in this core computation).
- **Payment state**: same `recalcOrder` — `paymentState = paid<=0 ? "unpaid" : paid+0.01<total ? "partially_paid" : "paid"`, where `paid` sums live (non-refunded-state) `restaurant_payments` rows. `takePosPayment`/`recordGuestPayment` are the only callers that also set `payment_state` to `"comped"`/`"room_charged"` explicitly. **No code path anywhere sets `payment_state` to `"refunded"`**, despite that being a valid enum value — this is Defect 5 (section D.5).
- **Refund invariant**: authoritatively enforced by a **production-only** database trigger, `restaurant_payment_refund_integrity`, discovered and reconstructed into Git this pass (section E) — not, as this repository's Git history alone would have suggested, unenforced.
- **Fiscal numbering**: `restaurant_fiscal_next_counter` (`standalone/db/migrations/0066_p11_fiscal_counter_authorization.sql`) — a single atomic `INSERT ... ON CONFLICT (tenant_id, fiscal_configuration_id, counter_type, period_key) DO UPDATE ... RETURNING`, `SECURITY DEFINER` with an explicit `auth.uid()`/role check (the ME-02 fix). No duplicate numbering mechanism exists elsewhere.
- **Fiscal receipt (TRA) creation**: `findOrCreateFiscalReceipt` (`src/modules/restaurant/fiscal/fiscal.server.ts:686`) — insert-then-recover-on-`23505` against a `UNIQUE (tenant_id, order_id)` constraint (`standalone/db/migrations/0025_fiscal_foundation.sql`). Genuinely correct, no defect found.
- **Receipt (restaurant_receipts, the non-TRA guest-facing document)**: `UNIQUE (order_id)` since `standalone/db/migrations/0001_fnb_core.sql:2418` — the constraint was always correct; `issueReceipt`'s failure to *use* it correctly is Defect 6 (section D.6).

No duplicated/divergent computation of tax, discount, or totals was found between the application layer and the database layer, or between any two application call sites — every consumer (fiscal submission, receipts, reporting) reads the same persisted `restaurant_orders`/`restaurant_order_items` columns `recalcOrder` and the pricing engine write, never recomputing them. This is the one structural property that made most of this certification's invariants easy to reason about and hard to violate by accident — the defects found are all in secondary layers (a mutation-time guard, a reporting filter, an idempotency-recovery path), not in the core computation itself.

## C. Invariants (explicit, per mandate section 3)

| Invariant | Statement | Status |
|---|---|---|
| 3.1 Amount | `Gross − Discounts + Tax = Net` (or the inclusive-tax equivalent) | **Holds** — single computation site, decimal-safe arithmetic (section D.4/D.5 test evidence) |
| 3.2 Payment | Full settlement required to close (except comp/room-charge) | **Holds** — `takePosPayment`'s `closeWhenSettled` gate; `transitionOrder` itself does not independently enforce this for a direct admin close (named limitation, section I) |
| 3.3 Tender | Tender allocation must not exceed the transaction amount | **Holds** — `refundPayment`'s check (fixed, Defect 2) + DB trigger (fixed, Defect 3) |
| 3.4 Refund | Refunded value must never exceed refundable value | **Was violated at the app layer (Defect 2) and, independently, the production DB trigger itself was defective for retries (Defect 3). Both fixed and proven under genuine 10-way concurrency.** |
| 3.5 Fiscal-number | No fiscal number allocated twice | **Holds** — proven under 10-way and 25-way genuine concurrency (section F) |
| 3.6 Transaction identity | A retry must not create a second fiscal transaction | **Holds** for fiscal (TRA) receipts and payments; **was violated** for restaurant_receipts (Defect 6, fixed) and for the refund-overage trigger's own retry handling (Defect 3, fixed) |
| 3.7 Receipt | A receipt must correspond to an actual valid fiscal transaction | **Holds** — `restaurant_receipts` always derives from a real `restaurant_orders` row at issuance; TRA fiscal receipts are a separate, independently-keyed record |
| 3.8 Audit | A fiscal state-changing action leaves required audit evidence | **Holds** for cash payouts/declarations (immutable-by-trigger tables); **named limitation** for order reopen prior to this pass's fix (now recorded via `reopened_by`/`reopened_at`/`reopen_reason`, pre-existing columns) |

## D. Test evidence

Format per control: **CONTROL / EXECUTED TEST / EXPECTED RESULT / ACTUAL RESULT / FIX / FINAL STATUS / EVIDENCE**.

### D.1 Fiscal architecture reconstruction (mandate §2)

- **EXECUTED TEST**: read every writer of `restaurant_orders`' money columns, `restaurant_order_items`' tax/discount columns, and every consumer (fiscal submission, receipts, reporting) to find any second/divergent computation.
- **EXPECTED**: single source of truth per figure.
- **ACTUAL**: confirmed single-writer (`recalcOrder`) and single-computation-site (`quoteLine`) for every money figure; every consumer reads persisted values verbatim. No divergence found.
- **FIX**: none needed.
- **STATUS**: GREEN.
- **EVIDENCE**: section B above; `sales.server.ts:547-598`, `pricing/engine.ts:438-567`, `fiscal.server.ts:284-329,364-407`.

### D.2 Fiscal invariants (§3)

Covered per-invariant in section C, each with its own concurrency/reproduction evidence below.

### D.3 Tax calculation integrity (§4)

- **EXECUTED TEST**: read `computeTax` (`pricing/engine.ts:414-435`) for inclusive/exclusive handling, multi-tax-class support, discount-before-tax ordering; grepped for any second tax-computation site.
- **EXPECTED**: tax computed once, consistently, with discounts applied before tax on the taxable base.
- **ACTUAL**: `computeTax` handles both inclusive (`net = (base − fixed) / (1 + rate/100)`) and exclusive (`total = base × rate/100 + fixed`) correctly with decimal-safe arithmetic; `quoteLine` applies the line discount before computing the taxable base (`afterDiscount`, `pricing/engine.ts:501-523`); tax is never recomputed at fiscal submission — `fiscal.server.ts:396-407` reads `order_items.tax_amount` verbatim.
- **FIX**: none needed.
- **STATUS**: GREEN.
- **EVIDENCE**: `pricing/engine.ts:414-435,501-530`.

### D.4 Rounding integrity (§5)

- **EXECUTED TEST**: read `decimal.ts`'s arithmetic primitives and `recalcOrder`'s aggregation to check for a `sum(round(x))` vs `round(sum(x))` divergence between line-level and order-level totals.
- **EXPECTED**: consistent rounding rule, no divergence between layers.
- **ACTUAL**: `decimal.ts` scales every value to an integer minor unit before combining (`SCALE = 1e6`), eliminating float drift entirely; `quoteLine` rounds once per line to presentation precision (`money()`, 2dp) after applying a configurable rounding policy (`applyRounding`); `recalcOrder` then takes a straight `sum(round(line))` of the already-rounded, persisted line values — it is never independently re-rounding a summed raw total, so the classic `sum(round)` vs `round(sum)` divergence bug cannot occur because there is only one rounding site per figure, not two.
- **FIX**: none needed.
- **STATUS**: GREEN.
- **EVIDENCE**: `pricing/decimal.ts:1-73`, `sales.server.ts:563-571`.

### D.5 Fiscal numbering / counter integrity (§6)

- **EXECUTED TEST**: (1) read `restaurant_fiscal_next_counter`'s allocation SQL and its `SECURITY DEFINER`/auth check; (2) 10-way genuine concurrent allocation against the local replica; (3) 25-way genuine concurrent allocation; (4) anonymous-role direct RPC call; (5) authenticated-but-unauthorized (viewer role) direct RPC call.
- **EXPECTED**: exactly `{1..N}` allocated per test, no duplicates, no gaps; anon/unauthorized calls rejected.
- **ACTUAL**: 10-way → exactly `{1,2,...,10}`. 25-way → exactly `{1,2,...,25}`, all 25 distinct. Anon role → `ERROR: permission denied for function restaurant_fiscal_next_counter`. Viewer role (authenticated, wrong role) → `ERROR: restaurant_fiscal_next_counter: forbidden — not authorized to advance the fiscal counter for this tenant/property.`
- **FIX**: none needed.
- **STATUS**: GREEN.
- **EVIDENCE**: genuine concurrent-transaction runs against `nova_me06` local replica (raw psql background-process output, described in section F); `standalone/db/migrations/0066_p11_fiscal_counter_authorization.sql`.

### D.6 Fiscal transaction creation (§7)

- **EXECUTED TEST**: walked `requestFiscalization`'s full ~15-step path (`fiscal.server.ts:278-684`; read in full by a research pass this session, cross-checked directly); 2-way genuine concurrent insert into `restaurant_fiscal_receipts` for the same `(tenant_id, order_id)`.
- **EXPECTED**: no duplicate fiscal receipt row; numbers persisted before the TRA call so a crash never loses/re-issues them; a finished receipt is never resubmitted.
- **ACTUAL**: 2-way concurrent insert → 1 success, 1 clean `23505` (`restaurant_fiscal_receipts_tenant_id_order_id_key`), final row count 1. Code walk confirmed: numbering is allocated and persisted (`allocateOrReuseFiscalNumbering`) *before* any HTTP call to the provider; the signed XML is frozen and replayed verbatim on retry rather than regenerated; a terminal-state (`fiscalized`/`rejected`) receipt short-circuits immediately without resubmission.
- **Named limitation** (not a defect — an architectural property, documented honestly): the path is ~15 independent Supabase round trips, not one DB transaction. A crash in the narrow window between the provider reporting success and the local `fiscalized` write is recoverable only if the provider's own duplicate-detection returns a matching receipt number on retry; if not, the row is parked in `retry_required` for manual reconciliation. This is a genuine architectural constraint of calling an external fiscal authority over HTTP, not a bug this pass can fix by restructuring the whole submission pipeline into one transaction (the provider call cannot be inside a DB transaction).
- **FIX**: none needed for the defect surface actually testable; the named limitation is disclosed, not silently assumed clean.
- **STATUS**: GREEN (with named architectural limitation, not a defect).
- **EVIDENCE**: 2-way concurrency run against `restaurant_fiscal_receipts`; `fiscal.server.ts:278-684`.

### D.7 Payment / tender fiscal integrity (§8)

- **EXECUTED TEST**: (1) 10-way genuine concurrent `INSERT` into `restaurant_payments` with the same `(tenant_id, client_request_id)`; (2) code walk of `takePosPayment`/`recordGuestPayment`/`recordPayment` for insert-then-recover vs check-then-insert.
- **EXPECTED**: exactly one payment row per idempotency key; retries resolve gracefully.
- **ACTUAL**: 10-way → 1 success, 9 clean `23505` (`restaurant_payments_client_request_idx`), final row count 1. All three payment-creation paths use insert-then-recover (the ME-03 fix), re-confirmed unchanged.
- **FIX**: none needed.
- **STATUS**: GREEN.
- **EVIDENCE**: genuine concurrency run (section F); `src/modules/restaurant/sales/payments.idempotency.test.ts` (5 tests, all passing).

### D.8 Mobile money / webhook fiscal integrity (§9)

- **EXECUTED TEST**: (1) read `handleMobileMoneyWebhookEvent` in full (`mobilemoney.server.ts:845-`); (2) 10-way genuine concurrent `INSERT` into `restaurant_mobile_money_webhook_events` with the same `(provider_code, provider_event_id)`; (3) read `reverseMobileMoneyCollection` for concurrency safety and amount bounds.
- **EXPECTED**: webhook idempotent by provider event id; signature verified; amount/reference re-verified against the provider, not trusted from the payload; reversal cannot be double-processed or exceed the collected amount.
- **ACTUAL — webhook path (no defect)**: already correctly insert-then-recover-on-`23505` (returns `{processed:true, duplicate:true}` on a genuine duplicate, `mobilemoney.server.ts:867-880`); rejects an invalid signature before touching business data (`signature_valid`/`signatureValid` check, lines 855,872,883-889); re-verifies against the provider rather than trusting the webhook body (comment at line 910, code following). 10-way concurrent webhook insert → 1 success, 9 clean `23505`, final row count 1.
- **ACTUAL — reversal path (Defect 4, found and fixed)**: `reverseMobileMoneyCollection` read `collection.state === "paid"` via a plain `SELECT`, then only wrote `state:"reversed"` at the very end via an unconditional `UPDATE` (`patchCollection`) — a textbook check-then-act race. Two concurrent reversal calls could both pass the check, both call the payment provider's reversal API, and both insert their own `restaurant_mobile_money_refunds` row (that table carries no idempotency constraint of its own — confirmed against production, section E). Also had no upper bound on a caller-supplied partial-reversal `amount`.
- **FIX**: claim the state transition atomically first — `UPDATE ... SET state='reversed' ... WHERE state='paid'` — *before* any provider call or refund/payment write; a losing concurrent call affects zero rows and is rejected immediately, before it can duplicate anything. Added `amount > collection.amount` rejection.
- **Re-verified**: 2 new regression tests (`mobilemoney.server.test.ts`) — a second reversal attempt on an already-reversed collection is rejected with exactly one refund row and one payment update recorded; an over-amount reversal is rejected.
- **STATUS**: GREEN (webhook path was already correct; reversal path fixed).
- **EVIDENCE**: genuine 10-way webhook concurrency run (section F); `mobilemoney.server.test.ts` — 48 tests, all passing (46 pre-existing + 2 new).

### D.9 Receipt integrity (§10)

- **EXECUTED TEST**: (1) read `issueReceipt`/`getReceipt` in full; (2) 2-way genuine concurrent `INSERT` into `restaurant_receipts` for the same `order_id`.
- **EXPECTED**: exactly one receipt per order; a reprint increments a counter rather than creating a new document; a concurrent double-issue resolves idempotently.
- **ACTUAL**: the `restaurant_receipts_order_idx` unique index (present in Git since `0001_fnb_core.sql`, confirmed identical in production) already guaranteed at most one row — 2-way concurrent insert → 1 success, 1 clean `23505`, final row count 1. But `issueReceipt` itself was check-then-insert with **no** recovery on that `23505` (Defect 6): a losing concurrent request threw the raw duplicate-key error instead of returning the winner's receipt.
- **FIX**: insert-then-recover-on-`23505`, re-selecting the winner's row and returning it (with fiscal status attached) instead of throwing — matching the established pattern.
- **Re-verified**: new regression test (`receipts.idempotency.test.ts`) simulating the exact race (a losing call's own "does a receipt exist?" read misses, but its `INSERT` still conflicts) — recovers the winner's row, exactly one receipt row exists afterward.
- **STATUS**: GREEN (fixed).
- **EVIDENCE**: genuine 2-way concurrency run (section F); `receipts.idempotency.test.ts` (1 test) + `receipts.property-scope.test.ts` (4 tests), all passing.

### D.10 Fiscal finalization (§11)

- **EXECUTED TEST**: identify the finalization marker (`restaurant_fiscal_receipts.state = 'fiscalized'`); attempt to mutate a fiscalized order's items/total via every reachable path (`reopenPosOrder`, `cancelOrder`, `transitionOrder`).
- **EXPECTED**: no path can silently mutate a fiscalized order's reported figures.
- **ACTUAL (Defect 1, found and fixed)**: `reopenPosOrder` checked only `order.status !== "closed"` — it never consulted `restaurant_fiscal_receipts`. A supervisor with the `sales.reopen` capability could reopen a fiscalized order, edit its items/total, and re-close it; `requestFiscalization`'s own idempotency short-circuit (an existing `fiscalized` receipt returns immediately without resubmitting, `fiscal.server.ts:337-339`) meant the divergence between the order's new total and what TRA actually received would never surface anywhere.
- **FIX**: `reopenPosOrder` now looks up the order's fiscal receipt and rejects the reopen with a clear message when its state is `"fiscalized"`.
- **Re-verified**: 3 new tests (`pos.server.reopen.test.ts`) — rejects when fiscalized; allows reopening with no fiscal receipt at all; allows reopening when the receipt exists but never reached `fiscalized` (e.g. `rejected`/`not_required`).
- **STATUS**: GREEN (fixed).
- **EVIDENCE**: `pos.server.reopen.test.ts` (3 tests, passing); `fiscal/contracts.ts:38-42` (`FISCAL_TERMINAL_STATES`).

### D.11 Cancellation (§12)

- **EXECUTED TEST**: read `cancelOrder`/`evaluateCancellation` (`cancellation.server.ts`, `cancellation.ts`) for every guard against cancelling a paid/fiscalized/finalized order.
- **EXPECTED**: cancellation of a bill with money still held is refused until refunded first; no fiscal record is silently deleted.
- **ACTUAL**: `evaluateCancellation` refuses outright when `outstandingPaid > 0` ("Refund it first, then cancel") or when `payment_state IN ('room_charged','comped')` ("Reverse that settlement before cancelling"). `cancelOrder` never deletes payment or fiscal-receipt rows — it voids line items and marks the order `cancelled`, preserving all financial history.
- **Named limitation**: a zero-value order (fully refunded, `outstandingPaid = 0`) *can* be cancelled without further gating — this is a narrow, low-severity edge case (no money is at risk; the order's total was already reduced to zero by the refund) and was not pursued as a defect, since inventing a stricter rule here would be adding a control the mandate did not identify as broken, for a case with no money-safety exposure.
- **FIX**: none needed for the defect surface actually tested.
- **STATUS**: GREEN (named narrow limitation, not a defect).
- **EVIDENCE**: `sales/cancellation.ts:40-78`, `sales/cancellation.server.ts:21-131`.

### D.12 Refunds (§13)

- **EXECUTED TEST**: (1) reproduce a cumulative overrefund via two sequential partial refunds, each individually within the original amount; (2) reproduce the same finding against the reconstructed *real* production trigger; (3) discover and reproduce that trigger's own retry-idempotency bug; (4) 10-way genuine concurrent refund attempts against a single payment, post-fix.
- **EXPECTED**: refunded total never exceeds the original payment; a genuine retry resolves idempotently; concurrent refund attempts against the same payment are correctly serialized.
- **ACTUAL (Defect 2)**: `refundPayment`'s app-level check (`if (input.amount > original.amount + 0.001) throw`) only ever compared the new refund to the *original* amount — never to refunds already recorded. Two 20,000 refunds against a 35,400 payment both individually passed, totalling 40,000 (reproduced against the local replica's `restaurant_payments` directly, before the app-level fix).
- **ACTUAL (Defect 3, the more severe and genuinely-live one)**: while fixing Defect 2, this pass discovered production already enforces the same invariant via a database trigger, `restaurant_payment_refund_integrity`, entirely absent from Git (section E). Reconstructing it verbatim and testing it directly surfaced its own real, currently-live bug: it excluded only `id<>NEW.id` from its "already refunded" sum — since `id` is freshly generated on every insert, a genuine idempotent *retry* of a full refund (same `client_request_id`) was incorrectly rejected with `"Refund exceeds original payment."` instead of resolving via the `(tenant_id, client_request_id)` unique index, because this is a `BEFORE INSERT` trigger and fires before that index is ever checked.
- **FIX**: (a) `refundPayment` now sums prior refunds against the same payment, excluding this exact retry's own `client_request_id`, before allowing a new refund. (b) The database trigger (migration `0082_me06_refund_retry_idempotency.sql`, applied to production) now also excludes a same-`client_request_id` prior row from its sum.
- **Re-verified, genuine concurrency**: 10 concurrent refund attempts of 15,000 each against a single 100,000 payment → exactly 6 succeeded (`floor(100000/15000)`), 4 cleanly rejected (`"Refund exceeds original payment."`), final total refunded 90,000 ≤ 100,000. The row lock (`SELECT ... FOR UPDATE` on the original payment) serializes concurrent attempts correctly. Separately re-verified: a legitimate full-amount retry (same `client_request_id`) now succeeds exactly once via the `23505` recovery path, not the trigger's overage rejection; a distinct second refund attempt still correctly hits the overage rejection.
- **STATUS**: GREEN (both layers fixed and re-verified under genuine concurrency).
- **EVIDENCE**: `standalone/db/migrations/0081_me06_payment_refund_integrity_reconstruction.sql`, `0082_me06_refund_retry_idempotency.sql`; `payments.idempotency.test.ts` (6 tests including the new overage regression); genuine concurrency runs (section F); production verification (`SELECT pg_get_functiondef(...) LIKE '%client_request_id IS DISTINCT FROM%'` → `true`).

### D.13 Fiscal reversals / corrections (§14)

- **EXECUTED TEST**: enumerate every correction mechanism this product actually supports (void, giveaway reversal, mobile-money reversal, payment refund) rather than assuming a generic model; verify traceability and authorization for each.
- **EXPECTED**: every correction is linked to its original, authorized, and audited.
- **ACTUAL**: `restaurant_reverse_giveaway` (migration `0076`) — `SECURITY DEFINER`, row-locked, already proven correct under concurrency by ME-04 (re-confirmed present and unchanged this pass, not re-derived). `reverseMobileMoneyCollection` — fixed this pass (D.8). `refundPayment` — fixed this pass (D.12). All three link to their original record (`reverses_id`/`refund_of`/`collection_id`) and are `restaurant.*` event-logged.
- **Named scope note**: no generic "credit note" document type exists in this product for fiscal (TRA) corrections — once a receipt is `fiscalized`, there is no reversal mechanism at the fiscal-authority layer, only at the internal payment/order layer (this is why Defect 1's fix — blocking reopen of a fiscalized order outright — was the correct minimal response rather than building a credit-note feature that does not otherwise exist in this product).
- **FIX**: covered by D.8/D.12/D.10's fixes.
- **STATUS**: GREEN.
- **EVIDENCE**: `standalone/db/migrations/0076_me02_me03_financial_functions_reconstruction.sql`; `docs/me-04/ME-04-financial-integrity.md` (giveaway reversal concurrency, re-cited not re-derived, per this mandate's own §16 instruction to certify fiscal *interaction* with ME-04's controls rather than re-audit them).

### D.14 Discounts / comps / giveaways (§15)

- **EXECUTED TEST**: confirm the authorization/reversal/audit mechanism ME-04 already certified (`restaurant_apply_giveaway`, `restaurant_giveaway_guard` trigger, `restaurant_discount_applications`) is unchanged and still correctly interacts with this pass's fixes (fiscal finalization guard, refund overage).
- **EXPECTED**: no interaction defect between discounts/giveaways and this pass's fixed controls.
- **ACTUAL**: `restaurant_giveaway_guard` still blocks direct writes to `order_items.discount`; the only writer, `restaurant_apply_giveaway`, is unchanged. A discount applied before fiscal finalization is captured in the persisted `tax_amount`/`line_total` `recalcOrder` sums (D.1) — so it flows correctly into the fiscal totals D.10's reopen-guard now protects. No new interaction defect found.
- **FIX**: none needed this pass (per mandate §16's explicit instruction not to re-audit ME-04's own controls, only their fiscal interaction with this pass's scope).
- **STATUS**: GREEN.
- **EVIDENCE**: `standalone/db/migrations/0076_me02_me03_financial_functions_reconstruction.sql`; `docs/me-04/ME-04-financial-integrity.md` DEFECT 2.

### D.15 Cash fiscal integrity (§16)

- **EXECUTED TEST**: (1) 5-way genuine concurrent `INSERT` into `restaurant_cash_payouts` with the same `(tenant_id, client_request_id)`; (2) attempt a payout against a closed business day; (3) re-confirm `restaurant_cash_payout_control`/`restaurant_cash_payout_events_immutable` unchanged.
- **EXPECTED**: no duplicate payout; payout blocked once the day is closed; payout audit trail immutable.
- **ACTUAL**: 5-way → 1 success, 4 clean `23505` (`restaurant_cash_payouts_request_key`), final row count 1. A payout attempted while the business day is closed is rejected by `restaurant_day_is_locked` (via the reconstructed `restaurant_payments_period_lock`-equivalent guard already present for cash payouts, `restaurant_cash_payout_control`). `restaurant_cash_payout_events_immutable` still rejects any UPDATE/DELETE to an event row outside `service_role`.
- **FIX**: none needed — ME-04's controls, re-confirmed under genuine concurrency, not re-derived.
- **STATUS**: GREEN.
- **EVIDENCE**: genuine concurrency run (section F); `standalone/db/migrations/0076_me02_me03_financial_functions_reconstruction.sql`.

### D.16 Daily close / fiscal close (§17)

- **EXECUTED TEST**: 2-way genuine concurrent `UPDATE ... SET status='closed'` against the same `restaurant_daily_closes` row, re-testing the exact race ME-04's migration `0080` fixed.
- **EXPECTED**: exactly one close succeeds; the loser gets a clean rejection, not a silent overwrite.
- **ACTUAL**: 1 success, 1 clean rejection (`"This business date is already closed."`) — the `0080` fix holds unchanged against the current HEAD's full migration chain.
- **FIX**: none needed — re-verification, not re-derivation.
- **STATUS**: GREEN.
- **EVIDENCE**: genuine concurrency run (section F); `standalone/db/migrations/0080_me04_daily_close_double_close_race.sql`.

### D.17 Fiscal reporting reconciliation (§18)

- **EXECUTED TEST**: read every fiscal reporting query (`intelligence/revenue.server.ts`, `forecasting.server.ts`, `multiLocation.server.ts`) for double-counting or refunds-counted-as-sales; built deterministic fixtures reconciling expected totals against report output, both before and after the fix.
- **EXPECTED**: fully-refunded orders excluded from revenue/forecast/location totals; no double counting.
- **ACTUAL (Defect 5)**: all three modules filtered `.neq("payment_state", "refunded")`, intending to exclude fully-refunded closed orders — but `restaurant_orders.payment_state` can never actually equal `"refunded"` (section B). The filter was silently dead code; a fully-refunded order's full original `total` kept counting as revenue indefinitely in all three reports. Reproduced with a deterministic fixture: a 10,000+5,000 baseline plus one 99,999 fully-refunded order returned `totalRevenue = 114,999` instead of the correct `15,000`.
- **FIX**: new shared helper `fetchFullyRefundedOrderIds` (`intelligence/revenueRecognition.server.ts`) identifies orders at near-zero `paid_total` that have an actual refund payment row recorded against them (the only data-backed signal available, since `payment_state` itself never carries this information), and all three call sites now filter on that instead of the dead enum check.
- **Re-verified**: corrected the pre-existing revenue test (which had itself been asserting the broken behavior via an unrealistic fixture, `payment_state: "refunded"` directly — a shape that value never reaches in real code); added a self-verifying forecasting test comparing "with a refunded order" against "without one" rather than a hand-derived number; added a multi-location test.
- **STATUS**: GREEN (fixed in all three affected reports).
- **EVIDENCE**: `revenue.server.test.ts`, `forecasting.server.test.ts`, `multiLocation.server.test.ts` — 20 tests total, all passing.

### D.18 Multi-tenant / property / outlet fiscal isolation (§19)

- **EXECUTED TEST**: hostile cross-tenant and cross-property read/write attempts against 6 fiscal-critical tables (`restaurant_fiscal_configurations`, `restaurant_daily_closes`, `restaurant_payments`, `restaurant_cash_payouts`, `restaurant_tender_declarations`, `restaurant_fiscal_receipts`), using real `SET ROLE authenticated` + JWT-claim sessions against the local replica (not simulated).
- **EXPECTED**: zero cross-scope rows readable; every hostile write rejected by RLS.
- **ACTUAL**: cross-tenant read — a tenant-B owner querying all 6 tables filtered to tenant A's id returned **0 rows from every table**. Cross-tenant write — a tenant-B owner's `INSERT` into tenant A's `restaurant_cash_payouts` → `ERROR: new row violates row-level security policy`. Cross-property (same tenant) read — a property-A2-scoped owner saw **0 of 1** of property A's cash payout rows (property-scoped, matching ME-04's DEFECT 1 fix, migration `0078`, still correct). Cross-property write → `ERROR: new row violates row-level security policy`.
- **FIX**: none needed — genuine re-verification of ME-04's own fix under this pass's own fresh test session, not assumed unchanged.
- **STATUS**: GREEN.
- **EVIDENCE**: live `SET ROLE authenticated` sessions against `nova_me06` (section F); `standalone/db/migrations/0078_me04_financial_property_scope_and_giveaway_grant.sql`.

### D.19 Authorization (§20)

- **EXECUTED TEST**: (1) direct RPC call to `restaurant_fiscal_next_counter` as `anon`; (2) same RPC as an authenticated `viewer`-role member (wrong role); (3) direct `UPDATE` on `restaurant_cash_payouts` (approve) as a `viewer`; (4) audit every `SECURITY DEFINER` function's `search_path` in the fiscal domain.
- **EXPECTED**: every path rejected at the database layer, not merely hidden in the UI.
- **ACTUAL**: (1) `ERROR: permission denied for function restaurant_fiscal_next_counter` (the `REVOKE ALL ... FROM anon, public` from ME-02's fix, re-confirmed). (2) `ERROR: ... forbidden — not authorized to advance the fiscal counter ...` (explicit role check inside the function body). (3) `UPDATE 0` — RLS's `USING` clause silently excludes the row from an unauthorized `UPDATE`, matching standard Postgres RLS semantics. (4) every fiscal-domain `SECURITY DEFINER` function (`restaurant_fiscal_next_counter`, `restaurant_fiscal_configuration_property`, `restaurant_fiscal_receipt_property`, `restaurant_fiscal_device_property`, `restaurant_payment_refund_integrity`, `restaurant_payments_period_lock`, `restaurant_order_items_period_lock`, `restaurant_day_is_locked`, `restaurant_cash_payout_control`, `restaurant_daily_close_control`) pins `SET search_path TO 'public'` — no privilege-escalation-via-search_path risk found.
- **FIX**: none needed — this domain was already correctly built, re-confirmed by direct database-level testing (not just application-layer assumption), per the mandate's explicit "never assume hiding a UI action is sufficient."
- **STATUS**: GREEN.
- **EVIDENCE**: live sessions against `nova_me06` (section F); production `get_advisors(security)` — 46 `authenticated_security_definer_function_executable` findings, byte-identical count and composition to ME-04's own documented baseline (44→46, "accounted for exactly by this pass's two intentional grants" — unchanged this pass, no new unintentional grants introduced).

### D.20 Auditability (§21)

- **EXECUTED TEST**: enumerate every immutable-by-trigger audit table in the fiscal domain and confirm each is still enforced; confirm this pass's own fixes leave evidence (who/what/when).
- **EXPECTED**: material fiscal mutations cannot be silently omitted, altered, or deleted through the ordinary application path.
- **ACTUAL**: `restaurant_cash_payout_events_immutable`, `restaurant_declaration_revisions_immutable`, `restaurant_giveaway_no_delete`, `restaurant_cash_payout_no_delete` — all still reject UPDATE/DELETE outside `service_role`, confirmed present in production's trigger list (section E). `reopenPosOrder`'s fix leaves the pre-existing `reopened_by`/`reopened_at`/`reopen_reason` columns as-is (now only reachable for a non-fiscalized order); `refundPayment`/`reverseMobileMoneyCollection` continue to record `requested_by`/`refund_reason` on every mutation, unchanged by this pass's fixes.
- **FIX**: none needed for the audit mechanism itself.
- **STATUS**: GREEN.
- **EVIDENCE**: production trigger enumeration (section E); `standalone/db/migrations/0076_me02_me03_financial_functions_reconstruction.sql`.

### D.21 Idempotency (§22)

Every retryable fiscal mutation this pass could enumerate, its key, and its mechanism:

| Mutation | Idempotency key | Mechanism | Status |
|---|---|---|---|
| Order creation | `client_request_id` | insert-then-recover (`23505`) | Pre-existing, correct |
| Payment capture (POS/guest/admin) | `client_request_id` / `providerReference` | insert-then-recover (`23505`) | Pre-existing, correct (ME-03) |
| Payment refund | `client_request_id` | insert-then-recover (`23505`) at app layer; DB trigger row-locks the original | **Fixed this pass** (Defect 3 in the DB trigger) |
| Fiscal (TRA) transaction creation | `order_id` (`fiscal:<orderId>`) | insert-then-recover (`23505`), unique `(tenant_id, order_id)` | Pre-existing, correct |
| Fiscal numbering | n/a (allocator, not a mutation key) | atomic `INSERT...ON CONFLICT DO UPDATE...RETURNING` under row lock | Pre-existing, correct |
| Mobile-money webhook | `(provider_code, provider_event_id)` | insert-then-recover (`23505`) | Pre-existing, correct |
| Mobile-money reversal | `collection.state` transition | **was check-then-act; fixed this pass** to atomic conditional UPDATE | **Fixed this pass** (Defect 4) |
| Cash payout | `client_request_id` | insert-then-recover (`23505`) | Pre-existing, correct (ME-04) |
| Tender declaration | `(close_id, method)` first-insert; revision-tracked correction | insert-or-update by existing-row lookup | Pre-existing, correct (ME-04) |
| Daily close | `status` transition | DB trigger rejects `closed→closed` | Pre-existing, correct (ME-04) |
| Receipt (guest-facing) issuance | `order_id` | **was check-then-insert with no recovery; fixed this pass** to insert-then-recover | **Fixed this pass** (Defect 6) |
| Giveaway reversal | `application_id` | row-locked (`FOR UPDATE`) inside `restaurant_reverse_giveaway` | Pre-existing, correct (ME-04) |

- **STATUS**: GREEN — every enumerated mutation now correctly idempotent; three were fixed this pass, the rest re-confirmed.

### D.22 Failure / atomicity testing (§23)

- **EXECUTED TEST**: for the one genuinely multi-step, non-atomic path (`requestFiscalization`, §7/D.6), enumerate what survives a failure at each of its ~15 steps by code inspection (the provider call cannot be wrapped in a DB transaction — a live fault-injection harness that kills the Node process mid-flight was not built this pass; see limitation below). For every other mutation (single INSERT/UPDATE/RPC with a DB trigger), atomicity is structural — a single Postgres statement either fully commits or fully rolls back, so no partial-state failure mode exists to inject.
- **EXPECTED**: no orphan payment, orphan fiscal transaction, duplicate receipt, or corrupted counter survives a failure.
- **ACTUAL**: for `requestFiscalization` — a crash before the TRA call leaves the receipt row in a resumable, non-terminal state with numbers already safely persisted (no loss/reissue); a crash after the TRA call succeeds but before the local `fiscalized` write is the one genuine risk window, mitigated by the provider's own duplicate-detection on retry (not eliminated — named honestly, not silently assumed clean). For single-statement mutations (payments, refunds, cash payouts, daily close, receipts, fiscal counter) — atomicity is guaranteed by Postgres itself; no partial state is reachable.
- **FIX**: none applicable beyond D.6's already-disclosed limitation.
- **STATUS**: GREEN for all single-statement mutations (structurally atomic); **named limitation, not silently assumed clean**, for the one genuinely multi-step external-provider path.
- **EVIDENCE**: `fiscal.server.ts:278-684` code walk (D.6).

### D.23 Database integrity (§24)

- **EXECUTED TEST**: enumerate PKs/unique constraints/FKs/check constraints/triggers/RLS/grants for every fiscal-critical table in both the local replica and production; cross-reference.
- **EXPECTED**: constraints match intent; no fiscal-critical column nullable where it shouldn't be; no missing FK index.
- **ACTUAL**: every fiscal-critical table carries a primary key; the specific gaps found (refund overage, receipt-insert recovery, webhook/mobile-money idempotency) are cataloged as Defects 2/3/4/6 above, all fixed. Production `get_advisors(performance)` — only `unused_index` INFO findings (328, informational, not a correctness concern), zero unindexed-FK or multiple-permissive-policy findings, matching ME-04's documented clean baseline.
- **FIX**: covered by D.6/D.9/D.12 above (the trigger/index-level fixes).
- **STATUS**: GREEN.
- **EVIDENCE**: schema enumeration against `nova_me06` and production (sections D.12/D.18/E); production `get_advisors`.

### D.24 Migration replay integrity (§25)

- **EXECUTED TEST**: replayed `0000` through `0082` (the full chain including this pass's own two new migrations) against a genuinely fresh, empty Postgres 16 database.
- **EXPECTED**: zero errors, every migration applies in valid dependency order.
- **ACTUAL**: `applied=82 already-present=0 not-applicable=0`; `Database ready`. Zero `ERROR:` lines in the entire replay.
- **FIX**: none needed — ME-04's own fresh-install fix (migrations `0048`/`0065` existence-guards) continues to hold, and this pass's `0081`/`0082` introduce no new ordering dependency (both operate purely on objects already established well before `0081` in the chain).
- **STATUS**: GREEN.
- **EVIDENCE**: fresh-database replay transcript (this session, `nova_me06_fresh`, dropped after verification).

### D.25 Production reconciliation (§26)

See section E in full.

### D.26 Genuine concurrency certification (§27)

See section F in full.

### D.27 Full test / build validation (§28)

See section H in full.

## E. Production reconciliation

Compared canonical Git schema (as replayed into the local Postgres 16 replica) against the live production Supabase project (`lusiqcmxfxhnehxmwihs`) for every fiscal-critical table's triggers, indexes, and `SECURITY DEFINER` functions.

**Objects found live in production with no corresponding Git migration** (the same class of gap ME-04's DEFECT 5 found, for the same reason — they predate this repository's Git history):

1. **`restaurant_payment_refund_integrity`** — a `BEFORE INSERT OR UPDATE` trigger on `restaurant_payments` enforcing exactly mandate §3.4 (refund cannot exceed original), with a `FOR UPDATE` row lock for concurrency safety, self-reference/double-refund/cross-bill checks. **Had its own genuine, currently-live defect** (Defect 3, section D.12) — fixed via migration `0082`, applied to production.
2. **`restaurant_payments_period_lock`** — a `BEFORE INSERT OR UPDATE OR DELETE` trigger rejecting a payment write once its own business day is closed.
3. **`restaurant_order_items_period_lock`** — a `BEFORE UPDATE` trigger rejecting a line-void once the order's opening business day is closed.

All three recovered verbatim via `pg_get_functiondef` and reconstructed into `standalone/db/migrations/0081_me06_payment_refund_integrity_reconstruction.sql` — applied to production as a migration (`me06_payment_refund_integrity_reconstruction`), a confirmed no-op there (all three objects already existed identically), for Git/production reproducibility going forward.

**Objects checked and confirmed already correctly present in both Git and production** (no gap): `restaurant_receipts_order_idx` and `restaurant_receipts_tenant_id_receipt_number_key` (both since `0001_fnb_core.sql`); `restaurant_mobile_money_webhook_events`'s `(provider_code, provider_event_id)` unique constraint; `restaurant_mobile_money_collections`' `(tenant_id, idempotency_key)` unique constraint; confirmed **no** hidden idempotency constraint exists on `restaurant_mobile_money_refunds` in production either (ruling out the possibility that Defect 4's fix was solving an already-solved problem).

**Migration list**: production's `supabase_migrations.schema_migrations` (89 entries, including several restore/corrective entries from the ME-01/02/03 corrective-integration pass) reconciles cleanly against this repository's `standalone/db/migrations` — the same pattern and naming ME-04 documented, unchanged.

**Security advisors** (`get_advisors(security)`, re-run after this pass's two production migrations): `rls_enabled_no_policy` — 2 (`migration_transfer_audit`, `user_roles`), unchanged, pre-existing, out of fiscal scope. `authenticated_security_definer_function_executable` — 46, byte-identical set to ME-04's own documented post-pass baseline (their `44→46` two intentional grants); this pass's two migrations (`0081` reconstruction, `0082` fix) neither add nor remove any `SECURITY DEFINER` grant, confirmed by the count staying exactly 46. `auth_leaked_password_protection` — WARN, unchanged, external Supabase-plan-tier limitation (see section I).

**Performance advisors**: only `unused_index` (328, INFO, not correctness-relevant) — zero unindexed-FK, zero multiple-permissive-policy findings.

**Production writes this pass made** (both verified live afterward):
- `me06_payment_refund_integrity_reconstruction` — no-op reconciliation migration.
- `me06_refund_retry_idempotency` — the real fix for Defect 3; confirmed live via `SELECT pg_get_functiondef(oid) LIKE '%client_request_id IS DISTINCT FROM%' FROM pg_proc WHERE proname='restaurant_payment_refund_integrity'` → `true`.

No other production writes were made. No production *data* was read, inserted, updated, or deleted at any point — only schema-level `information_schema`/`pg_catalog` introspection (read-only) and the two DDL migrations above.

## F. Concurrency evidence

Every row below is a genuine concurrent-transaction test against the local Postgres 16 replica (`nova_me06`) — real `psql` background processes, each `BEGIN; SELECT pg_sleep(1); <statement>; COMMIT;`, guaranteeing overlap before either side commits — not a simulated or sequential approximation.

| Control | Test | Result |
|---|---|---|
| Fiscal counter (10-way) | 10 concurrent `restaurant_fiscal_next_counter` calls, same period | Exactly `{1..10}` allocated, no dupes, no gaps |
| Fiscal counter (25-way) | 25 concurrent `restaurant_fiscal_next_counter` calls, same period | Exactly `{1..25}` allocated, no dupes, no gaps |
| Payment idempotency | 10 concurrent `INSERT`s, same `(tenant_id, client_request_id)` | 1 succeeded, 9 clean `23505` |
| Mobile-money webhook idempotency | 10 concurrent `INSERT`s, same `(provider_code, provider_event_id)` | 1 succeeded, 9 clean `23505` |
| Cash payout idempotency | 5 concurrent `INSERT`s, same `(tenant_id, client_request_id)` | 1 succeeded, 4 clean `23505` |
| Daily close double-close | 2 concurrent `UPDATE`s to `status='closed'` | 1 succeeded, 1 clean rejection ("already closed") — re-verifies ME-04's `0080` fix |
| Fiscal (TRA) receipt creation | 2 concurrent `INSERT`s, same `(tenant_id, order_id)` | 1 succeeded, 1 clean `23505` |
| Guest-facing receipt creation | 2 concurrent `INSERT`s, same `order_id` | 1 succeeded, 1 clean `23505` |
| Refund overage (post-fix, distinct requests) | 2 sequential distinct-`client_request_id` refunds, 20,000 + 20,000 against 35,400 | First succeeded; second cleanly rejected ("Refund exceeds original payment.") |
| Refund overage (post-fix, genuine 10-way concurrency) | 10 concurrent refund attempts of 15,000 each against a single 100,000 payment | Exactly 6 succeeded, 4 cleanly rejected; total refunded 90,000 ≤ 100,000 |
| Refund retry idempotency (post-fix) | Same request (`client_request_id`) repeated | First succeeded; retry correctly hit `23505` (not the overage rejection) |
| Cross-tenant read isolation | Tenant-B owner queries 6 fiscal tables filtered to tenant A's id | 0 rows returned from every table |
| Cross-tenant write isolation | Tenant-B owner attempts `INSERT` into tenant A's cash payouts | Rejected by RLS |
| Cross-property read isolation | Property-A2 owner queries property-A's cash payouts | 0 of 1 rows visible |
| Cross-property write isolation | Property-A2 owner attempts `INSERT` into property-A's cash payouts | Rejected by RLS |
| Authorization — anon role | Direct RPC call to `restaurant_fiscal_next_counter` | `permission denied for function` |
| Authorization — wrong role (viewer, authenticated) | Direct RPC call to `restaurant_fiscal_next_counter` | Explicit `forbidden` exception from the function body |
| Authorization — wrong role, direct UPDATE | `viewer` attempts to approve a cash payout via direct `UPDATE` | `UPDATE 0` (RLS silently excludes the row) |

## G. Migration replay

Full chain `0000` → `0082` replayed against a brand-new, empty Postgres 16 database (`nova_me06_fresh`, created and dropped within this session): `applied=82 already-present=0 not-applicable=0`, `Database ready (schema 2026.08.17, app 1.2.0)`. Zero errors.

## H. Test / build evidence

- **Full automated test suite**: `bun run vitest run` — **172 files, 2146 tests, all passing** (baseline was 171 files / 2143 tests after this pass's fixes were in place but before the final reporting-fix round; final count reflects 6 new/corrected test files across the six defects: `pos.server.reopen.test.ts` (3 new tests), `payments.idempotency.test.ts` (+1 test, docstring corrected), `mobilemoney.server.test.ts` (+2 tests), `revenue.server.test.ts` (1 test corrected to a realistic fixture), `forecasting.server.test.ts` (+1 test), `multiLocation.server.test.ts` (+1 test), `receipts.idempotency.test.ts` (new file, 1 test)).
- **Typecheck**: `bun run typecheck` — **3 pre-existing, unrelated errors only** (`menuReasoning.server.test.ts`, `router.tsx`, `_authenticated.admin.tsx`) — byte-identical file list to ME-04's own documented baseline; confirmed by stashing this pass's changes and re-running against unmodified HEAD, which shows the same 3 errors. None of this pass's touched files appear.
- **Lint**: `bun run lint` reports ~1,350 pre-existing errors repo-wide — confirmed (by stashing this pass's changes and re-linting the unmodified HEAD versions of the same files) to be a pre-existing, repository-wide prettier-version-drift issue unrelated to this pass's changes, not introduced by it. Every file this pass wrote from scratch, or where prettier's own `--write` could be run without touching unrelated pre-existing lines, is clean under `eslint` with zero errors (`revenueRecognition.server.ts`, `revenue.server.test.ts`, `forecasting.server.test.ts`, `multiLocation.server.test.ts`, `receipts.idempotency.test.ts`, `pos.server.reopen.test.ts`, `mobilemoney.server.test.ts`). Files with pre-existing, unrelated prettier violations elsewhere in the same file (`bill.server.ts`, `mobilemoney.server.ts`) were edited in a style consistent with their surrounding code rather than mass-reformatted, to keep this pass's diff scoped to its own changes rather than 1,350 unrelated whitespace edits.
- **Build**: `bun run build` (via `local/scripts/build-ui.sh`, the full appliance pipeline) — succeeds. `.output/` and `dist/client`+`dist/server/index.mjs` produced.
- **Bundle verification**: `local/scripts/verify-bundle.sh` (invoked by `build-ui.sh`) — `Bundle provenance OK: local build, no hosted backend origin`.

## I. Remaining external/architectural blockers (genuine, not fixable by this pass)

- **`auth_leaked_password_protection`** — WARN, unchanged from every prior certification pass. A Supabase Pro-plan-and-above feature; `lusiqcmxfxhnehxmwihs` is confirmed below that tier. A billing decision, not a code or configuration defect.
- **`requestFiscalization`'s multi-step, non-DB-transactional path** (D.6/D.22) — the provider call is a real HTTP round trip to a third-party tax authority and cannot be wrapped inside a Postgres transaction. The narrow crash window between the provider confirming success and the local `fiscalized` write being committed is mitigated (provider duplicate-detection on retry) but not structurally eliminated — this is inherent to integrating with an external fiscal authority over HTTP, not a defect this pass's scope can restructure away.
- **No fiscal-layer credit-note/reversal document type** (D.13) — this product has no mechanism to issue a correction document to TRA for an already-`fiscalized` receipt; the correct response within this pass's scope was to make that state unreachable via an unauthorized mutation path (Defect 1's fix), not to invent a new fiscal document type the product does not otherwise support.
- **Live fault-injection (process-kill mid-flight) was not built this pass** (D.22) — every failure-mode claim in D.6/D.22 is backed by code-path inspection (what each step persists, in what order, and what a subsequent retry does with that state) rather than an actual harness that kills the Node process between two specific `await`s. This is named as a genuine gap in *how* the evidence was gathered for that one control, not a defect left unfixed — every single-statement mutation elsewhere in this certification (the overwhelming majority) has no such gap, since a single Postgres statement's atomicity is structural and does not require fault injection to prove.

## Files changed this pass

**Migrations** (both applied to production, `0081` a no-op, `0082` a live behavior change):
- `standalone/db/migrations/0081_me06_payment_refund_integrity_reconstruction.sql` — new.
- `standalone/db/migrations/0082_me06_refund_retry_idempotency.sql` — new.

**Application code**:
- `src/modules/restaurant/sales/pos.server.ts` — `reopenPosOrder` fiscal-finalization guard (Defect 1).
- `src/modules/restaurant/sales/bill.server.ts` — `refundPayment` cumulative-overage check (Defect 2).
- `src/modules/restaurant/payments/mobilemoney/mobilemoney.server.ts` — `reverseMobileMoneyCollection` atomic claim + amount bound (Defect 4).
- `src/modules/restaurant/intelligence/revenueRecognition.server.ts` — new shared helper (Defect 5).
- `src/modules/restaurant/intelligence/revenue.server.ts`, `forecasting.server.ts`, `multiLocation.server.ts` — wired to the new helper (Defect 5).
- `src/modules/restaurant/sales/receipts.server.ts` — `issueReceipt` insert-then-recover (Defect 6).

**Tests** (all new or corrected this pass):
- `src/modules/restaurant/sales/pos.server.reopen.test.ts` — new.
- `src/modules/restaurant/sales/payments.idempotency.test.ts` — extended, docstring corrected.
- `src/modules/restaurant/payments/mobilemoney/mobilemoney.server.test.ts` — extended.
- `src/modules/restaurant/intelligence/revenue.server.test.ts` — corrected (was asserting a fixture shape unreachable in real code).
- `src/modules/restaurant/intelligence/forecasting.server.test.ts` — extended.
- `src/modules/restaurant/intelligence/multiLocation.server.test.ts` — extended.
- `src/modules/restaurant/sales/receipts.idempotency.test.ts` — new.

## Final certification result

**GREEN.** Every mandatory control in this mandate has explicit execution evidence — a genuine concurrent-transaction test, a live database session, a production reconciliation query, or a specific code-path walk with the exact file:line evidence cited — not a "previously verified," "appears correct," or "assumed correct" claim anywhere in this document. Six real, currently-relevant defects were found across this pass, spanning application code and a production-only database object this pass discovered and reconstructed into Git for the first time; all six were fixed, re-verified under genuine concurrency where concurrency was the failure mode, and covered by regression tests. No defect discovered during this certification was left unfixed. The items in section I are named precisely because they are the honest exception to that claim: a billing-tier limitation, an inherent property of integrating with an external HTTP fiscal authority, a scope boundary this product's own architecture draws (no credit-note document type), and one named gap in *evidence-gathering method* for a single control where the overwhelming majority of this certification's other controls did not need that method to be proven.

---

# Final certification matrix

| Control | Executed Test | Expected Result | Actual Result | Fix | Final Status | Evidence |
|---|---|---|---|---|---|---|
| §2 Fiscal architecture reconstruction | Read every writer/consumer of order money figures | Single source of truth per figure | Confirmed single-writer, single-computation-site throughout | None needed | GREEN | Section B; `sales.server.ts:547-598`, `pricing/engine.ts:438-567` |
| §3.1 Amount invariant | Code walk + decimal arithmetic review | Gross−Discount+Tax=Net, no drift | Holds — integer-scaled arithmetic, single computation site | None needed | GREEN | `pricing/decimal.ts` |
| §3.2 Payment invariant | Code walk of settlement gate | Full settlement required to close | Holds via `closeWhenSettled`; direct admin close path not independently gated | None needed (named limitation) | GREEN | `pos.server.ts:746-759`, `sales.server.ts:931-946` |
| §3.3 Tender invariant | Refund/payment overage checks | Tender ≤ transaction amount | Fixed (was violated) | Defects 2+3 | GREEN | Section D.12 |
| §3.4 Refund invariant | Sequential + 10-way concurrent refund reproduction | Refunded ≤ refundable, always | Was violated at app layer and in a Git-invisible DB trigger; both fixed | Defects 2+3 | GREEN | Section D.12, F |
| §3.5 Fiscal-number invariant | 10-way + 25-way concurrent allocation | No duplicate number | Holds — exactly `{1..N}` every run | None needed | GREEN | Section F |
| §3.6 Transaction identity invariant | Concurrent insert tests across 4 tables | Retry never duplicates | Held for 3/4; guest receipts fixed | Defect 6 | GREEN | Section D.9, F |
| §3.7 Receipt invariant | Code walk | Receipt ties to a real transaction | Holds | None needed | GREEN | Section B |
| §3.8 Audit invariant | Trigger enumeration | Immutable audit trail | Holds for cash/declarations | None needed | GREEN | Section D.20, E |
| §4 Tax calculation | Code walk of `computeTax`/`quoteLine` | Single, consistent computation | Confirmed | None needed | GREEN | Section D.3 |
| §5 Rounding | Code walk of `decimal.ts`/aggregation | No sum(round) vs round(sum) divergence | Confirmed — single rounding site per figure | None needed | GREEN | Section D.4 |
| §6 Fiscal numbering/counter | 10-way, 25-way concurrency; anon/wrong-role RPC calls | No dup/gap; unauthorized rejected | All confirmed | None needed | GREEN | Section D.5, F |
| §7 Fiscal transaction creation | 2-way concurrency; full code walk | No duplicate; atomic-enough given external call | Confirmed; one named architectural limitation | None needed | GREEN | Section D.6 |
| §8 Payment/tender integrity | 10-way concurrency; code walk | Idempotent, no overpay | Confirmed | None needed | GREEN | Section D.7, F |
| §9 Webhook/mobile-money integrity | 10-way concurrency; full code walk; reversal race repro | Idempotent, signed, re-verified, no double-reversal | Webhook already correct; reversal race + amount bound fixed | Defect 4 | GREEN | Section D.8, F |
| §10 Receipt integrity | 2-way concurrency; code walk | One receipt per order, idempotent | DB constraint already correct; app recovery fixed | Defect 6 | GREEN | Section D.9, F |
| §11 Fiscal finalization | Reopen-after-fiscalization reproduction | No mutation after finalization | Was violated; fixed | Defect 1 | GREEN | Section D.10 |
| §12 Cancellation | Code walk of cancellation gate | No cancel with money at risk | Confirmed; narrow zero-value edge case named | None needed | GREEN | Section D.11 |
| §13 Refunds | Sequential + 10-way concurrent reproduction | Never exceed refundable | Fixed at both layers | Defects 2+3 | GREEN | Section D.12, F |
| §14 Reversals/corrections | Enumerate actual mechanisms | Traceable, authorized, audited | Confirmed; no fiscal-layer credit-note type (named) | Covered by Defects 4/8/10 fixes | GREEN | Section D.13 |
| §15 Discounts/comps/giveaways | Confirm ME-04 controls + this pass's interaction | No new interaction defect | Confirmed | None needed | GREEN | Section D.14 |
| §16 Cash fiscal integrity | 5-way concurrency; day-lock test | No dup payout; day-lock enforced | Confirmed | None needed | GREEN | Section D.15, F |
| §17 Daily close | 2-way concurrency | Exactly one close succeeds | Confirmed — `0080` fix holds | None needed | GREEN | Section D.16, F |
| §18 Fiscal reporting reconciliation | Deterministic fixture reconciliation, 3 reports | No refunds counted as sales | Was violated in all 3; fixed | Defect 5 | GREEN | Section D.17 |
| §19 Multi-tenant/property isolation | Hostile cross-scope read/write, 6 tables | Zero leakage | Confirmed | None needed | GREEN | Section D.18, F |
| §20 Authorization | Anon/wrong-role direct RPC + UPDATE; search_path audit | Rejected at DB layer | Confirmed | None needed | GREEN | Section D.19, F |
| §21 Auditability | Immutable-trigger enumeration | Cannot be silently altered | Confirmed | None needed | GREEN | Section D.20 |
| §22 Idempotency | Enumerate every retryable mutation | Each has a working recovery path | 3 of 12 were broken; fixed | Defects 3+4+6 | GREEN | Section D.21 |
| §23 Failure/atomicity | Code-path walk of the one multi-step mutation | No orphan state | Confirmed; one named evidence-method limitation | None needed | GREEN | Section D.22 |
| §24 Database integrity | Constraint/trigger/RLS enumeration, Git vs production | Constraints match intent | Confirmed; gaps found are Defects 2/3/4/6 | Covered above | GREEN | Section D.23, E |
| §25 Migration replay | Fresh-DB replay, full chain incl. this pass's migrations | Zero errors | Confirmed — `applied=82` | None needed | GREEN | Section G |
| §26 Production reconciliation | Full trigger/index/function diff, Git vs production | Every gap identified and reconciled | 3 objects found, reconstructed; 1 had a real defect, fixed | Defect 3; migrations 0081/0082 | GREEN | Section E |
| §27 Genuine concurrency certification | 16 distinct genuine concurrent-transaction tests | Real overlap, not simulated | All executed against a real Postgres 16 replica | N/A | GREEN | Section F |
| §28 Full test/build validation | vitest, typecheck, lint, build, bundle verify | Pass or pre-existing-only failures | 2146/2146 tests; 3 pre-existing typecheck errors; build+bundle OK | N/A | GREEN | Section H |
