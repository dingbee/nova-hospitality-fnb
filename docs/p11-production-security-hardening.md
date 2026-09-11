# P11 — Production & Security Hardening Certification

## Scope note (read first)

P11's master prompt specifies 53 sections spanning database security,
authentication, tenant/property/outlet isolation, payments, fiscal,
storage, secrets, logging, monitoring, backup/recovery, deployment safety,
and a full production smoke test. This certification is honest about what
was verified with live production evidence in this pass versus what
remains unverified. Per the prompt's own anti-fabrication instructions,
unverified items are listed as such rather than assumed passing.

This session had **direct live access to the production Supabase project**
(`lusiqcmxfxhnehxmwihs`, `nova-hospitality-fnb`) via the Supabase
management tools, which is what made the fixes below possible — they are
applied to the real production database, not simulated.

---

## 1. Priority findings (master prompt §3–§6)

### 1.1 `has_any_role` ambiguous overload (§3)

**Status: was already resolved by pre-existing migrations, independently
re-verified.**

Migrations `0005_fix_has_any_role_ambiguity` and
`0005b_restore_has_any_role_defaults` were already applied to production
(confirmed via `list_migrations`). Live query against `pg_proc` confirms
**exactly one** `has_any_role` signature exists —
`has_any_role(uuid, app_role[], uuid, uuid, uuid)` — with
`SET search_path TO 'public'` already hardened. Zero RLS policies
currently reference it (the live RLS layer uses `restaurant_can_read` /
`restaurant_can_write` / `nova_has_permission` instead); it is called
directly via `.rpc()` from `rbac.functions.ts` and `access.server.ts` for
platform-level staff RBAC only. No further ambiguity exists.

### 1.2 `nova_user_roles_view` SECURITY DEFINER (§4) — **fixed, was a real P0**

**Confirmed root cause**: the view was `SECURITY DEFINER`, which bypasses
the RLS already correctly enforced on the underlying `rbac_user_roles`
table (`user_id = auth.uid() OR nova_has_permission(auth.uid(),
'STAFF:READ')`). Because the view had no `WHERE` clause of its own, this
meant **any authenticated user — and, before this fix, even an
unauthenticated `anon` caller — could query
`GET /rest/v1/nova_user_roles_view` with no filter and receive every
user's role/tenant/property/outlet assignment platform-wide**, bypassing
the app's own `assertPermission('STAFF:READ')` checks entirely. This is a
genuine cross-tenant metadata leak.

**Fix applied** (production, verified): `ALTER VIEW ... SET
(security_invoker = true)` — the view now runs with the querying user's
own privileges, so the *already-correct* RLS on `rbac_user_roles` applies
exactly as it does to direct table access. `anon` access revoked entirely;
`authenticated` access tightened to `SELECT`-only. All three real callers
in the app (`staff.functions.ts`, `rbac.functions.ts`, `access.server.ts`)
were read before this change and confirmed to query the view only through
the user's own session-scoped client — nothing needed to change in
application code, and the full test suite (1957 tests) confirms no
regression.

**Verified via live advisor**: the `security_definer_view` ERROR finding
is gone after the fix.

### 1.3 Anonymous execution review (§5) — **fixed, WARN → 0**

26 `SECURITY DEFINER` functions were directly callable by the `anon` role
via PostgREST RPC. Cross-referenced against every `.rpc(...)` call in the
application (`grep`) and every RLS policy `qual`/`with_check` referencing
these functions — **no legitimate anon (unauthenticated) use case exists
for any of them**; LexiBite's guest-ordering surface uses its own
session/table mechanism, not this staff RBAC/financial-control surface.

Two rounds of fixes were required: a per-role `REVOKE ... FROM anon` alone
did not clear most findings, because Postgres grants `EXECUTE` on new
functions to the `PUBLIC` pseudo-role by default, which every role
(including `anon`) inherits regardless of a role-specific revoke. The
second migration revoked `EXECUTE` from `PUBLIC` directly, re-granting it
explicitly only to `authenticated` where a real caller exists (`has_any_role`,
`has_role`, `is_any_staff`, `nova_has_permission`, `nova_permissions_for`,
`restaurant_cash_payout_total`, plus the RLS-embedded `restaurant_can_read`
/ `restaurant_can_write`).

17 of the 26 are zero-argument (or action-only) trigger/control functions
— cash payout control/immutability/no-delete/trail, daily close
control/sync, tender declaration archive/control, declaration-revision
immutability, and the entire giveaway workflow
(apply/decide/request/reverse/guard/no-delete/period-lock) — with **zero**
direct `.rpc()` callers anywhere in the application and **zero** RLS
references. Postgres trigger firing does not require the triggering role
to hold `EXECUTE` on the trigger function (only direct RPC invocation
does), so `authenticated` `EXECUTE` was also revoked on these without
affecting any trigger's normal firing.

**Verified via live advisor**: `anon_security_definer_function_executable`
finding count is now **0** (was 26).
`authenticated_security_definer_function_executable` dropped from 51 to
34 — the remaining 34 are `restaurant_can_*` / `restaurant_*_property`
RLS-predicate and property-scope helper functions, which is the correct,
intentional `SECURITY DEFINER` pattern for cross-table RLS lookups (e.g.
resolving which property an order/receipt/purchase-order belongs to for a
scoped policy to check). These were **not** touched — revoking them
without individually confirming every policy that depends on each one
would risk silently breaking property-scoped tenant isolation, which is
the opposite of what P11 requires. This is recorded as a **P2** residual
finding (documented, not blocking) rather than fixed blind.

### 1.4 `migration_transfer_audit` — RLS disabled, public grants (§6/§21) — **fixed, was a real P1**

Found during the live RLS audit (not previously flagged in the master
prompt, but caught by the same advisor pass): a one-time internal
migration-bookkeeping table (5 historical rows: `table_name`,
`source_count`, `target_count`, `status`, `notes`) had **RLS disabled**
and **direct INSERT/SELECT/UPDATE/DELETE/TRUNCATE grants to `anon` and
`authenticated`** — readable and writable by anyone holding just the
public anon key. Zero application code references this table. Fixed:
RLS enabled (default-deny, no policies needed — nothing should read or
write it post-migration) and the `anon`/`authenticated` grants revoked.

**Verified via live advisor**: `rls_disabled_in_public` ERROR finding
gone.

---

## 2. RLS audit (§6)

Live-queried `pg_policies` for the priority tables. All `restaurant_*`
tables (orders, order items, payments, guest sessions, tables, menu items,
prices, products, inventory items, stock movements, and ~140 others) have
paired read/write policies referencing `restaurant_can_read(_scoped)` /
`restaurant_can_write(_scoped)` — the tenant/property-scoped predicate
functions confirmed still correctly `authenticated`-executable. `commercial_*`
tables use tenant-or-commercial-admin scoped policies. RBAC tables
(`rbac_user_roles`, `app_users`) are admin-gated for writes, self-or-STAFF:READ
for reads. `user_roles` (a distinct, legacy table from `rbac_user_roles`) has
RLS enabled with zero grants to `anon`/`authenticated` at all — already fully
locked down, the `rls_enabled_no_policy` INFO finding on it is a correct,
intentional default-deny posture, not a defect.

This is consistent with — and builds on — the extensive property/tenant
scope remediation already completed in this repository's P0-B and P1
phases (migrations `0027`–`0033`, `p1_fix_read_scoped_tenant_isolation_bug`,
`p1_profitability_rls_scope`, `p1_intelligence_property_scope`,
`p1_reconciliation_property_scope`).

## 3. Tenant/property/outlet isolation (§7–§9)

**Not independently re-run as a live authenticated HTTP adversarial test
in this session** — this environment has no test-user credentials or a
configured anon/publishable key to authenticate as a real user against
PostgREST from here, and the Supabase management SQL tool used for the
fixes above runs with elevated (RLS-bypassing) privileges, so it cannot
itself prove RLS enforcement from a caller's perspective.

What **is** genuine evidence, already in the repository and re-confirmed
passing in this session (`npx vitest run`: 150/150 files, 1957/1957 tests):
44 test files with explicit property-scope / cross-tenant isolation
coverage (naming pattern `*.property-scope.test.ts` across costing,
fiscal, inventory, mobile money, reconciliation, sales, self-order,
multi-property access), built during this repository's prior P0-B/P1
security remediation phases, which included live two-tenant/two-property
adversarial DB verification at the time (see repository history: "Build
two-tenant/two-property adversarial test fixture + attack test matrix",
"Live DB verification + final 26-point security remediation report").
This P11 pass did not repeat that live adversarial run; it re-verified the
RLS policy definitions those tests depend on are still in place in
production, and that nothing in this session's changes touched
tenant/property/outlet scoping logic.

**Disposition**: not re-proven live in this pass. Recommend a scheduled
live two-tenant adversarial re-run (with real auth credentials available)
before first customer onboarding, even though no evidence of regression
exists.

## 4. Privilege escalation (§10) — not independently tested this pass

Same constraint as §7–9 (no live auth credentials in this environment).
The RLS/function grant audit above (§1.2–1.4) is the relevant static
evidence: role/permission resolution happens exclusively through
server-verified functions (`nova_has_permission`, `restaurant_can_write`),
never from client-supplied role claims — confirmed by reading
`rbac.functions.ts`/`access.server.ts` (roles are always looked up
server-side via `nova_user_roles_view`/`rolesFor`, keyed off the
authenticated `userId` from the session, never from request body).

## 5. Authentication & session security (§11, §13, §14)

Not independently tested live this pass (same credential constraint).
Architecturally verified: `requireSupabaseAuth` middleware gates every
RBAC-relevant server function; role/permission checks are always
server-side (§4/§10 above); no code path found that trusts a
client-supplied `tenant_id`/`role` for authorization decisions.

## 6. Leaked password protection (§12) — **could not be enabled; documented limitation**

**Still disabled** (confirmed via live advisor, unchanged). This is a
Supabase Auth (GoTrue) service-level setting, not a database setting — it
cannot be changed via SQL, and no Supabase Management-API-level MCP tool
for Auth configuration was available in this session (only
project/database-level tools: `get_project`, `execute_sql`,
`apply_migration`, `get_advisors`, `list_tables`, `list_migrations`,
branch/edge-function tools — none cover Authentication settings). This
must be enabled manually: Supabase Dashboard → Authentication → Sign In /
Providers → Password → "Leaked password protection", or via the
Management API with a personal access token this session does not have.
**This is an explicit, disclosed gap, not a false "fixed."**

## 7. API security (§15) — deferred to P08

No external HTTP API surface beyond the P08-A spike's single
`/api/v1/health` endpoint exists yet (per the P08/P08-A work earlier in
this engagement). Sections of §15 that presuppose a live external API
platform (rate limits on API keys, malformed external requests, etc.) are
not yet applicable; P08's own future work inherits the identity-boundary
rules already documented in `docs/p08-a-external-http-entry-point-adr.md`
§13.

## 8. Storage security (§16) — **verified, no defect found**

Three buckets, live-queried: `restaurant-import-sources` (private, 10MB,
structured file types only), `restaurant-menu-images` (public read, 2MB,
images only), `restaurant-tenant-logos` (public read, 1.5MB, images only).
Public read is intentional and correct for guest-facing menu photos and
branding. All INSERT/UPDATE/DELETE on all three buckets are gated by
`restaurant_owns_menu_image_path(name)` (tenant-path-ownership check) for
`authenticated` only — `anon` has no write access anywhere. This is a
correctly designed, tenant-scoped storage model. No changes made.

## 9. Secrets & environment variables (§17) — **verified clean**

`grep`-audited: `SUPABASE_SERVICE_ROLE_KEY` appears only inside
`src/integrations/supabase/client.server.ts` (a `.server.ts`-suffixed,
import-protected, server-only file per this repo's existing convention),
always read from `process.env`, never hardcoded, never present in any
client-bundled (non-`.server.ts`) file. No real `.env` file is committed
to git (`git ls-files` confirms only `.env.example` files are tracked;
`standalone/.env` and `local/.env` are gitignored).

## 10. Payments & fiscal (§18–§19) — verified as already-built, not re-audited from scratch

Both Mobile Money (`payments/mobilemoney/`) and TRA Fiscal
(`fiscal/`) modules already implement idempotency-key/dedupe-key
machinery end-to-end (contracts, adapters, server modules), built and
tested across this repository's prior dedicated TRA Fiscal (11 phases, 47
findings) and Mobile Money (11 phases) engagements, with duplicate/timeout/
retry scenarios explicitly covered in their existing test suites (still
passing: 1957/1957). Not re-audited line-by-line in this P11 pass — this
would duplicate that prior, already-certified work rather than find new
defects, which the master prompt's own "do not overfix" principle (§48)
argues against absent a specific new concern.

## 11. Commercial security (§20) — not independently re-tested this pass

Entitlement/quota/subscription enforcement was built and adversarially
tested in this repository's prior P01/P03/P04/P05 commercial phases
(server-side `resolveEntitlement`/`assertEntitled`, confirmed still in use
by every gated intelligence/multi-location function read in this and
earlier sessions). Not re-run live in this pass.

## 12. Performance advisor triage (§22–§23)

Full live advisor pull (738 findings, 4 lint types) triaged by a dedicated
subagent since the raw output was 287K characters:

| Lint type | Total | On priority tables |
|---|---|---|
| Unindexed foreign keys | 314 | 84 |
| Auth RLS init-plan (per-row re-eval of `auth.uid()`/`auth.role()`) | 61 | 41 |
| Multiple permissive policies | 345 | 51 |
| Unused index | 18 | — |

**No P0**: nothing indicates an outright timeout/outage risk today.

**Notable positive finding**: zero RLS init-plan issues on the hot-path
operational tables (`restaurant_orders`, `restaurant_order_items`,
`restaurant_payments`, `restaurant_tables`, `restaurant_menu_items`,
`restaurant_prices`, `restaurant_products`, `restaurant_inventory_items`,
`restaurant_stock_movements`, `restaurant_guest_sessions`) — their
policies already avoid the per-row re-evaluation pattern. All 41
priority-table init-plan findings are on `app_users`/`rbac_user_roles`
(evaluated on nearly every authenticated request) and 39 `commercial_*`
policies (lower-traffic back-office path).

**P1** (schedule before general-availability scale-up, not blocking
launch):
- Unindexed FKs on `restaurant_order_items` (10), `restaurant_orders` (5),
  `restaurant_stock_movements` (11), `restaurant_payments` (2) — the
  highest write/read-volume tables on the live ordering path; will
  degrade under load (slow joins, cascading-delete locks).
- RLS init-plan wrapping (`auth.uid()` → `(select auth.uid())`) on
  `app_users`/`rbac_user_roles` policies — compounds system-wide as row
  counts grow.

**P2**: remaining priority-table unindexed FKs (`restaurant_prices`/`products`/
`inventory_items`/`tables`/`menu_items`/`guest_sessions`, RBAC remainder),
`commercial_*` RLS init-plan (39 findings), and the 51 multiple-permissive-policy
findings on priority tables (correctness-neutral, adds per-query overhead).

**P3**: ~230 non-priority unindexed FKs, ~294 non-priority
multiple-permissive-policy findings, all 18 unused indexes — routine
cleanup, no urgency.

No DDL was applied for any of these — per the master prompt's own
instruction not to "blindly fix the number," these are reported as
prioritized candidates for a dedicated indexing/RLS-optimization pass, not
executed speculatively in a security-hardening pass.

## 13. Database integrity, transactional integrity, idempotency (§24–§26)

Covered by the existing, extensive constraint/idempotency-focused test
suites referenced in §10 above (fiscal, mobile money, inventory stock
movement ledger, purchasing→receipt→inventory flows) — all currently
passing. Not independently re-derived from raw schema constraints in this
pass.

## 14. Production configuration, environment separation, domain/HTTPS, email (§27–§30)

**Not verified this pass.** This sandboxed session has no Vercel access,
no production domain reachability, and no email-delivery credentials to
test against. This mirrors the exact limitation disclosed in the P08-A
spike's certification for "true internet-reachable deployment proof" —
disclosed here rather than assumed.

## 15. Logging, error handling, monitoring (§31–§33) — not independently audited this pass

## 16. Backup & recovery (§34) — **not verified; cannot be tested from this session**

No tool available in this session to inspect or trigger a Supabase
project backup/restore. This is a real gap against §34's explicit
requirement ("a backup that has never been tested is not sufficient
evidence of recoverability") — disclosed, not fabricated.

## 17. Deployment safety & migration safety (§35–§36)

The two migrations applied in this session (`0048_p11_security_hardening.sql`,
consolidated from what was applied live in two rounds) are both
additive/permission-only — no data loss, no destructive DDL, no table
drops, no column removal. Applied to production directly via the Supabase
migration tool and independently confirmed via `get_advisors` before and
after.

## 18. Customer data protection, public surface audit, guest security, rate limiting, security headers, dependency security (§37–§42)

Not independently re-audited this pass beyond what's covered in §7–9
(guest ordering uses its own session/table mechanism, confirmed to have
its own extensive isolation test coverage from the O12 guest-session
phase referenced in repository history) and §16 (storage public/private
correctness).

## 19. Production smoke test, clean-tenant test (§43–§44) — **not performed this pass**

Requires live auth/credential access and a running deployed instance,
neither available in this session.

## 20. Security regression suite (§45) — **substantially exists and passes**

150 test files / 1957 tests, all passing, covering authentication middleware
gating, RBAC/permission checks, RLS-shaped scope logic (fake-Supabase
harness), guest session lifecycle, commercial entitlement, payment/fiscal
idempotency, and storage-path ownership logic. Re-run at the end of this
P11 pass with zero regressions from the DB changes made.

## 21. Production incident readiness (§46) — not addressed this pass

---

## Priority findings summary (§47 classification)

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `nova_user_roles_view` SECURITY DEFINER — platform-wide cross-tenant role/scope enumeration via unfiltered PostgREST view | **P0** | **FIXED** (production) |
| 2 | 26 SECURITY DEFINER functions anon-executable via RPC (RBAC helpers + financial-control/giveaway triggers) | **P1** | **FIXED** (production, anon: 26→0) |
| 3 | `migration_transfer_audit` RLS disabled, public anon/authenticated read+write+delete grants | **P1** | **FIXED** (production) |
| 4 | Leaked password protection disabled | **P1** | **NOT FIXED** — no tool access to Auth config in this session; documented manual remedy |
| 5 | 34 remaining `authenticated`-executable SECURITY DEFINER RLS/property-scope helper functions | **P2** | **Reviewed, accepted** — correct pattern, not touched without per-function confirmation |
| 6 | No live authenticated adversarial tenant/property/outlet isolation re-run this pass | **P1** | **Risk-accepted for this pass** — static RLS audit + existing 44-file test suite is the evidence; recommend scheduled live re-run before customer onboarding |
| 7 | Backup/recovery, production deployment (Vercel/domain/email), monitoring, smoke test | **P1 (backup), P2 (rest)** | **NOT VERIFIED** — no tool/credential access in this session |
| 8 | Unindexed FKs on hot-path order/payment/inventory tables (28 findings); RLS init-plan re-eval on `app_users`/`rbac_user_roles` | **P1** | **NOT FIXED** — triaged and prioritized (§12), no DDL applied; schedule before GA scale-up, not a launch blocker (no P0 timeout risk found) |

**Remaining P0 issues: 0.**
**Remaining P1 issues: 4** (leaked password protection; live isolation re-run; backup/recovery verification; hot-path indexing/RLS-init-plan) — all explicitly dispositioned above, none silently dropped.

---

## Risk acceptance

| Risk | Owner | Rationale |
|---|---|---|
| 34 property-scope/RLS-predicate SECURITY DEFINER functions remain `authenticated`-executable | Engineering | Correct, standard pattern for RLS cross-table lookups; revoking without per-policy verification risks breaking tenant/property isolation, the opposite of P11's goal |
| Payment/fiscal/commercial modules not re-audited line-by-line this pass | Engineering | Already built and adversarially tested across dedicated prior phases (TRA Fiscal 11 phases/47 findings, Mobile Money 11 phases, P01/P03/P04/P05 commercial); re-litigating without a specific new concern is scope creep the master prompt itself warns against (§48) |

---

## Evidence

- Commits: this P11 pass adds `standalone/db/migrations/0048_p11_security_hardening.sql` and this document.
- Live production migrations applied: `p11_security_definer_and_rls_hardening`,
  `p11_anon_execute_revocation`, `p11_anon_execute_revocation_public_grant`
  (all `{"success":true}`), consolidated into the single repo migration file above.
- Security advisor before/after: `security_definer_view` ERROR 1→0;
  `rls_disabled_in_public` ERROR 1→0; `anon_security_definer_function_executable`
  WARN 26→0; `authenticated_security_definer_function_executable` WARN 51→34
  (all 17 removed were zero-caller trigger/action functions).
- Test suite: `npx vitest run` — 150/150 files, 1957/1957 tests, before and after.
- Storage bucket policies and grants: live-queried, verified correctly tenant-scoped.
- Secrets: `grep`-verified service-role key is server-only, `.env` not committed.

---

## P11 STATUS: **CONDITIONAL GO**

This is not a clean GO: three P1 items (leaked password protection, live
isolation re-run, backup/recovery verification) remain genuinely open, and
roughly two-thirds of the master prompt's 53 sections were not
independently re-verified in this pass — either because they were already
covered by prior, dedicated engagements in this repository (payments,
fiscal, commercial, guest security), or because this sandboxed session
lacks the credentials/tool access to test them (production deployment,
email, backup/restore, live authenticated adversarial HTTP testing).

It is not NO-GO either: the two genuinely critical, previously-unknown
defects found in this pass — the `nova_user_roles_view` cross-tenant
role/scope leak and the fully-public `migration_transfer_audit` table —
were real P0/P1 production security holes, and both are now fixed and
verified in production with zero test regressions. No known P0 remains
open.

**Executive verdict**: LexiBite's database-layer security posture is
materially stronger after this pass, and the two real defects found were
the kind that would matter to a real customer immediately. But "safe and
operationally reliable enough for a real customer's business data" per
§53's own question cannot be answered an unqualified YES while backup/recovery,
live production deployment, and a live authenticated isolation test remain
unverified. Recommend closing the three listed P1s (leaked-password toggle
is a five-minute dashboard change; the other two need either real
credentials in this environment or a session with them) before the first
customer is onboarded, not before further feature work.

**P11 CONDITIONAL GO — the three listed P1s must close before customer
onboarding; P12+ feature work may proceed in parallel.**
