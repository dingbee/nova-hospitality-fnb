# ME-09 — Offline Certification

## A. Executive certification

- **Baseline SHA:** `28f660bbfb36d0f6cd1572d3083ec6a150658dd7`
  (`claude/me-00-baseline-lock`) — verified independently against the
  GitHub API before any change was made (matched this session's actual
  git HEAD exactly).
- **Branch:** `claude/me-09-offline-certification`
- **PR:** opened as a draft against `claude/me-00-baseline-lock`, not
  merged by this session.
- **Scope:** ME-09 corresponds to P10 (Offline Operations Capability),
  already substantially implemented and documented in
  [`docs/p10-offline-operations.md`](../p10-offline-operations.md). This
  pass inspected that existing implementation end to end, found one real
  defect, fixed it with regression coverage, and added the queue/storage
  load certification that pass's own limitations section did not include.
- **Final status:** see §M. One real, evidenced defect found and fixed
  with regression tests. No other invariant violation was found in the
  existing implementation across the full reconnaissance in §B.

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

## F. Files changed

- `src/modules/restaurant/offline/syncEngine.ts` — the fix (§C).
- `src/modules/restaurant/offline/syncEngine.test.ts` — 3 new regression
  tests for the fix (direct DEAD_LETTER cascade, transitive
  grandchild cascade, CANCELLED-parent cascade).
- `src/modules/restaurant/offline/chaos.test.ts` — 2 new queue/storage
  load tests (§D).
- `docs/me-09/ME-09-offline-certification.md` — this report.

No database, migration, or production change of any kind.

## G. Tests added

5 new tests, all passing:

- `syncEngine.test.ts`: "a child whose parent open_order DEAD_LETTERs is
  cascaded to CONFLICT...", "a grandchild ... cascades transitively in
  the same pass ...", "a child whose parent was explicitly CANCELLED is
  also cascaded ...".
- `chaos.test.ts`: "a device that queued 500 operations ... replays every
  one correctly ...", "pruning at scale removes only aged SYNCED
  entries ...".

## H. Validation executed

- `npx vitest run src/modules/restaurant/offline` — **10 files / 100
  tests passing** (95 pre-existing + 5 new).
- `npx vitest run` (full project suite) — **181 files / 2193 tests
  passing**, no regressions.
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

- The interaction between ME-08's ticket-cancellation sync and this
  module's `fire_to_kitchen` replay (§E) is a plausible, undiscovered
  interaction this pass could not test without importing ME-08's own
  unmerged branch, which the operating instructions for this pass
  explicitly forbid. It should be added as an integration test during
  the human corrective-integration pass across ME-07/ME-08/ME-09.
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

## M. Final ME-09 status: **GREEN** (for the Offline Certification scope actually in this mandate)

One real defect was found through genuine reconnaissance (not assumed
from documentation), fixed with the smallest correct change, covered by
5 new regression tests, and validated against the full test suite,
typecheck, lint, production build, bundle-provenance check, and the
existing real-Chromium offline certification — all green, with every
pre-existing gap (3 typecheck errors, the `@zxing/library` manifest gap,
the disclosed live-auth E2E limitation) evidenced as pre-existing and
unrelated, not newly introduced or silently absorbed into this pass's own
result. The one item explicitly left open (§L's ME-08 interaction) is a
forward-looking recommendation for the human-run corrective-integration
pass across ME-07/ME-08/ME-09, not a gap in ME-09's own, narrower,
mandated scope.
