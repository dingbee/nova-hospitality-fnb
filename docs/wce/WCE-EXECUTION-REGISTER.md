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
| WCE-02 — Messaging and session infrastructure | IMPLEMENTATION PRESENT — exact-head acceptance pending | Migration `0138_wce02_messaging_sessions.sql`; bindings, Meta webhook, durable inbox/worker, delivery status, hashed Guest Portal sessions | PR #195 CI #43961599240 passed; 141/141 scoped tests and 2,627/2,627 full-suite tests recorded in phase evidence; clean replay, typecheck, lint and build passed | Runtime Meta secrets, Guest Portal base URL and dispatcher secret configuration; PR #195 remains unmerged |
| WCE-03 — WhatsApp-to-Guest-Portal handoff | IMPLEMENTATION PRESENT — exact-head acceptance pending | PR #199: `guest-commerce.server.ts`, `outbound-queue.server.ts`, migration `0139_wce03_outbound_message_outbox.sql`, dispatcher integration | WCE CI #151 passed on head `56231b7258ba7e7eed09f678afdb51a2583947d5`; scoped tests, full suite, typecheck, build and clean replay green | CI, multi-tenant/outbox idempotency and delivery/retry acceptance |
| WCE-04 — Unified Guest Commerce and checkout | IMPLEMENTATION PRESENT — exact-head acceptance pending | PR #199: Guest Portal route/functions, canonical catalogue/pricing/modifier resolution, cart and takeaway checkout; migration `0140_wce04_guest_commerce_checkout.sql` | Dedicated WCE CI not yet evidenced on continuation head; acceptance run required | CI, stock/recipe availability, checkout idempotency, pricing/currency and property/outlet isolation |
| WCE-05 — Orders, CRM and AI Concierge | IMPLEMENTATION PRESENT — exact-head acceptance pending | PR #199: tenant-scoped guest CRM/consent, order lifecycle notifications, handover, loyalty, FAQ grounding; migrations `0141`–`0143` | Dedicated WCE CI not yet evidenced on continuation head; acceptance run required | CI, consent enforcement, blocked-guest suppression, notification reconciliation, loyalty immutability and AI scope tests |
| WCE-06 — Payments, reservations and fulfilment | NOT STARTED | No implementation evidence in active WCE continuation | — | Tenant/property-configured Pesapal and authoritative restaurant reservation contract; no inferred PMS booking reuse |
| WCE-07 — Commercial controls, campaigns and analytics | NOT STARTED | No implementation evidence in active WCE continuation | — | Reuse commercial entitlements/quotas, Meta template governance, campaign consent and attribution/cost analytics |
| WCE-08 — Integrated acceptance and certification | NOT STARTED | No integrated certification evidence | — | WCE-00 through WCE-07 acceptance, live Meta test assets, multi-tenant E2E and operational runbook |

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

The WCE workflow is now present on both the WCE-02 base branch and continuation branch. It is read-only with respect to repository contents and runs changed-source lint, scoped WCE tests, full repository tests, strict typecheck, production build/route generation and PostgreSQL 17 clean migration replay. Earlier WCE-03–05 implementation checks passed on an older SHA, not the current PR #199 head `042c468ec7a87413ecf605920983c9b27a9226fa`; exact-head certification remains required. WCE-06 is separately verified on its dependent branch; no merge or production release is implied.

## External dependency register

1. Meta App ID and App Secret, Meta Business verification, Embedded Signup v4 configuration, Advanced Access/App Review and a verified test WABA/phone.
2. Runtime `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
3. Runtime `LEXIBITE_GUEST_PORTAL_BASE_URL` (HTTPS in production).
4. Existing `CRON_SECRET` must match the Supabase Vault secret `lexibite_cron_secret` used by the dispatcher schedule.
5. Tenant/property Pesapal integration credentials and a defined restaurant reservation authority are required before WCE-06 live acceptance.
6. Live Meta delivery and callback verification remain unclaimed until the above assets are supplied and tested.

## Operating rule

Software implementation and isolated CI do not authorize production release. Do not merge PR #195/#199, apply WCE migrations to production, change production credentials/data, or trigger manual Vercel deployments without explicit release authorization. WCE-03 through WCE-05 acceptance is green. Continue WCE-06 on a separate dependent branch; do not merge PR #195/#199 or promote production without explicit release authorization.
