# ME-09 — Offline Certification

## A. Executive certification

- **Baseline SHA:** `28f660bbfb36d0f6cd1572d3083ec6a150658dd7`
  (`claude/me-00-baseline-lock`) — verified independently against the
  GitHub API before any change was made (matched this session's actual
  git HEAD exactly).
- **Branch:** `claude/me-09-offline-certification`
- **PR:** [#31](https://github.com/dingbee/nova-hospitality-fnb/pull/31),
  open as a draft against `claude/me-00-baseline-lock`, not merged by
  this session.
- **Scope:** ME-09 corresponds to P10 (Offline Operations Capability),
  already substantially implemented and documented in
  [`docs/p10-offline-operations.md`](../p10-offline-operations.md). This
  pass inspected that existing implementation end to end, found one real
  defect, fixed it with regression coverage, and added the queue/storage
  load certification that pass's own limitations section did not include.
- **Final status:** see §M. One real, evidenced defect found and fixed
  with regression tests. No other invariant violation was found in the
  existing implementation across the full reconnaissance in §B.
- **Corrective-integration update (§N):** ME-07 (PR #29) and ME-08
  (PR #30) have since been merged into `claude/me-00-baseline-lock`
  (merge commits `d175929`, `e895983`). This branch was merged forward
  onto that updated baseline and re-validated against the actual
  integrated code (not assumed from the pre-merge branch diffs in §E
  below). Result: **no genuine integration defect found** — see §N for
  the executed proof.

## B. Reconnaissance — what was actually inspected

Every path P10 claims to cover was read in full and cross-checked against
its own test suite before any change was made:
`db.ts`, `queue.ts`, `sequence.ts`, `syncEngine.ts`, `conflict.ts`,
`contracts.ts`, `device.ts`, `auth.ts`, `connectivity.ts`, `snapshot.ts`,
`adapters.ts`, `useOfflineSync.ts`, `ui/ConnectivityIndicator.tsx`, the
`PosWorkspace.tsx` wiring, and all ten existing test files (95 tests) plus
`e2e/offline-realbrowser.spec.ts`.

Findings from reconnaissance, before any change:

- The historical `pruneSynced` wiring gap this mandate specifically asked
  to re-verify (§7 of the mandate) is **already fixed** in the current
  baseline — commit `7519bbe` ("P10 fix: wire pruneSynced into the sync
  engine so queue cleanup actually runs") is already on `HEAD`.
  `syncPendingQueue` calls `pruneSynced` at the end of every successful
  pass (`syncEngine.ts`), best-effort, and this is covered by an existing
  test (`syncEngine.test.ts`'s "bounded queue growth" suite). No further
  action was needed here.
- Tenant isolation, idempotent replay, conservative conflict
  classification (never `CLIENT_WINS`), concurrency-locked sync, and the
  payment/inventory/fiscal/guest-ordering exclusions are all implemented
  as documented and are correctly enforced by their existing tests.
- One real gap was found in the dependency-ordering logic — see §C.
- The queue/storage-load certification P10 itself did not attempt (no
  test exercised a realistic queue size) was a genuine, real gap — see
  §D.

No database inspection or modification was performed during
reconnaissance, per the mandate's own instruction.

## C. Real defect found and fixed

**Defect:** in `syncEngine.ts`'s `runSyncPass`, an operation with
`dependsOnOperationId` was skipped ("waiting on dependency") whenever its
parent's state was anything other than `SYNCED` — including when the
parent had reached a **terminal failure** state (`CONFLICT`,
`DEAD_LETTER`, `CANCELLED`, i.e. it will never sync). The dependent
operation was left `PENDING` indefinitely, retried as "waiting" on every
subsequent sync pass forever, with no way for an operator to see that it
could never actually resolve.

**Concretely:** if a device queues `open_order` then `add_item` then
`fire_to_kitchen` offline, and the `open_order` op is later rejected by
the server for a genuine business reason (e.g. `Forbidden`, or it
exhausts its retry budget into `DEAD_LETTER`), the dependent `add_item`
and `fire_to_kitchen` ops stayed `PENDING` forever. `syncStatusFor`
reported them as ordinary "pending" work — indistinguishable in the
`ConnectivityIndicator` UI from a normal, still-resolvable in-progress
op — with no signal that they could never sync and needed operator
reconciliation.

**Why this is real and in-scope:** it violates the mandate's own
invariants — (A) an operation must either remain durably queued
*and progressing toward resolution*, be acknowledged, or reach an
*explicit* terminal state, never sit invisibly stuck; and (D) a failed
operation must not leave dependents in a state that misrepresents
progress. It is also a defect the existing 95-test suite did not cover:
no test exercised a child behind a permanently-failed (not just
not-yet-synced) parent.

**Fix:** `runSyncPass` now checks whether the dependency is in a terminal
failure state before treating it as "still waiting." If so, the
dependent is cascaded immediately to `CONFLICT` (a `ConflictRecord` is
written with `REQUIRES_OPERATOR`, matching how every other
un-auto-resolvable case in this engine is already handled), rather than
left `PENDING`. This surfaces in the existing `ConnectivityIndicator` as
"needs attention" with zero UI changes required. A grandchild
(`fire_to_kitchen` depending on `add_item` depending on `open_order`)
cascades transitively within the same sync pass, since entries are
processed in local sequence order and a parent is always sequenced
before its child.

No new conflict outcome, idempotency mechanism, or transactional model
was introduced — this reuses the exact `CONFLICT`/`ConflictRecord`
machinery the engine already had for every other non-auto-resolvable
case.

**File:** `src/modules/restaurant/offline/syncEngine.ts`
(`runSyncPass`'s dependency check, ~20 lines changed/added).

## D. Queue/storage-load certification (new coverage, no defect found)

P10's own documentation did not include a test at a realistic queue size.
Two new tests were added to `chaos.test.ts`:

1. 500 queued `open_order` operations (a plausible full-shift queue
   depth), 10% deterministically failing to a mix of `SYNCED`/
   `DEAD_LETTER`, replayed across multiple sync passes — proves no loss,
   correct final-state breakdown, and preserved sequence ordering at
   scale.
2. 370 queue entries (300 aged `SYNCED`, 50 recent `SYNCED`, 20
   `PENDING`) through `pruneSynced` — proves pruning at scale removes
   exactly the aged terminal rows and nothing else, with no partial
   application.

No fabricated benchmark/timing assertion was added, per the mandate's own
instruction — these are deterministic correctness tests at scale, not
performance measurements. Both required an explicit longer test timeout
(`20_000`ms) than the suite's 5s default, because they perform genuine
bulk IndexedDB I/O (via `fake-indexeddb`) that runs measurably slower
under full-suite parallel contention than in isolation; this is disclosed
in an inline comment at each test, not silently worked around.

**File:** `src/modules/restaurant/offline/chaos.test.ts`.

## E. Concurrency with ME-07 / ME-08

Per the operating instructions for this pass, ME-07
(`claude/me-07-guest-ordering`, PR #29) and ME-08
(`fix/kitchen-ticket-cancellation-sync`, PR #30) were not opened, read for
guidance, or depended on — this section documents what their PR diffs
(read via the GitHub API only, for the purpose of this required
disclosure) touch, and why it does or doesn't matter for offline replay.

- **ME-07** modifies `sales.server.ts`'s `insertLines` and
  `createGuestOrder` to sanitize error messages and add compensation
  logic, but **only** on the `trusted: false` (guest) path. The offline
  module's adapters (`adapters.ts`) call `openPosOrderFn`/`addPosLinesFn`
  — the staff/POS path, which remains `trusted: true` and keeps raw
  server error messages. `conflict.ts`'s pattern matching (which depends
  on those raw messages, e.g. "This bill is closed...", "Order not
  found") is unaffected. **No overlap found.**
- **ME-08** modifies `kitchen.server.ts`'s `advanceTicket` (adds a legal
  transition table + compare-and-swap) and adds
  `cancelKitchenTicketItemsForOrderItems` (called from `voidPosLine`/
  `cancelOrder`). It does **not** modify `fireOrderItemsCore`/
  `fireRestaurantOrderFn`, which is what this offline module's
  `fire_to_kitchen` queueable operation actually calls and whose natural
  idempotency this module's classification (`contracts.ts`) relies on.
  **However**, a real interaction is plausible and worth a human's
  attention during reconciliation: if a device queues `fire_to_kitchen`
  offline against an order whose line is voided/cancelled by a *different*
  device while this one is offline, ME-08's ticket-cancellation-sync
  runs server-side before this device reconnects. `fireOrderItemsCore`
  operating on the (now server-correct) set of un-fired lines should
  still make the replay a safe no-op — but this exact interleaving was
  not, and could not be, tested here without importing ME-08's own
  unmerged code, which the operating instructions for this pass
  explicitly forbid. **Recommendation for the corrective-integration
  pass:** add one integration test combining ME-08's ticket-cancellation
  sync with this module's `fire_to_kitchen` replay path once both are
  merged, to confirm the no-op-on-nothing-left-to-fire behavior still
  holds against ME-08's new ticket item states.
- Neither branch touches `syncEngine.ts`, `queue.ts`, `db.ts`,
  `conflict.ts`, `contracts.ts`, `device.ts`, `auth.ts`,
  `connectivity.ts`, `snapshot.ts`, or `adapters.ts` — the entire offline
  module this pass certified. No migration number collision: this pass
  added no migration.

## N. Corrective integration with ME-07/ME-08 (post-merge)

ME-07 (PR #29) and ME-08 (PR #30) have since been merged into
`claude/me-00-baseline-lock` (merge commits `d175929`, `e895983`, both
independently verified via the GitHub API — `state: closed,
merged: false` on the PR objects themselves, but their commits are
confirmed ancestors of the current `claude/me-00-baseline-lock` tip via
`git log 28f660b..origin/claude/me-00-baseline-lock`). This branch was
merged forward onto that tip (`git merge origin/claude/me-00-baseline-lock`,
clean, no conflicts) and the exact interaction §E flagged as
"plausible, not yet tested" was investigated against the actual,
integrated code — not assumed from the pre-merge diffs.

**What was checked, against the real merged source:**

1. **`fireOrderItemsCore` (`kitchen.server.ts`) vs. ME-08's
   `cancelKitchenTicketItemsForOrderItems`.** Read in full. The offline
   module's `fire_to_kitchen` replay calls `fireOrder` →
   `fireOrderItemsCore`, whose entire idempotency/safety gate is
   `restaurant_order_items.status === "ordered"` — it never reads
   `restaurant_kitchen_ticket_items` (ME-08's table) at all, on any code
   path. ME-08's `cancelKitchenTicketItemsForOrderItems` (called from
   `voidPosLine`/`cancelOrder`) always runs *after* the same call sets
   `restaurant_order_items.status = "voided"` first. So a line voided by
   a different, online device while this device was offline is excluded
   from `fireOrderItemsCore`'s replay by the same, unmodified
   `status === "ordered"` filter that already existed pre-ME-08 — the
   two features never need to know about each other for this to be
   safe. **Proven, not just reasoned**, by two new tests added to
   `kitchen.server.test.ts` (§G) exercising exactly this scenario
   through `fireOrder` — the real function the offline adapter calls:
   - a sibling line voided while offline → only the still-`ordered` line
     fires, the voided line's ticket item is never resurrected.
   - every line voided while offline → `fireOrder` returns
     `{ tickets: [], fired: 0 }` with **no error thrown** — the exact
     shape `conflict.ts`'s `classifyOutcome` already treats as a
     successful `AUTO_RESOLVE`, never `CONFLICT`/`DEAD_LETTER`.
2. **`add_item`/`open_order` replay vs. ME-07's `insertLines`/
   `createGuestOrder` changes.** Read in full. ME-07's error-sanitization
   and orphan-header-compensation changes in `sales.server.ts` are
   gated entirely behind `trusted === false`. `insertLines`'s own
   default (`ctx.trusted !== false`) means `true` unless explicitly
   overridden, and `pos.server.ts`'s `addPosLines` — what the offline
   module's `add_item` replay actually calls via `adapters.ts` — never
   passes `trusted` at all. Confirmed by reading `addPosLines` end to
   end: the staff/offline-replay path is untouched by ME-07's changes,
   which only affect the separate, `FORBIDDEN_OFFLINE`-classified guest
   path. `conflict.ts`'s pattern matching against raw (unsanitized)
   error strings remains valid for every message this replay path can
   actually produce.
3. **`advanceTicket`'s new legal-transition table + compare-and-swap
   (ME-08).** `order_status_progress` (what `advanceTicket` implements)
   is, and remains, classified `ONLINE_REQUIRED` in `contracts.ts` — the
   offline sync engine never calls `advanceTicket`, so its new error
   messages (`"A ticket cannot move from ... to ..."`,
   `"This ticket changed to ... before this update reached it"`) are
   structurally unreachable from any replayed offline operation. No
   pattern needs to be, or was, added to `conflict.ts` for these.
4. **Migration numbers.** ME-07/ME-08 added no migrations. No collision
   with this pass's own (none added).

**Result: no genuine integration defect found.** The full validation
suite was re-run against the actual merged code (§H, updated numbers
below) — all green, no regression, no new failure.

**Regression tests added for this integration review:**
`kitchen.server.test.ts`, describe block "ME-09/ME-08 integration —
offline fire_to_kitchen replay after a line was voided while offline"
(2 tests, both passing).

## F. Files changed

- `src/modules/restaurant/offline/syncEngine.ts` — the fix (§C).
- `src/modules/restaurant/offline/syncEngine.test.ts` — 3 new regression
  tests for the fix (direct DEAD_LETTER cascade, transitive
  grandchild cascade, CANCELLED-parent cascade).
- `src/modules/restaurant/offline/chaos.test.ts` — 2 new queue/storage
  load tests (§D).
- `src/modules/restaurant/kitchen/kitchen.server.test.ts` — 2 new
  corrective-integration tests (§N), proving the `fire_to_kitchen`
  replay / ME-08 void-sync interaction is safe. No non-test file needed
  a code change for the integration review — no genuine integration
  defect was found (§N).
- `docs/me-09/ME-09-offline-certification.md` — this report.
- Merge commit bringing `origin/claude/me-00-baseline-lock` (with ME-07/
  ME-08 merged in) into this branch — clean, no conflicts.

No database, migration, or production change of any kind.

## G. Tests added

7 new tests total, all passing:

- `syncEngine.test.ts`: "a child whose parent open_order DEAD_LETTERs is
  cascaded to CONFLICT...", "a grandchild ... cascades transitively in
  the same pass ...", "a child whose parent was explicitly CANCELLED is
  also cascaded ...".
- `chaos.test.ts`: "a device that queued 500 operations ... replays every
  one correctly ...", "pruning at scale removes only aged SYNCED
  entries ...".
- `kitchen.server.test.ts` (§N, added during corrective integration):
  "fires only the still-ordered line when a sibling line was voided by
  another device while this one was offline", "a queued fire_to_kitchen
  replaying after EVERY line on the order was voided offline-elsewhere
  is a clean no-op, not an error ...".

## H. Validation executed

Executed twice: once pre-integration (against baseline `28f660b`), and
again after merging ME-07/ME-08 forward into this branch (§N). Numbers
below are the **post-integration** (current) results.

- `npx vitest run src/modules/restaurant/offline` — **10 files / 100
  tests passing** (95 pre-existing + 5 new from §C/§D).
- `npx vitest run src/modules/restaurant/kitchen/kitchen.server.test.ts`
  — **14 tests passing** (12 pre-existing/ME-08 + 2 new from §N).
- `npx vitest run` (full project suite) — **183 files / 2207 tests
  passing**, no regressions (up from 181/2193 pre-integration; the
  difference is ME-07/ME-08's own new test files plus this pass's 7).
- `npx tsc --noEmit` — **0 new errors.** The same 3 pre-existing baseline
  errors documented in `docs/p10-offline-operations.md` §16
  (`menuReasoning.server.test.ts`, `router.tsx`,
  `_authenticated.admin.tsx`) are still present, confirmed unchanged by
  this pass (none are in a file this pass touched).
- `npx eslint` on every touched file — **0 problems** (one prettier
  formatting pass applied via `--fix` to this pass's own new code, then
  re-verified clean).
- `NODE_OPTIONS=--max-old-space-size=8192 npx vite build` — **succeeds.**
  See §I for a pre-existing environment gap this required working around
  locally (not committed).
- `bun run scripts/verify-bundle-origin.ts .output` — **"Bundle
  provenance OK"**, no foreign backend origin or product reference.
- `npx playwright test` (real-Chromium offline certification) —
  **15/15 passing**, unchanged from the existing baseline (this pass did
  not modify any file the harness exercises).

## I. Pre-existing failures / environment gaps, with evidence

- **Typecheck:** the 3 pre-existing errors above are unrelated to the
  offline module (menu-reasoning intelligence, router error-boundary
  typing, admin route). Confirmed present in files this pass never
  touched.
- **Production build:** on a completely fresh `npm install` in this
  session's environment (this repository ships **no `package-lock.json`**
  — none existed before this session), the build failed with
  `Rollup failed to resolve import "@zxing/library"`. Root cause,
  confirmed by inspecting `node_modules/@zxing/browser/package.json`:
  `@zxing/library` is a **peerDependency** of `@zxing/browser` (used by
  the unrelated inventory barcode-scanning UI,
  `BarcodeScanButton.tsx`/`camera-support.ts`) that this repository's own
  `package.json` never lists as a direct dependency, so a fresh
  `npm install` never pulls it in. This is a pre-existing gap in the
  repository's own dependency manifest, with zero file overlap with the
  offline module — confirmed by installing `@zxing/library` locally
  (`npm install --no-save`, not committed, not part of this pass's diff)
  and re-running the build, which then succeeded cleanly. This pass did
  **not** modify `package.json` to add `@zxing/library`, since fixing an
  unrelated barcode-scanning dependency gap is out of ME-09's scope per
  the mandate's own §13 — it is disclosed here as a genuine, pre-existing
  environment issue for a human to decide whether to fix separately, not
  silently worked around or silently left unmentioned.
- No other new or pre-existing failure was found anywhere in the full
  validation pass.

## J. Database changes

None. No migration was created; none was needed — the defect fixed in
§C is entirely in client-side TypeScript logic (`syncEngine.ts`), not a
schema or RLS concern.

## K. Production changes

None. Production was not touched, per the mandate's own §12 instruction
and this repository's own "never modify production data casually" rule.

## L. Remaining certification limitations

- ~~The interaction between ME-08's ticket-cancellation sync and this
  module's `fire_to_kitchen` replay~~ — **closed by §N.** This was
  investigated against the actual merged code once ME-07/ME-08 landed
  on `claude/me-00-baseline-lock`, proven safe with two new regression
  tests, and required no code fix. No open item remains here.
- `docs/p10-offline-operations.md` §15's own disclosed limitation
  stands unchanged: full live-auth, live-data Playwright certification
  of the authenticated UI flow (open order → offline → sync → server
  ack) was not attempted in this pass either, for the same reasons
  already documented there (no local Supabase stack available; a live
  production write from an unattended E2E run is excluded by this
  repository's own rules). This is a pre-existing, disclosed limitation
  of the P10/ME-09 offline capability as a whole, not a new gap
  introduced or newly discovered by this pass.
- The pre-existing `@zxing/library` dependency-manifest gap (§I) is
  disclosed but not fixed, as it is out of this pass's scope.

## M. Final ME-09 status: **GREEN / CLOSED** — survives integration with ME-07 and ME-08

One real defect was found through genuine reconnaissance (not assumed
from documentation), fixed with the smallest correct change, covered by
5 new regression tests. ME-07 and ME-08 were then merged into the
canonical baseline; this branch was merged forward onto that integrated
state and independently re-investigated against the real, integrated
code (§N) — not assumed compatible from the pre-merge branch diffs. The
one interaction flagged as "plausible, not yet tested" in the original
pass was proven safe by two new tests exercising the actual function the
offline module calls (`fireOrder`), with **zero code change required**:
`fireOrderItemsCore`'s pre-existing `status === "ordered"` gate and
ME-08's `cancelKitchenTicketItemsForOrderItems` compose correctly
because they never need to know about each other — the order-item
status column is the single source of truth both already agree on.
`add_item`/`open_order` replay is likewise unaffected by ME-07's
changes, which are gated entirely behind the guest-only `trusted: false`
path the offline module's staff/POS replay never takes.

**Kitchen/offline interaction: no defect found.** Replay/idempotency,
conflict propagation, and kitchen/bar operational state all hold under
the actual integrated code — verified by test, not by inspection alone.

Full validation was re-run against the integrated code and is entirely
green (§H): 183 files / 2207 tests, 0 new typecheck errors, 0 lint
problems, production build green, bundle provenance clean, 15/15
real-Chromium offline e2e. Every pre-existing gap (3 typecheck errors,
the `@zxing/library` manifest gap, the disclosed live-auth E2E
limitation) remains evidenced as pre-existing and unrelated.

**ME-09 is formally GREEN/CLOSED.** PR #31 has been updated (merge
commit bringing in `claude/me-00-baseline-lock`'s current tip, plus the
§N integration tests and this report's updates) and is ready for human
review and merge. This session has not merged it and will not — per
this repository's process rules, merging PR #31 into
`claude/me-00-baseline-lock` remains a decision for the human operator.
