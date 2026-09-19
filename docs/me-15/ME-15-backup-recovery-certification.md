# ME-15 — Backup & Disaster Recovery Runbook

Scope: the actual, demonstrated recovery mechanism for NOVA Hospitality
F&B, as executed for ME-15 certification. Not a general DR framework —
only what was proven.

The product has two real deployments with different recovery mechanisms:

1. **Standalone appliance** (`standalone/`, `local/`) — self-hosted
   PostgreSQL, owner keeps custody of their own data. Recovery mechanism:
   `local/scripts/backup.sh` / `restore.sh` (`pg_dump`/`pg_restore`,
   custom format). This is what ME-15 exercised end-to-end.
2. **Hosted deployment** on Supabase Cloud project `nova-hospitality-fnb`
   (`lusiqcmxfxhnehxmwihs`, org `dingbee`, plan **free**). The Free plan
   has no daily backups and no PITR add-on eligibility — there is
   currently **no platform backup mechanism** for this project. See
   "Recovery gaps" below.

## 1. Backup source

Standalone: `local/scripts/backup.sh`, invoked manually (`./nova` has no
`backup` subcommand exposed at the top level; run via
`local/scripts/novactl.sh backup` or the script directly). Produces:

- `nova-<db>-<UTC timestamp>.dump` — `pg_dump --format=custom --compress=9`
  of the full operational database, including PostgREST role grants
  (`anon`/`authenticated`/`service_role`), excluding ownership.
- `nova-<db>-<UTC timestamp>.manifest.json` — app/schema version, install
  id, tenant list, Postgres version, migration count, artifact size and
  `sha256` checksum. The script proves the dump is readable
  (`pg_restore --list`) before it reports success.

Nothing is transmitted off the appliance (`transmitted_offsite: false` in
the manifest). There is **no scheduler** (cron/systemd timer) anywhere in
the repository that invokes `backup.sh` automatically — every backup is
an operator action. This is why RPO is UNKNOWN (see Recovery Model in the
certification report) — the system enforces no backup cadence.

Hosted: no working backup mechanism currently exists (Free plan). See gaps.

## 2. Recovery trigger

Operator-initiated, on loss/corruption of the appliance's PostgreSQL
volume, a bad migration, or before a risky change. There is no automatic
failover — this is a single-instance appliance by design (owner-custody
model).

## 3. Recovery environment

Run `restore.sh` against any PostgreSQL 16/17 server the operator
controls — the production appliance database, or (recommended for
verification) a scratch database on the same or another server. Requires
`psql`/`pg_dump`/`pg_restore` matching or newer than the source server's
major version, and the same `NOVA_ENV_FILE` contract `local/scripts/lib.sh`
resolves (`standalone/.env` or `local/.env`).

## 4. Restore procedure

```
local/scripts/restore.sh <dump-file> [target-database] [--yes]
```

- Verifies the manifest `sha256` against the artifact before touching
  anything; refuses on mismatch.
- Target database is always created fresh (`DROP DATABASE` + `CREATE
  DATABASE` on the target name) — a restore never merges into a live
  database. Confirmation is required interactively, or via `--yes`.
- Recreates the PostgREST compatibility roles (`local/sql/pre/00-roles.sql`)
  before `pg_restore`, since roles live in the cluster, not the dump.
- `pg_restore --no-owner --exit-on-error`: any error aborts the restore
  non-zero; the script never reports success on a partial restore.
- Signals a running PostgREST (`SIGUSR1`) to reconnect/reload schema.

## 5. Migration procedure

After restoring a dump, reconcile against the current migration set with
`local/scripts/apply-migrations.sh` (also run automatically as step 3 of
`init-db.sh`). It is checksum-verified and idempotent — already-applied
migrations are skipped by content hash, a changed historical migration is
a hard failure, and files listed in `local/migrations.skip` are recorded
as `skipped` rather than reapplied.

**Defect found and fixed by ME-15:**
`standalone/db/migrations/0088_commercial_capability_activation_reconciliation.sql`
joins `commercial_capabilities` to the `UPDATE` target
(`commercial_plan_entitlements pe`) inside a `JOIN ... ON` clause —
PostgreSQL rejects referencing an `UPDATE` target from within its own
FROM-list join condition (`invalid reference to FROM-clause entry for
table "pe"`). This is not environment-specific: it fails on every
PostgreSQL server, and it had in fact never been successfully applied
anywhere, including the hosted Supabase project (confirmed: the hosted
migration ledger has no entry for the plain `commercial_capability_
activation_reconciliation` migration — only for a hand-corrected
`_v2`, applied 2026-09-19). Before this fix, **no fresh standalone
install or from-migrations rebuild could ever complete** — `0088` runs
before `0089`+ alphabetically and its transaction rollback aborts the
whole migration batch under `set -euo pipefail`.

Fix (this certification):
- `0088_commercial_capability_activation_reconciliation.sql` is left
  unmodified (never edit a historical migration) and added to
  `local/migrations.skip` with the reason recorded.
- `standalone/db/migrations/0089_commercial_capability_activation_
  reconciliation_v2.sql` added: the same reconciliation, using a
  comma-joined `FROM` list so the `WHERE` clause can reference the
  `UPDATE` target. Content matches, statement-for-statement, the
  `_v2` correction already verified working on the hosted project
  (fetched and compared via `supabase_migrations.schema_migrations.
  statements` before writing this file).

## 6. Required environment configuration

Config that is **not** in the database and must survive independently of
any database restore:

| Name | Required for | Where it lives | Absence blocks recovery? |
|---|---|---|---|
| `NOVA_DB_SUPERUSER_PASSWORD`, `NOVA_DB_AUTHENTICATOR_PASSWORD` | DB connections, PostgREST auth | `standalone/.env` / `local/.env` (operator-held, gitignored) | No — appliance won't start without them, but they can be reset by an operator with server access; no data is lost |
| ES256 JWT signing keypair (`$NOVA_KEY_DIR/jwt-private.pem`, `jwks.json`) | Signing/verifying session tokens | Filesystem, `local/scripts/gen-keys.sh` | No — regenerable (`gen-keys.sh --force`); invalidates existing sessions (forces re-login) but no data loss |
| TLS cert/key | Gateway HTTPS | Filesystem, `local/scripts/gen-tls.sh` | No — regenerable |
| `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` (hosted mode) | App → data-API connectivity | Hosting platform env vars | Yes, for the hosted deployment to reach its own database — but these are not secret material (publishable key), just config |
| Hosted project's service-role key / DB credentials | Privileged server-side operations (hosted mode) | Hosting platform's own secret store — not present in this repository | Yes, for hosted-mode privileged operations; out of this repo's custody by design (CLAUDE.md: never expose service-role to client code) |
| `TWILIO_*`, `NOVA_AI_*`, `NOVA_EMAIL_WEBHOOK_*` | Optional WAN capabilities (WhatsApp, AI advisory, email) | env | No — absence is a supported configuration; the feature reports itself unavailable and never fakes success (README, "Optional, WAN-dependent capabilities") |

No secret value was read, copied or printed to produce this table — only
names, purpose and location were verified.

## 7. Storage recovery procedure

`storage.objects`/`storage.buckets` (bucket definitions, RLS policies,
object metadata rows) are ordinary tables in the compatibility schema
(`local/sql/pre/03-supabase-compat.sql`) and **are** captured by
`pg_dump`/`pg_restore` like any other table.

The actual asset **bytes** are not. The standalone appliance's
`docker-compose.yml` runs only PostgreSQL — there is no Storage-API
service in the standalone stack, so uploaded tenant logos / menu images
have no local object-storage backend to begin with in that deployment
mode; the feature is only meaningfully exercised in hosted mode against
real Supabase Storage. On the hosted Supabase Cloud project, Storage
buckets are real and populated (`restaurant-menu-images`: 13 objects,
`restaurant-import-sources`: 7, `restaurant-tenant-logos`: 1, verified via
`storage.objects` on 2026-09-19) — but Supabase's platform backup/PITR
covers the Postgres database only, never Storage bucket contents, on any
plan tier. **There is currently no recovery mechanism for the actual
asset bytes on either deployment** — this is recorded as a recovery gap,
not fixed (out of ME-15's database/migration scope; would require
standing up a Storage-API service for the appliance, or a bucket-level
backup process for the hosted project — both out-of-scope engineering).

## 8. Verification checks (what ME-15 actually ran)

1. `pg_restore --list` on the fresh dump (built into `backup.sh`).
2. Restore to a distinct target database (never the source).
3. Row-count parity across 20 representative tables spanning tenant →
   property → location → table/menu/pricing/inventory/recipe/supplier/
   RBAC domains: identical before/after.
4. Zero orphaned rows across 8 explicit FK relationships (properties→
   tenants, locations→properties, tables→locations, menu_items→menus,
   recipe_lines→recipes, supplier_products→suppliers, role_permissions→
   roles, plus a tenant-slug uniqueness check).
5. `information_schema.table_constraints` count and non-internal
   `pg_trigger` count identical between source and restored database.
6. Migration ledger on the restored database matches every file on disk
   exactly (93 files: 92 applied + 1 correctly skipped).
7. Re-running `apply-migrations.sh` against the restored database is a
   clean no-op (idempotency).
8. A representative read (`restaurant_menu_items`) and a representative
   write wrapped in `BEGIN … ROLLBACK` both succeed against the restored
   database; canonical authorization functions (`nova_has_permission`,
   `nova_bootstrap_owner`) are present and intact.
9. Corrupted-artifact handling: checksum-tampered dump refused before any
   database is touched; missing dump file refused; a truncated/unreadable
   dump fails loudly mid-`pg_restore` (`--exit-on-error`, non-zero exit) —
   in no case does the script report success.

## 9. Rollback / abort conditions

- Manifest checksum mismatch → abort before any database is touched.
- Missing dump file → abort immediately.
- `pg_restore` error (truncated/corrupt archive, incompatible version) →
  `--exit-on-error` aborts the restore non-zero; the target database is
  left in whatever partial state `pg_restore` reached (verified: 0 public
  tables in the one truncated-dump case tested) and the script never logs
  its "restore complete" success line. An operator seeing exit ≠ 0 must
  not treat the target database as usable and should re-run against a
  verified-good artifact.
- Restore without `--yes` on a non-interactive shell → abort, target
  untouched.

## 10. Post-recovery validation

Run, in order, against the restored database:
1. `local/scripts/apply-migrations.sh` — confirms migration compatibility
   (should be a no-op if the dump was taken at the current schema
   version; applies forward migrations otherwise).
2. The row-count / FK-orphan / constraint-parity checks in §8, against a
   known-good baseline if one is available.
3. Start the appliance (`novactl.sh start`) and hit `/health` and
   `/ready` (`novactl.sh ready`) — not re-verified in this certification
   run because this sandbox has no `postgrest` binary; the database-layer
   checks in §8 stand in for it. Recorded as a scope limitation, not a
   pass.
