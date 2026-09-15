# ME-02 — Security Certification

Product: LexiBite / NOVA Hospitality F&B — Restaurant & Bar Operating System
Repository: `dingbee/nova-hospitality-fnb`
Certification programme: Market Entry (ME) — Gate ME-02 (Security Certification)
Baseline: `claude/me-00-baseline-lock` @ `85b3397` (ME-00 CLOSED — GREEN)
Certification candidate branch: `claude/me-02-security-certification`
Inspection date: 2026-09-14/15
Live database inspected: Supabase project `lusiqcmxfxhnehxmwihs` ("nova-hospitality-fnb", eu-central-1) — the same project ME-00 inspected.

This gate does not repeat ME-00's inventory. It re-verifies the baseline's
security-relevant findings against the live system (not just the migration
files) and closes every ME-02-scoped defect it found, per CLAUDE.md's
discipline: inspect the real implementation, reproduce the problem,
smallest correct fix, regression coverage, evidence over assertion.

ME-01 (Database & Performance Hardening) is running concurrently on its own
branch from the same baseline. This gate did not open, read, merge, or
depend on ME-01's branch, and made no changes intended to address
performance. Two of the fixes below are RLS/function changes applied
directly to the shared live database (unavoidable — they close active,
exploitable holes); any conflicting DDL from ME-01 on the same objects is a
human reconciliation item between the two branches, as directed.

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `restaurant_fiscal_next_counter` — SECURITY DEFINER RPC, `authenticated`-executable, **zero authorization check**, writes an arbitrary tenant's fiscal counter | **CRITICAL** | **FIXED, live-verified** |
| 2 | `rbac_user_roles` SELECT policy — STAFF:READ check ignores row scope, discloses every tenant's role grants to any STAFF:READ holder | **CRITICAL** | **FIXED, live-verified** |
| 3 | KD-11 — `upsertMember`/`removeMember` unscoped capability check (property-scoped owner could target another property) | MEDIUM (RLS fail-closed backstop already existed) | **FIXED**, closes for real (was previously "recorded, non-blocking") |
| 4 | KD-11 — `assignRole`/`revokeRole` unscoped `ADMINISTRATION:ADMIN` check (tenant-scoped admin could target another tenant) | MEDIUM (RLS fail-closed backstop already existed, code path unreachable from any UI) | **FIXED** |
| 5 | KD-02 — leaked-password protection disabled in Supabase Auth | MEDIUM | **BLOCKED** — no tool in this environment can reach Supabase Auth config (see below) |
| 6 | SECURITY DEFINER `search_path` safety (44-function surface) | — | **VERIFIED SAFE**, no defect |
| 7 | Secrets scan | — | **VERIFIED CLEAN**, no defect |
| 8 | RLS coverage (149 tables) | — | **VERIFIED**, matches ME-00's finding, no regression |

---

## 1. `restaurant_fiscal_next_counter` — CONFIRMED CRITICAL, FIXED

**Discover.** `standalone/db/migrations/0031_tra_vfd_protocol.sql` defines
`public.restaurant_fiscal_next_counter(_tenant, _fiscal_config,
_counter_type, _period_key)` as `SECURITY DEFINER`, then
`GRANT EXECUTE ... TO authenticated`. Its own comment claims this is safe
because "writes only ever happen through restaurant_fiscal_next_counter(),
which enforces its own authorization by virtue of running inside
requestFiscalization/registerVfd's already-checked code path." That claim
is false: the GRANT makes the function directly callable by any signed-in
user via `/rest/v1/rpc/restaurant_fiscal_next_counter`, bypassing that
application code path entirely. The function body had no `auth.uid()`
check and no tenant/property authorization check of any kind before its
`INSERT ... ON CONFLICT ... DO UPDATE` against
`restaurant_fiscal_counters` — the counter that backs this tenant's fiscal
(tax-authority) receipt/document numbering.

Verified live: `has_function_privilege('authenticated', <oid>, 'EXECUTE')`
= `true`; the function's own `pg_get_functiondef` showed no auth check.

**Exploit/prove (before fix — reconstructed from the verified pre-fix
body, captured before remediation and quoted above; the live database was
not exploited with a persisted write — see Fix below for the order of
operations actually used).** Any authenticated user of Tenant A could call
the RPC with Tenant B's `_tenant`/`_fiscal_config` and advance or corrupt
Tenant B's fiscal counter sequence — a cross-tenant write with no
isolation on a fiscal-compliance-critical resource.

**Fix.** Migration `0065_p11_fiscal_counter_authorization.sql` adds the
exact predicate the table's own RLS policy ("fiscal_counters_write
scoped", 0031) already requires for every other write path:
`restaurant_can_write_scoped(_tenant, <the same role list the RLS policy
uses>, restaurant_fiscal_configuration_property(_fiscal_config))`, plus an
`auth.uid() IS NULL` guard. No new authorization model — this closes the
one path that was exempt from the one that already existed. Applied
directly to the live database (`apply_migration`, confirmed idempotent
`CREATE OR REPLACE`) because the hole was live and exploitable; the same
SQL is committed as the migration file.

**Test/regress (live, on the actual database, evidence captured).**
1. Hostile call as a random UUID with no membership anywhere, targeting a
   real tenant/fiscal-config pair: **rejected**, `42501 forbidden`, and
   `SELECT count(*) FROM restaurant_fiscal_counters WHERE period_key =
   'HOSTILE-TEST'` = **0** — no partial write occurred.
2. Legitimate call as that tenant's real OWNER (tenant-wide grant),
   wrapped in `BEGIN; ... ROLLBACK;` so nothing was persisted: **succeeded**
   (`allocated_value: 1`), proving the fix does not break the authorized
   path.
3. Post-test cleanup verified: `SELECT count(*) ... WHERE period_key IN
   ('HOSTILE-TEST','ME02-REGRESSION-TEST')` = **0** — the live database
   was left exactly as found, no test data persisted.

Source-level regression added: `src/lib/rbac/authorization-gate.test.ts`
now pins that the latest `restaurant_fiscal_next_counter` definition
contains the `auth.uid()` guard and that the `restaurant_can_write_scoped`
check runs strictly before the `INSERT`.

---

## 2. `rbac_user_roles` read policy — CONFIRMED CRITICAL, FIXED

**Discover.** The `rbac_user_roles_read` RLS policy read:

```sql
USING (user_id = auth.uid() OR nova_has_permission(auth.uid(), 'STAFF:READ'))
```

`nova_has_permission`'s scope arguments default to `NULL`, and its body is
`(_tenant_id IS NULL OR ur.tenant_id IS NULL OR ur.tenant_id = _tenant_id)
AND ...` — with `_tenant_id` omitted, that clause is unconditionally true,
so the check never references the *row's* tenant/property/outlet at all.
This is the exact class of gap migration `0059` already closed for
`tenants_admin`/`properties_admin`/`outlets_admin`/`app_users_admin`, left
un-closed on `rbac_user_roles`'s own read policy. Net effect, verified
live: any authenticated user holding `STAFF:READ` anywhere — even a grant
scoped to one property — could `SELECT` every row of `rbac_user_roles` for
every tenant on the platform (who holds which role, at which
tenant/property/outlet, for which user id).

No application code performs a read against `rbac_user_roles` (grep
confirms only `assignRole`/`revokeRole` insert/delete it), so this was a
dormant but live and directly PostgREST-reachable disclosure path, not a
theoretical one — table-level grants confirmed `authenticated: SELECT`
present; the policy is scoped `TO authenticated` (not `anon`, which has no
matching policy and is correctly denied regardless of its own broad
table-level grants — the standard, benign Supabase default neutralized by
RLS, verified, not a defect).

**Fix.** Migration `0066_p11_rbac_user_roles_read_scope.sql` replaces the
policy with `nova_can_manage_scoped('STAFF:READ', tenant_id, property_id,
outlet_id)` — reusing the exact scoping discipline the sibling write
policy (`rbac_user_roles_admin_scoped`, 0059) already applies, so a `NULL`
at any level of the row is only visible to a caller whose own grant is
also `NULL` at that level. Applied directly to the live database; zero
functional impact confirmed (no caller reads this table).

**Test/regress (live).** With the fix applied, inserted a second
`rbac_user_roles` row for a different platform-tier tenant
(`uat-tenant-b`) and a different `auth.users` id, inside a transaction
that was rolled back; queried the table as a real OWNER of the original
tenant. Result: only that OWNER's own tenant's row was visible — the
other tenant's row was correctly filtered out. Transaction rolled back;
`rbac_user_roles` left with its original single row (verified: 1 distinct
tenant, 1 row, both before and after).

Source-level regression added pinning that the migration no longer
contains the scope-blind call and that the new policy scopes by row.

---

## 3 & 4. KD-11 — application-layer authorization gap, closed

ME-00 recorded KD-11 as: the RLS-layer halves of migrations `0057`
(`restaurant_can_manage_membership`) and `0059` (`nova_can_manage_scoped`
on `rbac_user_roles`) were reconciled into git and are live, but their
paired application-layer functions
(`assertCanManageMembership`/`assertCanManageRbacRole`/`grantRbacRole`/
`revokeRbacRole`) did not exist anywhere in `main`. ME-00 explicitly
classified this as "not exploitable — RLS enforces the fix regardless
(fail-closed)... a caller ... will see a raw database error rather than a
clean permission-denied message" and left it as a "fix candidate for
ME-02/ME-03" because it could not be tested in that session (no working
dependency install).

This gate re-verified the "RLS fail-closed" claim directly against the
live database (not just the migration file) before treating it as
non-blocking:

- `rbac_user_roles_admin_scoped` policy confirmed live, using
  `nova_can_manage_scoped(tenant_id, property_id, outlet_id)` for both
  `USING` and `WITH CHECK`.
- Confirmed via `grep` that **no UI code calls `assignRole`/`revokeRole`
  at all** — matching ME-00's "confirmed unreachable from any current UI."

Then closed it properly rather than re-recording it:

- **`src/modules/restaurant/core/access.server.ts`**: added
  `assertCanManageMembership(sb, tenantId, targetPropertyId)`, which calls
  the existing, already-deployed `restaurant_can_manage_membership` RPC
  directly (rather than re-deriving an equivalent-but-subtly-different
  check in TypeScript — the original gap was exactly this kind of
  drift). Wired into `upsertMember`/`removeMember`
  (`src/modules/restaurant/core/members.server.ts`), replacing the old
  unscoped `assertCapability(..., "tenant.manage")` call. `removeMember`
  now looks up the target row's own `property_id` before checking, since
  the previous code checked the *caller's* tenant only, never the
  membership row actually being deleted.
- **`src/lib/rbac/rbac.server.ts`**: added
  `assertCanManageRbacRole(sb, scope)`, calling the existing
  `nova_can_manage_scoped` RPC with `ADMINISTRATION:ADMIN` and the
  **target** grant's own tenant/property/outlet. Wired into
  `assignRole`/`revokeRole` (`src/lib/staff.functions.ts`), replacing the
  unscoped `assertPermission(..., "ADMINISTRATION:ADMIN")` call.
  `revokeRole` previously deleted by `user_id + role_code` with no scope
  at all; it now reads every matching row first and asserts authorization
  for each row's own scope before deleting any of them, so a caller
  authorized for only one of several same-named grants gets a clean
  refusal instead of either a silent partial delete or a raw RLS error.

Both are minimal, additive changes: no new authorization model, no
capability renamed, no RLS touched for this half of the fix (the existing
0057/0059 policies were already correct — only the missing application
mirror was added).

**Tests added** (unexecuted in this sandbox — see §Validation):
`src/modules/restaurant/core/members.server.test.ts` (new, 6 cases) and
`src/lib/rbac/rbac.server.test.ts` (new, 5 cases) exercise the real
functions against fakes that reproduce `restaurant_can_manage_membership`
/`nova_can_manage_scoped`'s exact SQL predicates, proving: a
property-scoped grant is denied at a different property; a property-
scoped grant is denied for a tenant-wide target; a tenant-wide grant is
allowed everywhere in its tenant; a platform-wide admin is allowed
everywhere. `src/lib/rbac/authorization-gate.test.ts`'s existing
"administered staff API" test was updated (not weakened — the property it
checks is now enforced more precisely) to pin the new scoped guard instead
of the old unscoped one it superseded.

---

## 5. KD-02 — leaked-password protection — BLOCKED (environment)

Re-confirmed live via `get_advisors(type=security)`:
`auth_leaked_password_protection` — **WARN, currently disabled**.

This setting lives in Supabase's Auth (GoTrue) service configuration, not
in a Postgres table reachable by `execute_sql`/`apply_migration`, and
requires either the Supabase Dashboard or the Management API. The
Supabase MCP server available in this session exposes only:
`apply_migration, confirm_cost, create_branch, create_project,
delete_branch, deploy_edge_function, execute_sql,
generate_typescript_types, get_advisors, get_cost, get_edge_function,
get_organization, get_project, get_project_url, get_publishable_keys,
list_branches, list_edge_functions, list_extensions, list_migrations,
list_organizations, list_projects, list_tables, merge_branch,
pause_project, query_logs, rebase_branch, reset_branch, restore_project,
search_docs` — no auth-config tool exists among them, and no Management
API / Dashboard credential is available in this environment. This was
attempted (checked the full tool surface, confirmed no path exists) rather
than assumed.

This is an explicit, evidenced external-dependency block, not a
recommendation-only cop-out: enabling it requires a human with Supabase
Dashboard access (Authentication → Policies → "Leaked password
protection") or a Management API token this session does not hold.

---

## 6. SECURITY DEFINER surface — verified safe

`SELECT proname, proconfig FROM pg_proc WHERE prosecdef` (live database):
every one of the 66 `SECURITY DEFINER` functions in `public` carries
`search_path=public` — **zero** search-path-hijack exposure across the
entire surface. The 44 functions the linter flags as
"authenticated-executable SECURITY DEFINER" were individually reviewed by
category:

- **Pure scope-lookup helpers** (`restaurant_*_property`,
  `restaurant_cash_payout_total`, `restaurant_expected_tender`,
  `restaurant_daily_close_property`, etc.) — `STABLE`, read-only,
  return a single id/amount used to back RLS policies; direct RPC access
  discloses at most "this id exists and belongs to property X", not
  business data. No defect.
- **Permission-check helpers** (`has_role`, `nova_has_permission`,
  `restaurant_can_*`, `nova_can_manage_scoped`) — boolean-returning by
  design; this is the RLS backbone, not a bypass.
- **Privileged-write functions** (`restaurant_bootstrap_tenant`,
  `restaurant_increment_quota_usage`, `restaurant_next_document_number`,
  `restaurant_request_giveaway`/`decide_giveaway`/`reverse_giveaway`/
  `apply_giveaway`, `nova_grant_owner`, `nova_bootstrap_owner`) —
  individually read in full (`pg_get_functiondef`). All correctly check
  `auth.uid()` plus the caller's actual role/scope before writing, **except**
  `restaurant_fiscal_next_counter` (finding #1, fixed above). The giveaway
  family additionally enforces day-lock, request-key idempotency, and
  role-based discount ceilings server-side, matching the RLS-independent
  business rules described in their own migration comments.

## 7. Secrets scan — clean

Searched for private-key markers, AWS-style keys, and inline
service-role/JWT-shaped strings across `src/`, `api/`, config and env
files. Two matches, both explicitly-documented throwaway test fixtures
(`src/modules/restaurant/fiscal/providers/tra/__fixtures__/testCert.ts`,
`src/modules/runtime/local/productization.test.ts`) — self-signed,
generated locally, never read from an env var, never used against a real
endpoint. `.env.example` contains only empty placeholders. No remediation
needed.

## 8. RLS coverage — verified, no regression

`get_advisors(security)` shows exactly two `rls_enabled_no_policy`
findings (`migration_transfer_audit`, `user_roles`) — both intentional
default-deny (the deprecated legacy role store and an audit table with no
current read/write surface), matching ME-00's KD-07 exactly. No table
shows `rls_disabled_in_public`. This reconfirms ME-00's "149 tables, all
`rowsecurity = true`" finding still holds after this gate's changes.

---

## Validation

- **Live database evidence**: every finding above was verified against
  the actual live Supabase project (function definitions, grants, RLS
  policy text, and hostile/legitimate RPC calls with proof of before/after
  state), not inferred from migration files alone — the standard ME-00
  itself was held to.
- **`bun install`**: **environment-blocked**, reproduced independently of
  ME-00's KD-05. This session's proxy (`europe-west1-npm.pkg.dev/
  lovable-core-prod/sandbox-npm-cache`) returns `403` for the large
  majority of package tarballs (only 26 of ~875 packages resolved). This
  is a sandbox/registry-access limitation, not a code defect — confirmed
  by attempting the install cleanly once and inspecting the actual error
  class (403 on tarball fetch, not a dependency-resolution or lockfile
  problem).
- **`tsc --noEmit` / `vitest run` / `eslint` / `bun run build`**: could
  not be executed to a real result for the same reason (no installed
  dependencies — no `vitest`, no type packages). This is recorded
  honestly rather than claimed.
- **Partial substitute verification performed instead**: the global
  TypeScript compiler available in this sandbox (`/opt/node22/bin/tsc`)
  was run directly against the four edited/added application-code files
  with relaxed flags (`--skipLibCheck --ignoreConfig`, filtering only the
  expected "cannot find module" noise from the missing `node_modules`).
  No syntax errors were reported. This is a weaker check than a real
  `tsc --noEmit`/`vitest run` against the full dependency graph and is
  reported as exactly that — a partial substitute, not a pass.
- **New tests are written but not run** in this sandbox for the reason
  above; they follow this repository's own established fake-Supabase
  testing patterns (see `access.server.test.ts`,
  `authorization-gate.test.ts`) and should be run in a real CI/dev
  environment (`bun install && bun run typecheck && bun run test && bun
  run lint && bun run build`) before this branch is merged.
- **Live SQL migrations (0065, 0066)** were applied to the live database
  and independently verified via follow-up `execute_sql` reads (function
  definition, grants, policy text) plus the hostile/legitimate call
  evidence in §1–2 — this is real, executed verification, distinct from
  the blocked local toolchain.

## Remaining exceptions

- **KD-02** (leaked-password protection): blocked, see §5 — needs a human
  with Supabase Dashboard/Management API access.
- **Local toolchain** (`bun install`/`typecheck`/`test`/`lint`/`build`):
  blocked by sandbox registry access (403), reproduced independently of
  ME-00's KD-05; must be re-run in an environment with registry access
  before merge.
- Everything else discovered in this gate's scope was fixed and evidenced
  above, not deferred.

## Git

- Branch: `claude/me-02-security-certification`, created from
  `claude/me-00-baseline-lock @ 85b3397`.
- Files changed: 2 new migrations (`0065`, `0066`), 4 application files
  (`access.server.ts`, `members.server.ts`, `rbac.server.ts`,
  `staff.functions.ts`), 1 updated regression test
  (`authorization-gate.test.ts`, extended, one assertion updated to match
  the fixed code — not weakened), 2 new test files
  (`members.server.test.ts`, `rbac.server.test.ts`), this document.
- No file outside `src/`, `standalone/db/migrations/`, and `docs/me-02/`
  was touched. ME-01's branch was never opened, read, or merged.

## Certification conclusion

Every ME-02-scoped defect this gate found — two live, exploitable,
CRITICAL cross-tenant issues (fiscal counter write, RBAC read
disclosure) and the two KD-11 application-layer gaps — was fixed, applied
to the live database where applicable, and evidenced with real
before/after proof, not just recorded. **ME-02 is BLOCKED only on two
narrow, external, evidenced limitations**: KD-02 needs Supabase
Dashboard/Management API access this session does not have, and the local
toolchain needs a registry-accessible environment to actually execute
`typecheck`/`test`/`lint`/`build` against the new code before merge. All
other engineering in scope is complete.
