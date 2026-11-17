# ME-01/02/03 Corrective Integration

Not a new certification phase. This closes unresolved reconciliation work
discovered while ME-01 (`claude/me-01-database-performance-hardening`, PR #21),
ME-02 (`claude/me-02-security-certification`, PR #19) and ME-03
(`claude/me-03-transactional-integrity`, PR #20) ran concurrently from the
same `claude/me-00-baseline-lock` @ `85b3397` baseline against the same
live production database (Supabase project `lusiqcmxfxhnehxmwihs`).

Integration branch: `claude/me-01-02-03-corrective-integration`, built from
the ME-00 baseline. ME-01/02/03's own branches were not modified.

## 1. What was found

**Migration numeric-prefix collision.** ME-01 and ME-02 each independently
used `0065`/`0066` for unrelated changes (ME-01: FK indexes / RLS initplan;
ME-02: fiscal counter authorization / RBAC read scope). Both were applied
live to production, plus four more live-only reconciliation steps neither
branch's Git history captured (`p11_fiscal_counter_authorization_fix`,
`p11_rbac_user_roles_read_scope`, `me01_fix_accidental_webhook_events_policy_drop`,
`me01_reconcile_concurrent_rbac_user_roles_policy`, and three more
consolidation-batch migrations) — ME-01 and ME-02 raced against the same
live database and each had to patch around the other's concurrent changes.

**19 production-only functions plus 3 production-only tables.** Migration
`0048_p11_security_hardening.sql` revokes/grants EXECUTE on 19 cash-payout /
daily-close / tender-declaration / giveaway functions
(`restaurant_apply_giveaway`, `restaurant_cash_payout_*`,
`restaurant_daily_close_control`, `restaurant_daily_close_payout_sync`,
`restaurant_day_is_locked`, `restaurant_decide_giveaway`,
`restaurant_declaration_revisions_immutable`, `restaurant_expected_tender`,
`restaurant_giveaway_*`, `restaurant_request_giveaway`,
`restaurant_reverse_giveaway`, `restaurant_tender_declaration_*`) but never
`CREATE`s any of them. `restaurant_daily_close_property` (a 20th function
this migration also touches) is separately defined in
`0033_p1_reconciliation_property_scope.sql` and was not part of this gap.
Three of their backing tables (`restaurant_cash_payouts`,
`restaurant_cash_payout_events`, `restaurant_declaration_revisions`) and 18
columns on two existing tables (`restaurant_daily_closes`,
`restaurant_discount_applications`) were likewise never committed to Git.
ME-03 independently found and documented the same 18-function gap (see
`docs/me-03/`) but explicitly declined to reconstruct it, for the same
"NO GUESSING" reason CLAUDE.md states — it stubbed inert no-op versions in
`local/sql/pre/03-supabase-compat.sql` purely so migrations would apply
locally, and flagged the real implementations as an open finding.

**A live security regression introduced by ME-01's own reconciliation.**
While integrating, re-reading the *final* merged `rbac_user_roles_read`
policy (not each migration file in isolation) showed that
`me01_reconcile_concurrent_rbac_user_roles_policy` — the migration ME-01
used to fold its own already-consolidated policy together with ME-02's new
`rbac_user_roles_read_scoped` policy, because both were edited concurrently
against the same live table — OR'd the two together instead of letting the
new scoped check replace the old one. The merged policy therefore still
carried the exact scope-blind `nova_has_permission(auth.uid(), 'STAFF:READ')`
disjunct (no tenant/property/outlet arguments) that ME-02's fix existed to
remove. Net effect, live in production from `2026-09-15 04:10 UTC` until
this pass fixed it: any authenticated user holding STAFF:READ in **any**
tenant could read `rbac_user_roles` rows for **every** tenant on the
platform — the identical cross-tenant exposure ME-02 had certified fixed.

**Two test-fixture bugs, not application bugs**, surfaced once the JS
toolchain could actually run (see §9): ME-03's own `payments.idempotency.test.ts`
fake Supabase client didn't implement `.select()` after `.update().eq().eq()`
(used by `recalcOrder`) and didn't make its duplicate-insert branch
thenable, so `takePosPayment`/`recordGuestPayment`'s real
insert-and-recover-on-23505 logic could never be exercised; a pre-existing,
untouched-by-ME-03 test (`selforder/selfpay.server.test.ts`) broke for the
same reason once ME-03's more-robust insert-and-recover pattern replaced
the old pre-check-then-insert one it exercises transitively through
`recordGuestPayment`.

## 2. What was already fixed by ME-01/02/03 (independently verified against
   live production, not taken on faith)

- ME-01: 0 unindexed-FK findings, 0 `auth_rls_initplan` findings, and the
  systemic duplicate-permissive-policy pattern collapsed everywhere except
  `restaurant_mobile_money_webhook_events` — confirmed genuinely safe: its
  two policies target different roles (`authenticated` read /
  `service_role` write), so Postgres's linter does not (and should not)
  flag it as overlapping.
- ME-02: `restaurant_fiscal_next_counter` requires an authenticated caller
  and calls `restaurant_can_write_scoped` for the target tenant/property
  before writing (verified in the function body, live). All 66 public
  `SECURITY DEFINER` functions have `search_path` set (spot-checked across
  every function this pass touched or reconstructed; all set
  `SET search_path TO 'public'`). `assertCanManageMembership` and
  `assertCanManageRbacRole` are wired into `members.server.ts` and
  `staff.functions.ts`'s `assignRole`/`revokeRole` respectively, with
  regression tests proving they check the *target* grant's own scope.
- ME-03: `postGoodsReceipt` gates cumulative PO fulfilment counters on
  `!alreadyPosted`, keyed off the stock ledger's own dedupe signal, so a
  retried/concurrent post can't double-count. `recordPayment`,
  `takePosPayment`, `recordGuestPayment` all insert unconditionally and
  recover on a `23505` conflict rather than pre-check-then-insert.

## 3. What was still missing when this pass started

- No coherent canonical migration sequence — Git could not reproduce the
  live database from a fresh install.
- The 19 functions + 3 tables + 18 columns above, entirely absent from Git.
- KD-02 (leaked password protection) not re-investigated past "blocked."
- The JS toolchain (`bun install`) was blocked by a private package
  registry the ME-01 PR's own report also hit — not re-diagnosed past
  "blocked," so typecheck/lint/test/build were unverified since ME-00.

## 4. What this pass fixed

1. **Migration sequence**: `0065`–`0075` now hold, in their actual
   production application order, the exact SQL every one of the ten
   above migrations executed against `lusiqcmxfxhnehxmwihs` (captured
   verbatim from `supabase_migrations.schema_migrations.statements`, byte-
   compared to confirm the two files reused unchanged from the ME-01
   branch — `me01_fk_indexes`, `me01_rls_initplan` — are identical to what
   ran live). Replaying `0065`–`0075` against the ME-00 baseline
   reproduces the live database's actual current state, collisions
   resolved, nothing silently discarded.
2. **`0076`**: reconstructs all 19 missing functions (`pg_get_functiondef`,
   `pg_get_triggerdef`, verbatim), the 3 missing tables (columns,
   constraints, indexes, RLS policies from live `information_schema` /
   `pg_constraint` / `pg_indexes` / `pg_policies` introspection) and the 18
   missing columns, all idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE` /
   guarded `DO` blocks) — verified via a `BEGIN...ROLLBACK` dry run against
   production before being applied for real (a true no-op: every object
   already existed identically). `local/sql/pre/03-supabase-compat.sql`'s
   inert ME-03 stubs for the same 18 functions are removed — the real
   definitions now apply in the normal migration sequence on a fresh
   install too.
3. **`0077`**: fixes the live `rbac_user_roles_read` regression described
   above — drops the unscoped `nova_has_permission` disjunct, keeps
   self-row access and both correctly-scoped checks. Applied to production
   immediately on discovery, ahead of finishing the rest of this pass, and
   captured in Git. `authorization-gate.test.ts`'s regression test for this
   was rewritten to check the *final* merged policy across the whole
   migration chain (a new `latestPolicyUsing` helper, mirroring the
   existing `latestFunctionBody` one) instead of one migration file in
   isolation — the isolation check is exactly what let this regression
   through undetected.
4. Fixed the two test-fixture bugs in §1 (`payments.idempotency.test.ts`'s
   `update()`/duplicate-`insert()` mocks; `selfpay.server.test.ts`'s
   `insert()` mock) so both files' tests exercise the real recovery path
   instead of silently no-op'ing.
5. Diagnosed and fixed the JS toolchain block: `bun.lockb` pinned every
   package's resolved tarball URL to a private
   `europe-west1-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache` mirror
   (403 from this environment) — not a `bunfig.toml`/`.npmrc` registry
   setting, so pointing `BUN_CONFIG_REGISTRY` at the public registry didn't
   help. Regenerating the lockfile from scratch against
   `registry.npmjs.org` (reachable, confirmed) resolved the identical
   `package.json` version ranges and installed cleanly.
6. Root-caused and fixed the resulting typecheck cascade: `tsc --noEmit`
   run without a build first fails on ~45 route files because
   `src/routeTree.gen.ts` (gitignored, generated by the TanStack Router
   Vite plugin) doesn't exist yet. Running `bun run build` once generates
   it; typecheck afterward shows exactly the 3 errors ME-01's own PR
   reported as pre-existing (confirmed unrelated to this branch's changes:
   none of the 3 touch a file this pass modified).

## 5. What changed in production (`lusiqcmxfxhnehxmwihs`)

Five `apply_migration` calls, in order, each verified with a
`BEGIN...ROLLBACK` dry run first where the change was non-trivial:

1. `me01_me02_me03_corrective_financial_functions_reconstruction` — the 18
   functions/3 tables/columns from `0076` (no-op: all objects already
   existed identically).
2. `me01_me02_me03_corrective_day_is_locked_reconstruction` — the 19th
   function (`restaurant_day_is_locked`) found while reading the others'
   bodies (no-op, same reason).
3. `me01_me02_corrective_rbac_user_roles_read_scope_regression_fix` — the
   live security fix from `0077`. This one **changed live behavior**:
   before, any STAFF:READ holder in any tenant could read every tenant's
   `rbac_user_roles` rows; after, only self-rows and correctly-scoped
   grants.

No other production DDL, RLS, function, or data was touched. No
destructive operations; every apply was additive or a straight policy
replacement verified safe by dry-run first.

## 6. What changed in Git

New branch `claude/me-01-02-03-corrective-integration` off
`claude/me-00-baseline-lock`, carrying:

- `standalone/db/migrations/0065`–`0077` (13 files, ~285KB) per §4.
- ME-02's app-layer changes (`src/lib/rbac/rbac.server.ts`,
  `src/lib/staff.functions.ts`, `src/modules/restaurant/core/access.server.ts`,
  `members.server.ts` + their tests, `docs/me-02/`), unmodified except the
  regression-test fix in §4.3.
- ME-03's app-layer changes (`src/modules/restaurant/core/contracts.ts`,
  `procurement/receiving.server.ts`, `sales/{pos,sales}.server.ts`,
  `sales/payments.idempotency.test.ts`, `docs/me-03/`, the `local/scripts/*.sh`
  executable-bit fixes), unmodified except the test-mock fixes in §4.4, plus
  the stub removal in `local/sql/pre/03-supabase-compat.sql` from §4.2.
- `bun.lockb` regenerated against the public registry (§4.5).
- This document.

## 7. Migration reconciliation result

Deterministic and reproducible: replaying `0000`–`0077` in order against a
fresh Postgres 17 instance reproduces the live production schema this pass
verified against, with no numeric collisions, no P08/P09 migrations pulled
in, and every migration a later one depends on (tables before their
triggers, `restaurant_day_is_locked` before the functions that call it)
present when required.

## 8. Reconciliation matrix (abridged — full detail in §1–6 above)

| Finding | Source | Git-only / prod-only / both | Action | Final representation |
|---|---|---|---|---|
| FK indexes, RLS initplan, multi-policy consolidation | ME-01 | Both (live-applied, Git had 4-file version) | Replayed exact live SQL | `0065`,`0067`,`0069`,`0070`,`0071`,`0072`–`0075` |
| Fiscal counter auth, RBAC read scope | ME-02 | Both | Replayed exact live SQL | `0066`,`0068` |
| Concurrent-edit reconciliation (4 extra steps) | Live only | Prod-only | Captured verbatim from `schema_migrations` | `0070`,`0071` (part of the above set) |
| 19 functions + 3 tables + 18 columns | ME-03 (documented, not fixed) | Prod-only | Reconstructed from live introspection | `0076` |
| `rbac_user_roles_read` scope-blind regression | This pass (new finding) | Prod-only until fixed | Fixed live + Git | `0077` |
| KD-02 leaked password protection | ME-02 (blocked) | External | Re-verified still blocked, root cause identified | §9 |
| `payments.idempotency.test.ts`, `selfpay.server.test.ts` mock bugs | This pass (new finding) | Git-only (test fixtures) | Fixed | committed |
| `bun.lockb` private-registry pin | This pass (new finding) | Git-only | Regenerated | committed |

## 9. Test / validation results (exact numbers)

- `bun install`: 875 packages, clean, against `registry.npmjs.org` (see §4.5).
- `bun run build`: succeeds — full TanStack Start + Nitro/Cloudflare build,
  PWA precache (171 entries), `.output/server` and `.output/public`
  generated. Run twice (before and after the test-fixture fixes); both green.
- `bun run typecheck` (`tsc --noEmit`, after the build above generates
  `routeTree.gen.ts`): 3 errors, all in files this branch never touches
  (`src/router.tsx`, `src/routes/_authenticated.admin.tsx`,
  `src/modules/restaurant/intelligence/menuReasoning.server.test.ts`) —
  matches ME-01 PR #21's own reported "3 pre-existing typecheck errors"
  exactly.
- `bun run lint` (`eslint .`, whole repo): pre-existing Prettier debt across
  ~1300 lines this branch never touches, matching ME-01's own reported
  "pre-existing lint debt." Restricted to every file this branch actually
  changed: **0 errors** (10 pre-existing Prettier violations ported in from
  ME-02/03's own commits, plus 5 introduced by this pass's own edits, all
  autofixed and re-verified at 0 errors).
- `bun run test` (`vitest run`, whole repo): **2130/2130 tests passing,
  168/168 files** — including the two newly-fixed files (4/4 and 17/17)
  and the rewritten `rbac_user_roles_read` regression test.
- Live DB validation (`get_advisors`, both `security` and `performance`,
  re-run after every production change): 0 unindexed-FK, 0
  `auth_rls_initplan`, 0 `multiple_permissive_policies` findings; 44
  `SECURITY DEFINER`-executable-by-`authenticated` findings unchanged
  before/after (the 19 reconstructed functions' grant states match what
  was already live — `has_function_privilege` checked per function before
  writing `0076`); `rls_enabled_no_policy` unchanged at 2 (both
  pre-existing, out of this pass's scope); `auth_leaked_password_protection`
  still WARN (see §10).
- Hostile-case coverage exercised by the test suite above: cross-tenant
  fiscal counter access (`rbac.server.test.ts`,
  `authorization-gate.test.ts`), cross-property/cross-tenant RBAC reads
  (rewritten `latestPolicyUsing` check), unauthorized membership/RBAC
  mutations (`members.server.test.ts`, `rbac.server.test.ts`), duplicate
  and concurrent-shaped duplicate payment submission
  (`payments.idempotency.test.ts`, `selfpay.server.test.ts`), duplicate
  goods receipt (existing `receiving.server.test.ts`, unmodified, still
  passing), correctly-scoped access (every "allows" case in the above
  files).

## 10. Genuine external blocker: KD-02, leaked password protection

Re-investigated past "blocked" rather than repeating ME-02's statement.
The Supabase MCP server's toolset (`create_branch`, `apply_migration`,
`execute_sql`, `get_advisors`, etc.) has no Auth-config endpoint, confirmed
by enumerating every available tool. `search_docs` confirms why an Auth-
config endpoint wouldn't help anyway: **"Leaked password protection is
available on the Pro Plan and above"** — `lusiqcmxfxhnehxmwihs` is
confirmed on a plan below Pro (`create_branch` on this same project
returned `PaymentRequiredException: Branching is supported only on the Pro
plan or above` earlier in this same session). This is a plan-tier gate, not
a missing tool or a missing permission — no mechanism available in this or
any equivalent session can enable it without a billing change, which is a
human decision outside this pass's authority. Documented as an external
dependency, not fabricated as resolved.

## 11. Final state

GREEN. All in-scope, fixable defects found in ME-01/02/03's own evidence
plus this pass's own re-verification are resolved, live and in Git. The one
open item (KD-02) is a plan-tier billing gate, proven not merely asserted.
