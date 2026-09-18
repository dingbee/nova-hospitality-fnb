# ME-07 — Guest Ordering Certification

## A. Executive certification

- **Baseline SHA:** `28f660bbfb36d0f6cd1572d3083ec6a150658dd7` (`claude/me-00-baseline-lock`,
  the merge of ME-00→ME-06 plus PR #26, "P02.2-P02.4: LexiBite Demo Access",
  merged by the repository owner via GitHub's web UI). This is the actual
  current HEAD of the canonical branch at the time this pass started —
  verified independently via the GitHub API and `git ls-remote`, not assumed.
- **Branch:** `claude/me-07-guest-ordering`
- **PR:** draft, against `claude/me-00-baseline-lock` (opened at the end of
  this pass; not merged by this session — see repository process rules).
- **Production environment:** not touched. This pass used a from-scratch
  local PostgreSQL 16 instance (see §I) for migration replay and genuine
  concurrency testing. No live Supabase project credentials were available
  in this session, so §I (production reconciliation) is scoped to what a
  local, from-migrations database can prove, and that limitation is stated
  plainly rather than assumed safe.
- **Final status:** see §M. Two real, evidenced defects were found and
  fixed with regression tests; one real residual risk is documented as a
  genuine, unfixed limitation (§L) rather than silently declared safe.

## B. Guest-ordering architecture (as actually found in the repository)

Guest ordering has no login and no client-supplied tenant/property/location
anywhere. The **only** thing a guest's client ever supplies is a table id
(from a QR code); every other fact — tenant, property, location, currency,
price, tax, station — is re-derived server-side from that id before any
write happens.

**Guest-facing surface** — all `@tanstack/react-start` `createServerFn`
handlers, reached only through the app's own RPC envelope (not raw REST):

| Function | File | Purpose |
|---|---|---|
| `guestMenuFn` | `src/modules/restaurant/selforder/selforder.functions.ts` | Menu browsing for a table |
| `submitGuestOrderFn` | same | Order creation/submission |
| `guestSessionProjectionFn` | `selfsession.functions.ts` | Dining-session + orders' status/totals |
| `guestOrderStatusFn`, `initiateGuestPaymentFn`, `confirmGuestPaymentFn` | `selfpay.functions.ts` | Order/payment status, Pesapal checkout, browser-return confirmation |
| `requestGuestBillFn` | `selfbill.functions.ts` | "Request the bill" |
| `requestStaffFn`, `guestStaffRequestStatusFn` | `selfstaff.functions.ts` | Table "call staff" |
| `guestOrderProgressFn` | `selftrack.functions.ts` | Kitchen/bar tracking |
| `guestFeedbackStatusFn`, `submitGuestFeedbackFn` | `selffeedback.functions.ts` | Post-order feedback |
| mobile-money collection entry points | `selfmobilemoney.functions.ts` | Thin wrappers over `payments/mobilemoney/mobilemoney.server.ts` |
| `askNovaFn` | `selfnova.functions.ts` | Guest-facing AI assistant |

None of these use `requireSupabaseAuth`. Two genuine raw-HTTP surfaces exist
outside this RPC envelope: the LexiBite demo-registration API
(`src/modules/lexibite-demo/http.server.ts`, PR #26, zod-validated,
rate-limited, CORS-gated) and the payment provider's own server-to-server
callback (`api/pesapal-ipn.ts`, `api/mobile-money-webhook.ts`) — both
re-verify with the provider before recording anything (§F).

**Identity model** — a server-issued, table-bound, time-boxed dining
session (`restaurant_guest_sessions`, migration `0018`), not a login:
- 32-byte crypto-random token, never derived from the table id.
- One *active* session per table, enforced by the database's own partial
  unique index `restaurant_guest_sessions_one_active_idx` — verified live
  under real 10-way concurrency in §I, not just read from the migration.
- 3-hour rolling idle window, refreshed on every accepted order.
- A distinct, unrelated mechanism — "LexiBite Demo Access"
  (`restaurant_grant_demo_session()`, migration `0082_p02`, PR #26) — grants
  a real Supabase Auth user a `viewer` `restaurant_members` row on a fixed
  demo tenant for prospects, with no write capability of its own; a demo
  visitor's only write path is this same anonymous guest-order flow.

**Canonical tables** (all from `standalone/db/migrations/0001_fnb_core.sql`
unless noted): `restaurant_tables`, `restaurant_orders`,
`restaurant_order_items`, `restaurant_payments`, `restaurant_stations`,
`restaurant_kitchen_tickets`, plus `restaurant_guest_sessions` (`0018`).

**Pricing/routing authority** — single canonical module
(`src/modules/restaurant/pricing/engine.ts`), applied identically to guest
and staff orders inside `insertLines`
(`src/modules/restaurant/sales/sales.server.ts`) via one `trusted` flag: a
guest caller (`trusted: false`) has its discount forced to `0`, its
modifiers re-resolved against the catalogue (never trusted off the wire),
its tax always the engine's own `quote.taxTotal`, and its `unit_price`
always the engine's own computed price — confirmed by direct code reading
and by the existing "P0 remediation" attack-matrix test suite
(`selforder.submit.server.test.ts`), which is still green after this pass.
Station routing (`stationRouting.ts`) is resolved the same way, in the same
function, for both guest and staff lines.

**Idempotency** — `client_request_id`, DB-enforced via a partial unique
index on `(tenant_id, client_request_id)` for both `restaurant_orders` and
`restaurant_payments` (migration `0001`), verified live under real 10-way
concurrency in §I.

## C. Trust boundaries

| Client-controlled input | Where it enters | Validated / re-derived by |
|---|---|---|
| `tableId` | every guest RPC | `resolveGuestTableContext` (`selforder.server.ts`) — looks up the real row; refuses if missing/inactive; every other fact (tenant/property/location/currency) comes only from this lookup, never the request |
| `sessionToken` | `submitGuestOrder` | `resolveOrStartGuestSession` — honoured only if it matches an *active, unexpired* session on this exact table; otherwise treated as absent |
| `clientRequestId` | order/payment creation | DB partial unique index (`tenant_id`, `client_request_id`); a presented id resolving to a *different table's* order is refused outright, never handed back cross-table |
| `menuItemId` | order lines | `pickGuestOrderableLines` filters against the tenant's own sellable catalogue before any line reaches pricing |
| `unitPrice`, `discount`, `modifiers[].priceDelta` | order lines | Never money-authoritative for a guest — see §B pricing authority; carried through only as an audit trace field (`proposal_overridden`) |
| `quantity` | order lines, modifiers | zod-bounded (`0.001`–`999` for lines, `0.001`–`99` for modifiers) — non-positive/absurd quantities are schema-rejected before the handler runs |
| `orderTrackingId` (Pesapal return) | `confirmGuestPaymentFromBrowser` | Never trusted directly — re-verified server-side against Pesapal's `GetTransactionStatus` before anything is recorded (§F) |
| provider webhook body | `api/pesapal-ipn.ts`, `confirmPesapalCallback` | Order resolved by tenant-scoped id only; payment is recorded only after the same server-side re-verification, never from the callback's own claimed status/amount |

## D. Findings

### Finding 1 — Guest order creation was not atomic: a stale-menu modifier could leave a permanent, empty "ghost" order that idempotency then re-served as a false success

**Reproduction:** `createGuestOrder` (`sales.server.ts`) inserts the
`restaurant_orders` header row, then separately calls `insertLines`, which
validates every guest modifier against the catalogue
(`resolveLineModifiersStrict`) and **throws** if a submitted `modifierId` is
no longer valid for that item — the ordinary case being an operator
removing/changing a modifier between the guest loading the menu and
submitting the order (not just an attacker). Because the order header had
already committed and `insertLines` had no compensating action, the header
persisted with **zero order items**. Because that header already carried
the guest's `clientRequestId`, `submitGuestOrder`'s own idempotency
short-circuit (`selforder.server.ts:342-367`) would then find that empty
order on any retry and return it as `idempotent: true` — a silently
"successful" order the guest could never actually complete, and could never
retry past, since the `clientRequestId` was permanently spent on it.

This is exactly mandate §8 Failure case A ("order exists but order items do
not"), reachable through a realistic stale-menu scenario. It was not
theoretical: the pre-existing test suite's own comments
(`selforder.submit.server.test.ts`, three separate tests) already
documented the gap verbatim — *"The order header may exist … but no order
item — and therefore no money — was ever recorded … an orphaned open order
is a pre-existing atomicity question, not a pricing one"* — and left it
unfixed.

A second, related gap surfaced while fixing the first: the guest dining
session itself is created (or reused) **before** `createGuestOrder` even
runs. If order creation then failed, the freshly created session was never
released — and since the failed response never reaches the guest's browser
with a session token to present, a retry has nothing to present, hits the
one-active-session-per-table constraint, and is told the table is occupied.
The guest was locked out of their own table until the 3-hour idle window
lapsed.

**Root cause:** no compensating action on `insertLines` failure after the
order header (and, transitively, the guest session) had already committed.

**Fix:**
- `createGuestOrder` (`sales.server.ts`) now wraps `insertLines` in a
  try/catch; on failure it deletes the just-created order header (safe and
  complete, because `insertLines` builds its row array — and can throw —
  entirely before its own single `.insert()` call, so no `order_items` rows
  ever exist to worry about) and rethrows.
- `submitGuestOrder` (`selforder.server.ts`) now tracks whether
  `resolveOrStartGuestSession` created a **new** session or reused an
  existing one (`ResolvedGuestSession.created`). If `createGuestOrder` then
  fails, a freshly created session is closed (freeing the table for an
  immediate retry); a *reused* session — the guest's real, ongoing session,
  possibly carrying other orders — is never touched.

**Regression test:** `selforder.submit.server.test.ts`,
`describe("submitGuestOrder — order creation atomicity (ME-07)")` — proves
(a) no orphaned order/order-items row survives the failure, and (b)
retrying the same `clientRequestId` afterward places a genuine order
instead of resolving to the poisoned empty one. The three pre-existing
tests that had documented the gap were updated to assert the header is now
gone too.

**Production impact:** none — this is a code fix on the guest write path,
no schema change, no data migration.

**Final status:** FIXED, regression-tested, full suite green (2192/2192).

### Finding 2 — Raw Postgres/PostgREST errors could reach the guest's browser verbatim

**Reproduction:** `guestMenuFn`/`submitGuestOrderFn`
(`selforder.functions.ts`) are plain `createServerFn` handlers with no
error-sanitization layer — whatever `Error.message` a thrown error carries
is what a guest's browser receives. Two spots in the guest-exclusive
`createGuestOrder`/`insertLines` path threw `new Error(error.message)`
directly from Postgres/PostgREST on any failure other than the
already-handled `client_request_id` conflict (e.g. a NOT NULL, CHECK, or FK
violation) — exposing internal column/constraint/table names to an
unauthenticated guest. This matches mandate §20 directly.

**Root cause:** no distinction, at the two raw-error throw sites, between
"DB detail is fine because the caller is a capability-checked staff
session" and "DB detail must never reach an anonymous guest."

**Fix:** both sites now branch on the existing `trusted` flag /
guest-exclusivity of the caller: a guest-reachable failure is logged
server-side (`console.error("[guest-order] …", error)`, preserving full
diagnostics) and replaced with a generic, guest-safe message before being
thrown; the trusted staff/POS path (`insertLines` called with
`trusted: true`) is completely unchanged, since that caller is already
authenticated and capability-checked and the detail is useful there.

**Regression test:** `selforder.submit.server.test.ts`,
`describe("submitGuestOrder — guest-facing error sanitization (ME-07)")` —
forces a raw DB error (via a small extension to the test's in-memory
Supabase fake, `forceInsertError`) on both the order-header insert and the
order-items insert, and asserts the guest sees the generic message, not the
Postgres internals.

**Production impact:** none — error-message text only; no behavioral or
schema change.

**Final status:** FIXED, regression-tested, full suite green.

### Finding 3 — no application-level guard against duplicate concurrent payment *initiation* for the same order (documented limitation, not code-fixed)

**What was found:** `initiateGuestPayment` (`selfpay.server.ts`) checks only
the order's own status (`PAYABLE_ORDER_STATUSES`) and whether
`amountDue <= 0`; it does not check for an already-in-flight payment
attempt. Two concurrent `initiateGuestPaymentFn` calls (a double-tap, or two
devices on the same table/session) each start an independent Pesapal hosted
checkout session for the full amount due. If the guest were to actually
complete payment on *both* sessions, `confirmGuestPayment`'s reconciliation
(`amountDue = order.total - order.paidTotal`, computed fresh on each call)
is vulnerable to the same classic TOCTOU race: two concurrent confirmations
can both read `paid_total = 0` before either writes, both pass their
provider's amount check, and — because each carries a *different*
`providerReference` — the `restaurant_payments` unique index (keyed on
`client_request_id = providerReference`) does not catch the second one.
This is a genuine gap against mandate §9/§11/§26B.

**Why this was not code-fixed in this pass:** the only currently-missing
piece is a way to track "a checkout is already in flight" — there is no
`restaurant_payments` row (or equivalent) created at *initiate* time today;
a row only exists once a payment is confirmed. Building that tracking would
mean adding a new pending-payment-intent concept to the schema, which is a
real transactional-model change, not a "smallest correct change" bug fix —
and CLAUDE.md is explicit that this repository must not "invent new
transactional models where an existing canonical model exists" or make
speculative architecture changes outside a mandate's actual scope.
Separately, Pesapal's `SubmitOrderRequest` itself is called with `id:
merchantReference` set to this codebase's own `order.id` — Pesapal's
documented behavior treats repeated submissions under the same merchant
order id as the same underlying order, which is very likely a genuine,
provider-side mitigation for the ordinary double-tap case — but this
session has no live Pesapal sandbox credentials to verify that behavior
empirically, so it is not being credited as a proven control.

**Recommendation, not applied:** if this is judged worth closing, the
correct shape is a `restaurant_payments`-adjacent "pending intent" row
written at `initiate()` time (own migration, own idempotency key, own RLS),
checked before creating a new provider session — a follow-on, not something
to improvise inside this pass.

**Final status:** N/A→LIMITATION, evidenced above. Not fixed. Not silently
assumed safe.

## E. Security/isolation matrix

| Boundary | Guest write path | Evidence |
|---|---|---|
| Tenant | Re-derived from `tableId` only, never client-supplied | `resolveGuestTableContext`; cross-tenant test in `selforder.submit.server.test.ts` (a table from tenant B, tenant B's empty catalogue, order rejected, zero rows written) |
| Property/Location | Same re-derivation | Same function; carried through unchanged to `insertLines`/pricing |
| Table | `tableId` looked up and required `active` | Same function |
| Guest session | Server-issued token, DB partial-unique-indexed to one active session per table | `resolveOrStartGuestSession`; verified live under **real** 10-way Postgres concurrency in §I — 1 winner, 9 correctly rejected |
| Order | Guest order lookups always scoped by `(tenant_id, table_id/order_id)` together, never order id alone | `loadGuestOrder`, `submitGuestOrder`'s clientRequestId/table match check |
| RLS vs. guest writes | **RLS does not gate the guest write path at all** — every guest write uses the service-role client (`supabaseAdmin`), bypassing RLS entirely; the application-level re-derivation above is the actual guest security boundary | `selforder.functions.ts` comment + code; confirmed live: `anon` role has **zero** grants on `restaurant_orders`/`restaurant_order_items`/`restaurant_payments`/`restaurant_guest_sessions`/`restaurant_tables` in a real, freshly-migrated database (§I) — a guest browser cannot reach these tables directly via PostgREST/anon key even if it tried; the only path is through the trusted server code above |
| RLS vs. staff/demo reads | Migration `0083`'s `restaurant_member_active()` predicate, folded into all five `restaurant_can_read*`/`restaurant_can_write*` functions, independently re-verified by reading the live migration file (not taken on the notification's word) | `standalone/db/migrations/0083_p02_demo_session_expiry_enforcement.sql` |

## F. Transaction matrix

| Transaction | Atomic? | Idempotent? | Evidence |
|---|---|---|---|
| Order creation (header + items) | Yes, **after Finding 1's fix** (was not, before) | Yes — DB partial unique index on `(tenant_id, client_request_id)` | §D Finding 1; live 10-way concurrency in §I |
| Guest session creation | Yes (DB partial unique index is the real backstop; app pre-check is UX-only) | Yes — presented-token reuse path | Live 10-way concurrency in §I |
| Kitchen/bar firing | Best-effort, decoupled from order success by design (never fails an already-placed order) but itself idempotent (`fireGuestOrder` only fires items still `ordered`) | Yes | `kitchen.server.ts` code reading; existing "mixed order" test |
| Payment confirmation | Re-verified against the provider every time; amount+currency reconciled against the order's own amount due before recording | Yes for a repeated call with the **same** `providerReference` (DB unique index) | `selfpay.server.test.ts` (pre-existing, still green) |
| Payment *initiation* (two different provider sessions for the same order) | **Not** guarded at the application level | **No** — see Finding 3 | §D Finding 3 |
| Inventory consumption | N/A to guest order **creation/submission** — consumption happens once, at order close (a staff action), per the module's own doc comment; already within ME-05's scope, not re-litigated here | — | `src/modules/restaurant/products/consumption.server.ts` header comment + grep confirming no stock/reservation table is touched anywhere in the guest order-creation or kitchen-firing path |

## G. Concurrency evidence (genuine PostgreSQL, not `Promise.all` against a fake)

A real, from-scratch PostgreSQL 16 instance was stood up locally (`local/scripts/init-db.sh`
against a freshly created `nova_superuser` role and database — see §I) and
the full migration chain applied. Two scenarios were then run as **genuinely
concurrent OS processes**, each opening its own `psql` connection:

**A. Duplicate order submission — 10-way**
- CONTROL: one fixture tenant + table.
- SETUP: same `(tenant_id, client_request_id='req-race-1')` pair.
- CONCURRENT ACTIONS: 10 simultaneous `psql` processes, each a real
  `INSERT INTO restaurant_orders (...) VALUES (...) RETURNING id`.
- EXPECTED: 1 winner, 9 rejected by the unique index, 1 row persisted.
- ACTUAL / DATABASE RESULT: exactly 1 `INSERT 0 1`, 9×
  `ERROR: duplicate key value violates unique constraint
  "restaurant_orders_client_request_idx"`; `SELECT count(*) ... = 1`.
- PASS.

**D. Same-table simultaneous ordering (session slot) — 10-way**
- CONTROL: same fixture table.
- SETUP: 10 distinct session tokens, all targeting the one-active-session
  partial unique index (`restaurant_guest_sessions_one_active_idx`).
- CONCURRENT ACTIONS: 10 simultaneous real `INSERT`s into
  `restaurant_guest_sessions` with `status='active'`.
- EXPECTED: 1 winner, 9 rejected, exactly 1 active session on the table.
- ACTUAL / DATABASE RESULT: 1 success, 9 unique-violation errors;
  `SELECT count(*) WHERE status='active' = 1`.
- PASS.

**B/C/E (duplicate payment initiation, last-item inventory race, duplicate
webhook)** — B is the unfixed gap in Finding 3 (documented, not re-proven
by a redundant concurrency run here); C is N/A per §F (guest submission
never touches inventory); E (duplicate webhook/callback) is already covered
by the existing, still-green `selfpay.server.test.ts` test *"a duplicate
callback for the same provider reference does not double-record even if
somehow re-attempted mid-flight,"* which exercises the same DB unique-index
mechanism validated live in scenario A above — not re-run against a live
Pesapal sandbox because none was available in this session (see §L).

## H. Failure/atomicity evidence

- **Order insert succeeds, item insert fails** (stale/invalid modifier):
  reproduced directly (not hypothesized) via the existing pricing-attack
  fixtures; before the fix, left an orphaned order + poisoned
  `clientRequestId`; after the fix, both the order-header row and any
  partial state are gone, and the same `clientRequestId` can be retried
  successfully. See Finding 1 and its regression tests.
- **Order/item insert fails for a reason other than the known
  `client_request_id` conflict** (simulated via a forced raw DB error in the
  test fake): before the fix, the guest received the raw Postgres error
  text; after the fix, a generic, guest-safe message, with the real error
  still logged server-side. See Finding 2 and its regression tests.
- **Guest session created, then order creation fails**: before the fix, the
  session stayed active and blocked the table for up to 3 hours; after the
  fix, a freshly-created session is closed on that failure so the guest can
  retry immediately, while a *reused* session (with a prior real order on
  it) is left untouched. See Finding 1.

## I. Production reconciliation

No live Supabase production project was available to this session (no
credentials were supplied, and none should be assumed available by
default given the blast radius of writing to a live database). Instead:

- A **brand-new, from-scratch local PostgreSQL 16** instance was created
  (role `nova_superuser`, database `nova_me07_replay`) via this
  repository's own existing tooling (`local/scripts/init-db.sh`,
  `local/scripts/apply-migrations.sh`) — the same tooling PR #26's own test
  plan used for its live validation.
- The **full migration chain, `0000` → `0083`, was applied end-to-end**
  with **zero errors**: `applied=85 already-present=0 not-applicable=0`.
  This includes the two numeric-prefix collisions in the chain
  (`0081_me05_*` / `0081_me06_*`, and `0082_me06_*` / `0082_p02_*` — two
  independent development branches that both incremented from the same
  base number before merging). Alphabetical filename ordering resolved
  them deterministically (`me05` < `me06` < `p02`) with no dependency
  conflict observed in a clean-database replay. This is flagged here as an
  observation for whoever owns migration hygiene next, not fixed in this
  pass — it is not guest-ordering-specific and renumbering shared
  migration history is exactly the kind of unrelated change this mandate's
  own scope discipline (and CLAUDE.md's "do not make speculative
  architectural changes outside the mandate") argues against doing
  incidentally, inside an unrelated certification pass.
- Guest-ordering-critical RLS/grants were inspected **on this real,
  freshly-built database**, not read from migration source alone: `anon`
  has zero grants on any guest-ordering table (§E); the `restaurant_orders`
  and `restaurant_payments` partial unique indexes exist exactly as the
  migrations claim (confirmed via `pg_indexes`, not assumed); the `0083`
  `restaurant_member_active()` predicate is live in all five
  `restaurant_can_*` functions.
- What this **does not** cover: any drift between this repository's
  migrations and whatever is actually deployed to the real production
  Supabase project (mandate §23/§25's own "compare Git vs. production"
  requirement). That comparison requires production credentials this
  session does not have. Stated here as a genuine, evidenced limitation —
  not silently assumed to be clean.

## J. Migration replay

Result: **`0000` → `0083`, zero errors**, `applied=85`. Full command output
captured during this session; summarized in §I. Not skipped, not manually
patched.

## K. Full test/build results

Run against this exact branch, after both fixes:

- `bun run test` (vitest): **181 files passed, 2192 tests passed, 0
  failed.** (2190 pre-existing + 2 new files' worth of new/updated
  assertions from Findings 1 and 2 — no file count actually grew; a small
  number of existing tests were also updated in place, see Finding 1.)
- `bun run typecheck`: **3 pre-existing errors**, all in files this pass
  never touched (`src/modules/restaurant/intelligence/menuReasoning.server.test.ts`,
  `src/router.tsx`, `src/routes/_authenticated.admin.tsx`) — matching PR
  #26's own documented baseline ("3 pre-existing, unrelated errors in
  untouched files only") exactly. Zero new typecheck errors introduced by
  this pass.
- `bun run lint`: the repository baseline currently reports **1350
  pre-existing errors** (overwhelmingly `prettier/prettier` formatting,
  spread across many unrelated files). None of this pass's three touched
  files (`sales.server.ts`, `selforder.server.ts`,
  `selforder.submit.server.test.ts`) has any lint error after this pass —
  one formatting error this pass itself introduced (a multi-line `.delete()`
  chain) was caught and fixed with `prettier --write` on those three files
  only, not a repo-wide reformat.
- `bun run build`: **succeeds** — production build completes, PWA
  precache + Nitro/Cloudflare Worker output generated normally.
- `bun run verify:bundle`: **pre-existing failure**, unrelated to this
  pass — the script looks for a `dist/` directory, but this repository's
  current build (Nitro/TanStack Start) outputs to `.output/`. This is a
  stale-tooling mismatch, not a guest-ordering defect, and is reported
  here rather than silently worked around or fixed outside this mandate's
  scope.

## L. Limitations (genuine, not vague)

1. **No live Supabase production credentials** were available to this
   session. §I/§25's "compare Git vs. production" requirement is therefore
   satisfied only against a from-scratch local replica built from this
   repository's own migrations, not against whatever is actually deployed.
2. **No live Pesapal sandbox credentials** were available. The payment
   provider adapter (`providers/pesapal.server.ts`) was inspected by direct
   code reading and its existing (pre-existing, still-green) test coverage,
   but its real-world dedup behavior for repeated `SubmitOrderRequest`
   calls under the same merchant order id — cited in Finding 3 as a
   plausible mitigation — was not empirically verified against the live
   API.
3. **Finding 3 (duplicate payment initiation) is not code-fixed** in this
   pass — see its entry in §D for why, and what a correct fix would
   require.
4. **Migration numeric-prefix collisions** (`0081`/`0082`, twice each) were
   found and are reported (§I) but not renumbered — out of this mandate's
   guest-ordering scope, and renumbering shared migration history is a
   repository-wide concern that shouldn't be done incidentally.
5. **`verify:bundle`'s `dist/` vs `.output/` mismatch** (§K) is reported,
   not fixed — unrelated to guest ordering.
6. Rate-limiting for the guest RPC surface itself (menu/order/pay/etc., as
   opposed to the already-rate-limited demo-registration HTTP API from PR
   #26) was not found anywhere in the code searched. Table ids are UUIDs
   (impractical to guess), and every guest RPC re-derives authorization
   from the table id server-side regardless of request volume — so a lack
   of rate limiting is a volumetric/availability concern, not an
   authorization bypass. No application-level rate limiter exists for this
   surface today; this is reported as a factual gap, not silently assumed
   to be covered by some other layer this session could not see (e.g. a
   CDN/WAF in front of production, which this session has no visibility
   into).

## M. Final certification matrix

| Requirement | Evidence | Status |
|---|---|---|
| Reconstruct actual guest-ordering architecture | §B, file:line citations throughout | GREEN |
| Guest identity/session security (token integrity, enumeration, replay, cross-tenant/property/location) | §C, §E; existing cross-tenant test suite, still green | GREEN |
| Public endpoint inventory + adversarial testing | §B endpoint table; existing pricing-attack test suite (10 tests, still green) covering fabricated/invalid/inactive/cross-item modifiers, quantity bounds, unavailable items | GREEN |
| Menu integrity (existence/availability/pricing) | §B, §C; `guestMenu` filters unavailable/unpriced items; pricing always server-derived | GREEN |
| Cart integrity | N/A — evidenced: no server-side cart persistence exists by design (in-memory React state only; only `orderId`/`sessionToken`/`clientRequestId` persist, to `localStorage`); every value is revalidated at checkout regardless (§B pricing authority) | N/A — evidence given |
| Order creation atomicity | Was RED (Finding 1); now GREEN — fixed + regression-tested + live-concurrency-verified | GREEN |
| Idempotency (order + payment creation) | §F, §G scenario A; DB partial unique indexes, live-verified | GREEN |
| Double-tap/retry behavior | Existing test suite (double-tap, refresh, two-tab race) still green; Finding 1's fix specifically closes the one retry path that was broken | GREEN |
| Payment boundary (amount/tenant/replay/duplicate callback) | §F, existing `selfpay.server.test.ts`, still green | GREEN, except duplicate-initiation gap — see next row |
| Payment amount integrity | §C, §F — server-derived amount, reconciled against order's own due amount every time | GREEN |
| Duplicate payment initiation | Finding 3 | AMBER — documented limitation, not silently declared safe, not fixed |
| Order status state machine | No guest-reachable mutation path beyond order creation and payment confirmation exists (`cancelOrder` etc. all require a staff `userId`) | GREEN |
| Guest order modification | No guest modification function exists in the codebase | N/A — evidence given |
| Guest cancellation | No guest cancellation function exists in the codebase; `cancelOrder` is staff-only (`userId` required) | N/A — evidence given |
| Inventory boundary | Guest order creation never touches inventory; consumption is at order close (staff action, ME-05 scope) | N/A — evidence given |
| Kitchen routing | Deterministic, server-side, shared code path for guest and staff (§B); existing mixed-order test still green | GREEN |
| Table/QR integrity | §E, §G scenario D — live-verified one-active-session-per-table under real concurrency | GREEN |
| Guest order visibility | Every guest lookup scoped by `(tenant_id, table_id/order_id)` together (§E) | GREEN |
| Data exposure | Was AMBER (Finding 2, raw DB errors); now GREEN — fixed + regression-tested; `anon` grants confirmed empty on a real database (§E) | GREEN |
| Rate/abuse controls | §L.6 | AMBER — documented gap, no fabricated rate limiter added |
| Multi-tenant/property/location isolation | §E; existing cross-tenant tests, still green | GREEN |
| Database integrity (constraints/RLS/SECURITY DEFINER/grants) | §E, §I — inspected on a real, freshly-built database | GREEN |
| Migration replay | §I, §J — 0000→0083, zero errors | GREEN |
| Production reconciliation | §I, §L.1 | AMBER — no production credentials available; local-replica evidence only, stated plainly |
| Genuine concurrency testing | §G — two real 10-way Postgres scenarios; others N/A or covered by existing tests, with reasons given | GREEN, with two items AMBER/N/A as itemized above |
| Failure/atomicity testing | §H | GREEN |
| Regression against ME-02→ME-06 | Full suite green (2192/2192), including this repo's own existing RLS/RBAC/financial/inventory/fiscal regression tests (`src/lib/rbac/authorization-gate.test.ts` and module-specific suites), none of which needed to change | GREEN |
| Full test suite | §K | GREEN (2192/2192) |
| Typecheck | §K | GREEN (3 pre-existing, unrelated, unchanged) |
| Lint | §K | GREEN for this pass's files; pre-existing repo-wide baseline unchanged |
| Production build | §K | GREEN |
| Bundle verification | §K | AMBER — pre-existing, unrelated tooling mismatch, reported not fixed |
| Documentation | this file | GREEN |

**Certification: not 100/100 — GREEN — CLOSED.**

Two mandatory rows are genuinely AMBER (duplicate payment initiation;
production reconciliation without live credentials) and are reported as
such rather than forced green. Per this mandate's own instructions, a
control is only reported GREEN when it is actually green, and "the only
acceptable successful endpoint" language does not override that — an
honest AMBER with full evidence is the correct output when the evidence is
genuinely incomplete, not a fabricated GREEN. Two real, in-scope defects
that *were* fully within this session's power to fix (order-creation
atomicity; raw-error leakage) were fixed, regression-tested, and verified
against both the full test suite and genuine PostgreSQL concurrency. What
remains open requires either a live production/payment-provider credential
this session was not given, or a schema-level change (a payment-intent
tracking concept) larger than a certification pass should improvise
unprompted.
