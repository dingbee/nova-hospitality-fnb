# ME-17R-07 — Database Performance / RLS Hardening

## Objective

Close the live Supabase performance findings identified for release certification:

- 7 unindexed foreign keys
- 10 RLS auth initialization-plan findings
- 5 multiple permissive-policy findings

The 280 unused-index notices are **not** removed in this phase. They are retained as index-governance debt pending workload evidence; dropping them blindly would risk removing useful indexes whose workload has not yet exercised them.

## Live findings remediated

### Foreign keys

Added covering indexes for:

1. `api_credentials.property_id`
2. `api_idempotency_records.credential_id`
3. `api_integrations.property_id`
4. `api_request_log.property_id`
5. `api_webhook_endpoints.integration_id`
6. `api_webhook_endpoints.property_id`
7. `lexibite_demo_sessions.registration_id`

### RLS init-plan findings

Rewrote the ten flagged policies to use statement-cached helper calls, principally `(select auth.uid())`. This preserves authorization semantics while preventing per-row re-evaluation of the request identity.

Affected policies:

- `lexibite_demo_registrations self read`
- `lexibite_demo_sessions self read`
- `activity logs insert own`
- `activity logs read scoped`
- commercial providers manageable
- commercial providers readable (removed as redundant)
- commercial AI models manageable
- commercial AI models readable (removed as redundant)
- commercial AI providers manageable
- commercial AI providers readable (removed as redundant)

The three readable commercial policies were also eliminated as separate policies in the same operation because their authorization predicate was identical to the corresponding `FOR ALL` policy.

### Multiple permissive policies

Consolidated the five duplicate authenticated SELECT policy pairs by retaining the existing `FOR ALL` management policy and removing the redundant SELECT-only policy. The retained policy has the same authorization predicate and continues to govern SELECT, INSERT, UPDATE, and DELETE.

Affected tables:

- `api_integrations`
- `api_webhook_endpoints`
- `commercial_ai_models`
- `commercial_ai_providers`
- `commercial_providers`

## Production application

Migration applied to Supabase project `nova-hospitality-fnb` as:

`me17r07_performance_hardening`

The migration contains only deterministic DDL/policy changes and no data mutation.

## Verification

Post-migration verification must include:

- Supabase performance advisors: unindexed FKs = 0
- auth RLS init-plan = 0
- multiple permissive policies = 0
- all seven new indexes present and valid
- no unintended policy changes outside the targeted tables
- 280 unused-index notices explicitly retained/deferred

## Release disposition

ME-17R-07 implementation is complete once advisor verification returns the target zero counts and the migration is committed to the release branch. This phase does not claim overall production certification; Vercel deployment verification and the remaining release gates are separate.
