# ME-17R-06 — SECURITY DEFINER Audit & Hardening

**Status:** COMPLETE — live security audit performed; three financial functions hardened; migration applied and verified.

## Scope

Audit every `SECURITY DEFINER` function in the live `public` schema of Supabase project `nova-hospitality-fnb`.

The historical ME-03 snapshot recorded 54 `SECURITY DEFINER` functions executable by `authenticated`. The current live schema contains **76 SECURITY DEFINER functions**; therefore this release audits the current state rather than relying on the historical count.

## Live audit results

| Control | Result |
|---|---:|
| SECURITY DEFINER functions | **76** |
| `search_path=public` pinned | **76 / 76** |
| Unpinned SECURITY DEFINER functions | **0** |
| SECURITY DEFINER functions executable by `anon` | **0** |
| Dynamic SQL detected | **0** |
| Authenticated-executable writable SECURITY DEFINER functions without an `auth.uid()` guard | **0** |

## Finding closed

One function was materially exposed:

### `restaurant_apply_giveaway(uuid)`

Before ME-17R-06 it was executable by `authenticated` and performed financial/order mutations without checking the caller's identity/tenant authority. It only checked that the referenced giveaway was already approved.

That created a direct-call path where an authenticated client who obtained an application UUID could invoke a financial mutation outside the intended management workflow.

**Fix:** authenticated direct invocation now requires restaurant management authority for the application tenant:

- owner
- general manager
- restaurant manager

Service/trigger execution remains supported when `auth.uid()` is null.

## Financial read-path hardening

Two authenticated-callable SECURITY DEFINER financial readers were also hardened:

### `restaurant_cash_payout_total(uuid,uuid,date)`

Authenticated callers must now belong to the requested tenant and, when a location is supplied, the corresponding property scope.

### `restaurant_expected_tender(uuid,text)`

Authenticated callers must now have read access to the daily-close property before tender totals are calculated.

Service/trigger execution remains supported when `auth.uid()` is null.

## Intentionally retained helper functions

A number of SECURITY DEFINER functions do not contain a local `auth.uid()` check because they are authorization helpers, property-resolution helpers, or trigger functions. They are not classified as defects merely because they lack a textual `auth.uid()` expression.

Examples include:

- `restaurant_can_read`
- `restaurant_can_read_scoped`
- `restaurant_can_write`
- `restaurant_can_write_scoped`
- `restaurant_location_property`
- `restaurant_menu_property`
- `restaurant_order_property`
- `restaurant_fiscal_*_property`
- trigger functions such as `restaurant_tender_declaration_control`

Their security model depends on their caller context and/or their use as database policy/trigger helpers. Removing authenticated EXECUTE from these helpers blindly would break the RLS architecture.

## Migration

Added:

`standalone/db/migrations/0093_me17r06_security_definer_hardening.sql`

The same migration was applied to the live Supabase project through the migration mechanism.

No unrelated schema changes were introduced.

## Verification

Post-migration live verification returned:

- **76 / 76** SECURITY DEFINER functions pinned to `search_path=public`
- **0** unpinned
- **0** anon-executable
- **0** dynamic SQL
- **0** authenticated-executable writable functions without an auth guard

## Release disposition

**ME-17R-06 CLOSED.**

This release closes the specific SECURITY DEFINER privilege-escalation/provenance concern identified in the market-entry certification programme while preserving the existing RLS/helper architecture.
