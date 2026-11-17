# LexiBite WCE — Execution Completion Register

**Repository:** `dingbee/nova-hospitality-fnb`  
**WCE-02 foundation PR:** #195  
**WCE-03 through WCE-05 continuation PR:** #199  
**Production promotion:** NOT AUTHORIZED  
**Production database writes/migrations:** NOT AUTHORIZED

## Phase register

| Phase | Status | Implementation evidence | Verification evidence | Outstanding dependency |
|---|---|---|---|---|
| WCE-00 — Architecture reconnaissance | CLOSED | `docs/wce/WCE-00-reconnaissance.md` | Portal-first architecture, reusable domain map, security gap register and dependency map reconciled against repository/live read-only schema | None for WCE-00 |
| WCE-01 — Native Meta foundation | SOFTWARE CLOSED | Native Meta Graph API, Embedded Signup contracts/client, onboarding and provider adapter in PR #195 | PR #195 CI run #43961599240 passed typecheck, lint, build, scoped/full tests and migration replay | Meta app/business approval and verified test WABA/phone; live API verification |
| Migration provenance gate | VERIFIED FOR ISOLATED REPLAY | `docs/wce/WCE-MIGRATION-PROVENANCE.md`; recovered applied sources and corrected historical SQL | PostgreSQL 17 clean replay passed in PR #195 CI #43961599240 | Production ledger remains untouched; no production migration authorization |
| WCE-02 — Messaging and session infrastructure | IMPLEMENTATION VERIFIED — exact-head CI #292 PASS | Migration `0138_wce02_messaging_sessions.sql`; tenant/property bindings, Meta webhook, durable inbox/worker, delivery status and hashed Guest Portal sessions | Run #292 on `feaa8cc58ad0759b7421416d425feffca092d15d`: lint phase gate, WCE tests, full suite, strict typecheck, build/route generation and PostgreSQL 17 replay PASS | PR #195 is not mergeable against main yet; conflict reconciliation and Meta runtime/test assets remain required |
| WCE-03 — WhatsApp-to-Guest-Portal handoff | IMPLEMENTATION VERIFIED — exact-head CI #295 PASS | PR #199: `guest-commerce.server.ts`, `outbound-queue.server.ts`, migration `0139_wce03_outbound_message_outbox.sql`, dispatcher integration | Run #295 on `73ef9145517d2751d19a955e56d25738825816f5`: lint, WCE tests, full suite, strict typecheck, build and cumulative PostgreSQL 17 replay PASS | PR #199 remains draft; no production release authorization |
| WCE-04 — Unified Guest Commerce and checkout | IMPLEMENTATION VERIFIED — exact-head CI #295 PASS | PR #199: Guest Portal route/functions, canonical catalogue/pricing/modifier resolution, cart and takeaway checkout; migration `0140_wce04_guest_commerce_checkout.sql` | Included in exact-head run #295; full WCE and repository tests, strict typecheck, build and clean replay PASS | Stock/recipe availability, checkout idempotency, pricing/currency and property/outlet isolation remain runtime acceptance dependencies |
| WCE-05 — Orders, CRM and AI Concierge | IMPLEMENTATION VERIFIED — exact-head CI #295 PASS | PR #199: tenant-scoped guest CRM/consent, order lifecycle notifications, handover, loyalty and FAQ grounding; migrations `0141`–`0143` | Included in exact-head run #295; full WCE and repository tests, strict typecheck, build and clean replay PASS | External provider test assets and operational acceptance remain release dependencies |
| WCE-06 — Campaign governance and commercial controls | IMPLEMENTATION VERIFIED — exact-head CI #300 PASS | PR #202; migration `0144_wce06_campaign_commercial_controls.sql`; campaign governance; scheduled/event orchestration; send-time consent/entitlement/template checks; default-off provider dispatch; effective-dated rates and append-only usage evidence | Run #300 on implementation head `6e2ad0df083853dceccc3695ffd2400fbfa685e3`: lint, WCE tests, full suite, strict typecheck, build and cumulative PostgreSQL 17 RLS/RPC assertions PASS | PR #202 remains draft; GitHub reports mergeability dirty; reconcile branch before merge. No production dispatch/billing |
| WCE-07 — Founder/tenant operations and analytics | IMPLEMENTATION VERIFIED — exact-head CI #298 PASS | PR #204; founder-only provider health/usage/revenue/security control centre; tenant inbox, CRM/consent, templates/campaigns, usage and conversion reporting | Run #298 on `31f46e5c6d57c4b5703083bd446d81ec5bde359a`: lint, WCE tests, full suite, strict typecheck, build and cumulative PostgreSQL 17 replay PASS | PR #204 remains draft/unmerged; no live provider dispatch or billing in UAT |
| WCE-08 — Integrated acceptance and certification | SOFTWARE CI VERIFIED — exact-head CI #299 PASS; live-provider E2E pending | PR #205; integrated platform acceptance contract, cross-phase test matrix and release-safety gate | Run #299 on `08e14d44caa95f45da45813c3e6347ce0c065880`: lint, WCE tests, full suite, strict typecheck, build and cumulative PostgreSQL 17 replay PASS | Live Meta Business/WABA/phone, approved production templates, production webhook delivery and provider billing remain external release dependencies |

## WCE-03 implementation evidence

- MENU / ORDER / HELP intent routing uses the tenant/property/outlet-resolved conversation context.
- Guest Portal session handoff uses the existing scoped session contract; the portal is the visual commerce interface.
- Menu discovery resolves the canonical sellable catalogue and authoritative price resolver.
- Outbound replies use the durable `wa_messages` outbox with stable idempotency keys; they do not send directly from inbound orchestration.
- Service-role-only claim RPC, bounded leases, scoped credential resolution and conservative retry/reconciliation protect against duplicate delivery.
- Inbound retries re-run idempotent orchestration so transient outbox persistence failures do not permanently suppress replies.

## WCE-04 implementation evidence

- Guest Portal browse and checkout use the canonical sellable catalogue, pricing rules, modifier resolution and guest sales engine.
- Takeaway order submission derives tenant/property/outlet/currency server-side and preserves session provenance.
- Guest order idempotency and payment timing policy are preserved.
- Cart supports quantities, variants and modifier selections; minimum modifier selections are enforced.
- Outlet-scoped recipe-stock availability, nested recipe fail-closed behaviour, quantity-aware stock limits and active reservations constrain sellable quantities.

## WCE-05 implementation evidence

- Tenant-scoped guest CRM identity and append-only consent ledger; inbound WhatsApp identity links to the tenant guest CRM.
- Explicit WhatsApp marketing-consent keywords and consent-aware routing.
- Guest CRM profile attaches to canonical and Guest Portal orders.
- Ask NOVA / Concierge uses scoped outlet context and property-approved bilingual FAQ knowledge.
- Order lifecycle notifications, delivery reconciliation/retry safety, staff handover and AI pause are implemented.
- Loyalty accrual/balance and Guest Portal guest history are integrated with canonical order lifecycle hooks.
- Blocked guest restrictions suppress transactional WhatsApp notices; CRM/loyalty evidence protections are append-only.

## Acceptance workflow

The unified WCE workflow is phase-aware and runs changed-source lint from the WCE-02 baseline, phase-available WCE tests, the full repository test suite, strict typecheck, production build/route generation and PostgreSQL 17 clean migration replay with cumulative WCE-02, WCE-03–05 and WCE-06 schema/security assertions. Exact-head software CI is green on WCE-02 (#292), WCE-03–05 (#295), WCE-06 (#300), WCE-07 (#298) and WCE-08 (#299). PR #195 remains unmergeable against main and PR #202 reports a dirty merge state; these require branch conflict reconciliation before merge. No merge or production release is implied.

## External dependency register

1. Meta App ID and App Secret, Meta Business verification, Embedded Signup v4 configuration, Advanced Access/App Review and a verified test WABA/phone.
2. Runtime `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
3. Runtime `LEXIBITE_GUEST_PORTAL_BASE_URL` (HTTPS in production).
4. Existing `CRON_SECRET` must match the Supabase Vault secret `lexibite_cron_secret` used by the dispatcher schedule.
5. Tenant/property Pesapal integration credentials and a defined restaurant reservation authority are required before WCE-06 live acceptance.
6. Live Meta delivery and callback verification remain unclaimed until the above assets are supplied and tested.

## Operating rule

Software implementation and isolated CI do not authorize production release. Do not merge PR #195/#199, apply WCE migrations to production, change production credentials/data, or trigger manual Vercel deployments without explicit release authorization. WCE-03 through WCE-05 acceptance is green. Continue WCE-06 on a separate dependent branch; do not merge PR #195/#199 or promote production without explicit release authorization.
