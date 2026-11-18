# LexiBite WCE — Execution Completion Register

**Repository:** `dingbee/nova-hospitality-fnb`  
**Active integration PR:** #195  
**Production promotion:** NOT AUTHORIZED  
**Production database writes/migrations:** NOT AUTHORIZED

## Phase register

| Phase | Status | Implementation evidence | Verification evidence | Outstanding dependency |
|---|---|---|---|---|
| WCE-00 — Architecture reconnaissance | CLOSED | `docs/wce/WCE-00-reconnaissance.md` | Portal-first architecture, reusable domain map, security gap register and dependency map reconciled against repository/live read-only schema | None for WCE-00 |
| WCE-01 — Native Meta foundation | CLOSED (software) | `src/modules/messaging/providers/meta-cloud-api.server.ts`, Embedded Signup client/contracts, onboarding service and tests | PR #195 CI run `43960937024`: typecheck, lint, build, scoped and full tests PASS | Meta app/business approval and live WABA assets |
| Migration provenance gate | VERIFIED | `docs/wce/WCE-MIGRATION-PROVENANCE.md`; recovered applied sources and corrected historical SQL | PostgreSQL 17 clean replay PASS on PR #195; 222/222 public tables RLS-enabled | None for isolated WCE-02 migration path; production ledger remains untouched |
| WCE-02 — Messaging and session infrastructure | CLOSED (software) | Migration `0138_wce02_messaging_sessions.sql`; `bindings.server.ts`; `webhooks.server.ts`; `webhook-queue.server.ts`; `guest-portal-sessions.server.ts`; Meta webhook and dispatcher routes | PR #195 CI run `43960937024`: scoped tests 141/141; full suite 2,627/2,627 across 244 files; clean replay, typecheck, lint, build and regression gates PASS | Runtime Meta secrets, Guest Portal base URL and scheduled dispatcher secret configuration |
| WCE-03 — WhatsApp-to-Guest-Portal handoff | NOT STARTED | Depends on WCE-02 | — | Outbound outbox, handoff orchestration, branded guest entry |
| WCE-04 — Unified Guest Commerce | NOT STARTED | Depends on WCE-03 | — | Session-aware menu/cart/checkout using canonical commerce services |
| WCE-05 — Orders, CRM and AI Concierge | NOT STARTED | Depends on WCE-02 and WCE-04 | — | Tenant-isolated restaurant customer/consent domain and lifecycle integration |
| WCE-06 — Payments, reservations and fulfilment | NOT STARTED | Depends on WCE-04 and WCE-05 | — | Tenant/property Pesapal credentials; authoritative restaurant reservation domain |
| WCE-07 — Commercial controls, campaigns and analytics | NOT STARTED | Depends on domain contracts | — | WhatsApp entitlements, usage/cost ledger, templates, campaign and attribution controls |
| WCE-08 — Integrated acceptance and certification | NOT STARTED | Depends on WCE-00 through WCE-07 | — | Live Meta test assets and full multi-tenant E2E/UAT |

## WCE-02 implementation evidence

- Meta provider is registered as a universal `messaging` channel; generic manual credential creation and rotation are blocked.
- One WABA per property with multiple verified phone assets retained in the existing encrypted `api_integrations` record.
- Receiving phone number maps to one authorized active customer-facing outlet. Database foreign keys and triggers enforce tenant/property/outlet/integration/WABA/phone asset consistency.
- Webhook GET challenge and raw-body HMAC-SHA256 validation precede parsing. Valid events are durably persisted before acknowledgement; unknown/inactive phone numbers are quarantined without tenant context.
- Inbox deduplication, per-phone ordering, leases, retry/backoff, dead-letter blocking, authorized requeue and audited poison-event rejection are implemented.
- Inbound conversations/messages are idempotent; delivery status transitions are monotonic.
- Guest Portal session tokens are 256-bit random, stored as SHA-256 hashes, browse-only, 30-minute, capped at 20 successful resolutions, revocable and resolved through service-only RPC.
- All five new public tables have RLS enabled. Webhook inbox and session tables have no authenticated policies; service-role only. Conversation/message/binding reads and writes use tenant/property-scoped policies.
- No production migration, write, credential change, deployment or promotion occurred.

## External dependency register

1. Meta App ID and App Secret, Meta Business verification, Embedded Signup v4 configuration, Advanced Access/App Review and a verified test WABA/phone.
2. Runtime `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
3. Runtime `LEXIBITE_GUEST_PORTAL_BASE_URL` (HTTPS in production).
4. Existing `CRON_SECRET` must match the Supabase Vault secret `lexibite_cron_secret` used by the dispatcher schedule.
5. Live Meta API delivery and webhook callback verification remain unclaimed until the above assets are supplied and tested.

## Operating rule

Software phase closure does not authorize production release. Continue with WCE-03 on a separate feature branch after WCE-02 evidence is preserved. Do not merge PR #195 or apply migration 0138 to production without a separate explicit release mandate.

## 18 November 2026 — Integration replay hardening

- The recovered station-assignment RLS migrations (0090 and 0135) now drop only their three command-specific policies before recreating the verified least-privilege definitions. This makes clean replay safe when the same policies are already present in the baseline schema.
- The repository-wide isolated CI replay now removes the 0087 UAT repair skip entry only in its disposable fixture-backed workspace. Normal local installs continue to skip this property-specific data repair.
- No production database, credentials, provider dispatch or deployment was changed.
