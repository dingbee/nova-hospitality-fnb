# P10 — Offline Operations Capability

Status: implemented, tested, and certified within the scope defined below.
This document describes only what is actually implemented and wired into
the running application — not aspiration, not a roadmap.

## 1. What this is

A durable offline operating capability for the LexiBite POS terminal
(`src/modules/restaurant/offline/`), covering the narrow slice of the POS
lifecycle that can be made safely queueable without weakening server
authorization, inventing a second transactional model, or risking a
duplicate financial/production effect: **opening an order, adding items to
it, and firing those items to the kitchen/bar**, while the device has no
network connectivity.

It is not a general-purpose offline app framework, not a service-worker
cache trick, and not a client-side "looks synced" illusion. Every mutation
still runs through the exact same server functions, the exact same
Supabase RLS, and the exact same `client_request_id` idempotency pattern
the online POS already uses — see §3.

## 2. Safety boundary — what is and is not offline-capable

Every POS/service operation was classified once, centrally, in
[`contracts.ts`](../src/modules/restaurant/offline/contracts.ts)
(`OFFLINE_CLASSIFICATION` + `CLASSIFICATION_RATIONALE`), and the UI and
sync engine both read that same table — there is no second, UI-only
classification that could drift from it.

| Operation | Classification | Why |
|---|---|---|
| Menu/catalog read | OFFLINE_SAFE | Read-only, served from the cached operational snapshot. |
| Table/service context read | OFFLINE_SAFE | Same snapshot. |
| **Open order** | **OFFLINE_QUEUEABLE** | Idempotent via `restaurant_orders.client_request_id` (pre-existing mechanism). |
| **Add item(s)** | **OFFLINE_QUEUEABLE** | Idempotent via `restaurant_order_items.client_request_id` (extended this pass — migration `0056_p10_order_items_client_request_id`). |
| **Fire to kitchen/bar** | **OFFLINE_QUEUEABLE** | Naturally idempotent — operates on the set of un-fired ("ordered") lines; a replay with nothing left to fire is a correct no-op, not a duplicate ticket. |
| Change item quantity | ONLINE_REQUIRED | Mutates an existing line by id. A safe conflict rule for a line that was fired/voided/paid by the time the device reconnects was not specified this pass — shipping a handler without one would be guessing. Not silently dropped: explicitly online-only. |
| Remove item | ONLINE_REQUIRED | Same reasoning as change-quantity. |
| Order status progression | ONLINE_REQUIRED | Reflects live kitchen/service state; must not be replayed from a stale local view. |
| Close order / payment / receipt | ONLINE_REQUIRED | Financial; payment requires live external confirmation (card/mobile money/gateway) and must never be represented as confirmed before the server actually confirms it. |
| Inventory movement | ONLINE_REQUIRED | High-risk; out of scope this pass. |
| Fiscalisation | ONLINE_REQUIRED | Regulatory; requires live TRA/EFD submission. |
| Guest ordering | **FORBIDDEN_OFFLINE** | A guest device has no staff principal and no device-identity registration. Letting it queue writes offline would mean accepting unauthenticated order injection with no server round trip to check against. |
| Staff admin / reservations / configuration | ONLINE_REQUIRED | Outside the continuity-of-service boundary this pass targets; must never be based on a stale snapshot. |

`QUEUEABLE_OPERATION_TYPES` (`open_order`, `add_item`, `fire_to_kitchen`) is
a closed set enforced in code, not just documentation — the sync engine's
`runOperation` switch is exhaustive over it (TypeScript `never` check), so
adding a new queueable type requires a real handler, not just a wider type.

## 3. No parallel transactional model

The offline module owns **zero** business logic. `adapters.ts` is the one
place it touches the real POS — it binds the sync engine's generic
`SyncCallers` interface directly to the production TanStack server
functions (`openPosOrderFn`, `addPosLinesFn`, `fireRestaurantOrderFn`),
the same functions the online POS calls, through the same
`requireSupabaseAuth` bearer-token middleware and the same RLS-scoped
Supabase client. A replayed queue entry is not a simulation of the online
path — it *is* the online path, called later.

Pricing/tax is still always server-derived: `insertLines` (sales.server.ts)
re-derives price/tax from the catalogue for every catalogued line
regardless of what the client proposed — the offline layer does not
second-guess or duplicate that defense, it just delays *when* the call
happens.

## 4. Durable local storage

`db.ts` — a minimal, hand-rolled promise wrapper over the browser's native
IndexedDB (no `idb`/`Dexie` dependency added; the repo already avoids a
dependency where the platform solves the requirement). Six stores,
versioned schema (`DB_VERSION`), tenant-indexed:

- `device_identity`, `operational_snapshot`, `transaction_queue`,
  `sync_state`, `conflict_records`, `local_audit`.

Tenant isolation is enforced by the module itself, not merely trusted from
the caller — every read/query function requires a `tenantId` and filters
by it (IndexedDB has no RLS equivalent). No secrets or auth tokens are
ever written to IndexedDB; the session itself stays exactly where Supabase
Auth already puts it (see §6).

## 5. Device identity

`device.ts` — `registerDevice({tenantId, propertyId, outletId})` generates
a `crypto.randomUUID()` once and persists it; re-registration for the same
scope reuses the same id and bumps a `registrationEpoch`.
`detectDeviceContextChange()` reports `unregistered` / `tenant_changed` /
`outlet_changed` so the sync engine and UI can refuse to silently carry a
device's queue across a tenant/outlet boundary. The device id is a
**correlation identifier**, never an authorization token — it grants
nothing by itself; every replayed mutation still goes through the real
Supabase-authenticated server function.

## 6. Offline session model — no new auth system

`auth.ts` reads the existing Supabase Auth session
(`supabase.auth.getSession()`) and classifies it as `unauthenticated` /
`valid` / `expiring_soon` / `expired`. There is no offline credential
store, no cached password, no second login flow. `canQueueNewOfflineWork`
refuses to accept new queued work once the session is `expired` — the
device can still hold what it already queued, but cannot pretend to keep
operating as a since-revoked or since-expired principal. When the sync
engine later replays against a session that has since lost authorization
(role changed, tenant access revoked), the real server function correctly
rejects it — `conflict.ts`'s `UNAUTHORIZED_PATTERNS` /
`FORBIDDEN_PATTERNS` recognize the exact rejection messages
`requireSupabaseAuth` produces and classify them as `REQUIRES_OPERATOR`,
non-retryable, never silently dropped.

## 7. Operational snapshot

`snapshot.ts` — `storeSnapshot(scope, board, catalog)` /
`getCachedSnapshot(scope)`. Every cached snapshot carries its own
`generatedAt` and is tenant-cross-checked on read. `isStale()` /
`snapshotAgeMs()` (30-minute staleness window) let the UI show a `STALE`
state honestly rather than silently presenting cached data as live.

## 8. Transaction queue

`queue.ts` over the `transaction_queue` IndexedDB store. Every
`QueuedOperation` (see `contracts.ts`) carries `operationId`,
`clientRequestId`, `deviceId`, `tenantId`/`propertyId`/`outletId`,
`operationType`, `payload`, `createdAt`, a monotonic local `sequence`
(`sequence.ts`), `attemptCount`, `state`, `lastAttemptAt`,
`failureReason`, `retryable`, `serverResult`, and `dependsOnOperationId`
(for an `add_item`/`fire_to_kitchen` op queued against an order that is
itself still only a queued, not-yet-synced `open_order`).

States: `PENDING → PROCESSING → SYNCED`, or
`RETRYABLE_FAILURE`/`CONFLICT`/`DEAD_LETTER`/`CANCELLED`. Nothing ever
deletes a failed entry — `pruneSynced` only ever removes old **SYNCED**
rows. `enqueue()` enforces a tenant-scoped unique index on
`clientRequestId` (`by_tenant_clientRequestId`, `unique: true`) so a
double-click before the in-memory guard runs cannot create two queue
entries racing for the same idempotency key.

## 9. Idempotent replay

Extends the **existing** `client_request_id` mechanism rather than
inventing a parallel one:

- `open_order` → `restaurant_orders.client_request_id`
  (`UNIQUE (tenant_id, client_request_id) WHERE client_request_id IS NOT NULL`,
  pre-existing).
- `add_item` → `restaurant_order_items.client_request_id`, added this pass
  (migration `0056_p10_order_items_client_request_id`, live in production
  — see §14). `addPosLines` now does an existence-check before insert and
  returns `idempotent: true` on a replay hit rather than inserting a
  second time.
- `fire_to_kitchen` → no new column needed; naturally idempotent (§2).

## 10. Synchronization engine

`syncEngine.ts`. Lifecycle: connectivity restored → `syncPendingQueue`
processes every `PENDING`/`RETRYABLE_FAILURE` entry for one tenant, in
strict local `sequence` order, resolving `dependsOnOperationId` chains via
`resolveOrderRef` (an add_item queued against a still-local open_order
resolves to the real server order id once that dependency reaches
`SYNCED`; otherwise it is skipped this pass, not attempted out of order,
and picked up automatically next call).

- **Bounded retry**: `MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 5`; a transient
  failure moves to `RETRYABLE_FAILURE` and is retried on the next sync
  call, never in an internal loop — `syncPendingQueue` never schedules its
  own retry, so there is no possibility of a hot loop regardless of what
  calls it.
- **Concurrency-protected**: a module-level `Set<string>` lock
  (`tenantsSyncing`) rejects a second concurrent sync for the same tenant
  (`alreadyInProgress: true`) rather than double-processing the same
  entry — found and fixed as a real race during this pass's own test
  development (a concurrent-call test hung before the fix).
- **Partial-failure / dead-letter**: each operation is classified
  independently; one failing entry never blocks the rest of the queue.
- **Observable**: `syncStatusFor(tenantId)` returns pending/processing/
  conflicts/dead-lettered/synced counts for the connectivity UI.

## 11. Conflict model

`conflict.ts`'s `classifyOutcome(operationType, {result, error})` maps a
server response/error to one of `contracts.ts`'s `CONFLICT_OUTCOMES`
(`AUTO_RESOLVE` / `SERVER_WINS` / `CLIENT_WINS` / `MERGE` /
`REQUIRES_OPERATOR`). For the three operation types this pass actually
replays, the detector only ever produces `SERVER_WINS` or
`REQUIRES_OPERATOR` — conservative by construction, never a silent
`CLIENT_WINS` overwrite of financial/inventory/production state.
Recognized patterns: not-found, `Forbidden: ...` and `Unauthorized: ...`
(the real `requireSupabaseAuth` rejection text — verified against all six
of its actual rejection messages), and closed-order rejections. Every
conflict is persisted to `conflict_records` (`recordConflict`), never just
logged and forgotten.

## 12. Connectivity UX

`connectivity.ts` wraps the browser's `navigator.onLine` +
`online`/`offline` events behind a single subscription (deduped across
multiple subscribers — verified no duplicate `window` listeners are
attached). `ui/ConnectivityIndicator.tsx` renders the resulting state
(`ONLINE`/`OFFLINE`/`SYNCING`/`SYNCED`/`SYNC_ERROR`/`STALE`) via the
existing `StatusChip` component — no bespoke "working..." spinner that
hides a real failure.

## 13. Real POS UI wiring

`useOfflineSync.ts` — the hook `PosWorkspace.tsx` calls. It resolves the
device identity, exposes `status`, `isOffline`, `queueOpenOrder`,
`queueAddItems`, `queueFireToKitchen`, `runSync`, `refreshStatus`.

`PosWorkspace.tsx` wiring (existing ~1400-line component, extended, not
replaced):

- `openBill`'s mutation branches on `offlineSync.isOffline`: online,
  unchanged behavior; offline, calls `queueOpenOrder` instead of the real
  server call and holds the result as local `queuedOrder` state.
- `sendLines`'s mutation branches on `offlineSync.isOffline || queuedOrder`:
  queues an `add_item` op (and a dependent `fire_to_kitchen` op when the
  caller fires immediately) against an `OrderRef` that is `{kind:"local"}`
  until the parent `open_order` syncs, `{kind:"server"}` after.
- The Bill panel has an explicit, narrow branch for
  `!orderId && queuedOrder`: a **minimal local cart view** (item list,
  running total, send buttons) reusing the existing `lineTotal`/`money`/
  `billTotal` helpers — deliberately not the full online Bill UI. Payment,
  receipt, and void remain unavailable until the order is
  server-confirmed; this is a disclosed scope boundary, not an oversight.
- Menu item cards are enabled under `(!orderId && !queuedOrder) === false`
  i.e. also usable against a queued-but-not-yet-synced local order.
- `ConnectivityIndicator` is visible near the existing mute control, plus
  a dashed-border banner while a `queuedOrder` is active, so the operator
  always sees LOCAL/QUEUED state distinctly from SERVER-CONFIRMED — the
  UI never says "Order sent" or implies kitchen receipt for a queued, not
  yet synced, operation.

## 14. Live database verification (production)

Migration `0056_p10_order_items_client_request_id`
(`p10_order_items_client_request_id`, version `20260911162738`) is applied
to the production project (`lusiqcmxfxhnehxmwihs`). Verified directly
against the live schema, not assumed from the migration file:

- `restaurant_order_items.client_request_id` — `text`, nullable. Correct:
  a batch insert from one `addPosLines` call shares one client-request id
  across multiple rows, so a per-row `UNIQUE` would be wrong; confirmed no
  such constraint was added.
- Index `restaurant_order_items_client_request_idx` —
  `btree (tenant_id, order_id, client_request_id) WHERE client_request_id IS NOT NULL`
  — present, non-unique, partial (matches intent).
- RLS: `restaurant_order_items`'s existing tenant/property-scoped
  read/write policies (`restaurant_can_read_scoped` /
  `restaurant_can_write_scoped`) are row-level and unaffected by adding a
  column — no new policy was needed and none was added, so no new
  authorization surface was introduced by this migration.
- Security advisors: no new finding attributable to this migration (only
  the pre-existing, already-disclosed P11 baseline items — leaked-password
  protection, `SECURITY DEFINER` RBAC functions, `migration_transfer_audit`/
  `user_roles` RLS-no-policy).
- Performance advisors: one expected, benign `INFO`-level "index has not
  been used" finding on the new index — correct and expected, since no
  live offline sync traffic has hit production yet; not evidence of a
  wrong index choice.

## 15. Browser certification scope

Real-Chromium certification (`e2e/offline-realbrowser.spec.ts`, run via
`npx playwright test`) exercises the **actual, unmodified** `db.ts` /
`device.ts` / `queue.ts` / `connectivity.ts` / `snapshot.ts` source
(bundled as-is by `e2e/support/build-harness.ts`, not reimplemented for
testing) inside real Chromium — desktop, tablet (iPad viewport), and
mobile (Pixel viewport) — proving:

- A queued operation survives a real page reload (real IndexedDB
  persistence, not the Node `fake-indexeddb` polyfill used by the unit
  suite).
- Device identity is stable across a real reload.
- The browser's own IndexedDB engine enforces the tenant-scoped unique
  index on `clientRequestId` (not just application-level logic).
- Tenant isolation holds in real IndexedDB.
- `subscribeConnectivity` reacts correctly to a real Chromium
  offline→online transition (`context.setOffline`), not a simulated DOM
  event.

15/15 pass across all three device projects.

**What this does not cover, and why**: full end-to-end certification of
the authenticated `open order → offline → add items → fire → reconnect →
sync → server ack` flow through the real UI, against live production
auth/data, was evaluated and not attempted. This app's server functions
(`openPosOrderFn` etc.) run in the Node server process and call Supabase
directly — Playwright's browser-level request interception cannot stand
in for that without either exercising real production tenant data (this
repository's own rules: "never modify production data casually" — a real
production write from an unattended E2E run is a materially risky,
hard-to-reverse action) or standing up a full local Supabase stack, which
was not available in this environment and is a separate, large
infrastructure project of its own. This gap is disclosed, not hidden; the
equivalent logic (queueing, dependency ordering, replay, conflict
handling) is fully covered by the 94-test vitest suite (`syncEngine.test.ts`,
`chaos.test.ts`, `security.test.ts`) against real (fake-indexeddb,
spec-compliant) IndexedDB semantics, and the UI wiring itself
(`PosWorkspace.tsx`) was reviewed and typechecked but not driven through a
live browser session in this pass.

The Playwright harness (`playwright.config.ts`, `e2e/`) is test-only
infrastructure: it is not part of the deployed application, adds no new
route or attack surface to the shipped product, and its generated build
artifacts (`e2e/.generated/`) are gitignored.

## 16. Test evidence

- `src/modules/restaurant/offline/*.test.ts` — 10 files, 94 tests:
  `db.test.ts`, `device.test.ts`, `auth.test.ts`, `connectivity.test.ts`,
  `queue.test.ts`, `conflict.test.ts`, `syncEngine.test.ts`,
  `snapshot.test.ts`, `security.test.ts` (adversarial: tenant/device/user
  isolation, tampered payload, replay, cross-tenant replay, stale/revoked
  authorization), `chaos.test.ts` (reload/crash-mid-sync, repeated
  reconnect cycles, failed-mutation recovery).
- Full project suite: 165 files / 2109 tests, all passing (includes the
  94 above).
- `e2e/offline-realbrowser.spec.ts` — 15/15 passing (§15).
- `npx tsc --noEmit` — 0 new errors (3 pre-existing, unrelated baseline
  errors in `menuReasoning.server.test.ts`/`router.tsx`/
  `_authenticated.admin.tsx`, confirmed unchanged by this pass).
- `npx eslint .` — 0 new/regressed problems, verified by a precise
  file-level diff against the pre-P10 checkpoint (`6a66497`): every file
  this pass touched or added is clean; the ~1373 pre-existing
  prettier-formatting-only problems across ~210 unrelated files in this
  repository are unchanged (several incidentally improved) — a
  pre-existing baseline condition, not introduced by this work, and out
  of scope to mass-fix under "smallest correct change."
- `npx vite build` — production build succeeds; bundle provenance
  (`scripts/verify-bundle-origin.ts`) clean.

## 17. Known limitations (deliberate scope, not oversights)

- `change_quantity`/`remove_item` are not offline-queueable this pass —
  ONLINE_REQUIRED, per §2.
- The queued-order Bill view is a minimal local cart, not the full online
  Bill UI — payment/receipt/void require the order to be server-confirmed.
- Inventory movements, fiscalisation, and guest ordering remain
  ONLINE_REQUIRED/FORBIDDEN_OFFLINE — no offline stock ledger writes, no
  offline fiscal submission, no unauthenticated guest writes.
- Full live-auth, live-data Playwright certification of the UI flow was
  not performed, for the reasons in §15.
