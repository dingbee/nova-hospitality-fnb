# WCE-08 — Integrated Platform Certification

**Programme:** LexiBite — WhatsApp Commerce & Engagement  
**Dependency:** WCE-00 through WCE-07  
**Implementation branch:** `wce/wce-08-integrated-certification`  
**Status:** CERTIFICATION CONTRACT — final integrated verification pending  
**Production promotion / DB writes / credential changes:** NOT AUTHORIZED

## 1. Objective

Certify the complete WCE platform as one governed, tenant-safe system. WCE-08 is not a UI completion milestone; it is the integrated acceptance gate for platform architecture, operational correctness, commercial integrity, security, reliability and release safety.

## 2. Integrated acceptance domains

### 2.1 Identity, tenancy and authorization
- Tenant/property/outlet isolation across phone bindings, webhook events, conversations, messages, guest CRM, consent, templates, campaigns, usage and conversion reports.
- Founder-only platform controls require commercial-admin authorization.
- Tenant APIs require explicit tenant membership; platform-admin status alone does not grant tenant guest-data access.
- No credentials, global Meta rates, cross-tenant guests or consolidated revenue leak to tenant roles.

### 2.2 Webhook and messaging reliability
- Meta webhook signature verification, replay/idempotency, durable receipt and retry/dead-letter handling.
- Inbound message processing and guest/session resolution.
- Canonical outbound outbox leases, idempotency, delivery-state reconciliation and retry policy.
- Global provider dispatch default-off; campaign dispatch has its own default-off gate; template submission has a separate explicit gate.
- No provider send or provider billing during UAT.

### 2.3 Guest Commerce and order lifecycle
- WhatsApp acquisition and conversation handoff to the canonical Guest Portal.
- One storefront, cart, checkout and order engine across channels.
- Guest Portal session linked to the canonical restaurant order.
- Order lifecycle notifications and guest-scoped event campaign triggers.
- No duplicate conversational ordering or parallel checkout/order authority.

### 2.4 Guest CRM, consent and AI Concierge
- Tenant-scoped guest identity, conversation and order linkage.
- Append-only consent history, STOP/opt-out and suppression.
- Marketing messages require current marketing consent at preparation and immediately before dispatch.
- Concierge responses remain grounded and hand over to staff when required.

### 2.5 Templates, campaigns and commercial controls
- Template category/approval lifecycle and effective-dated Meta market/category pricing.
- Scheduled and event-triggered campaign execution, audience evaluation and atomic daily/total caps.
- Entitlement checks at campaign activation and send time.
- Append-only idempotent usage ledger with separate Meta provider, LexiBite commercial and AI attribution.
- Reconciliation preserves currency and rate snapshots; queued, accepted, sent, delivered, failed, suppressed and billable are not treated as equivalent.

### 2.6 Founder and tenant operations
- Founder-only provider onboarding/health, webhook and dispatch health, usage, revenue and security views.
- Tenant inbox, CRM/consent, templates/campaigns, usage reports and conversion analytics.
- Conversion reporting reconciles WhatsApp Guest Portal sessions to canonical orders and paid outcomes.

## 3. Required end-to-end scenarios

1. Valid webhook → durable event receipt → idempotent inbound processing → tenant-scoped conversation.
2. Guest requests MENU/ORDER/HELP → secure Guest Portal handoff → session creation → canonical checkout.
3. Guest Portal checkout → canonical order → order-status notification and CRM linkage.
4. Marketing opt-in → eligible campaign audience; STOP/revocation → suppression before any provider send.
5. Approved template + active entitlement + within caps → campaign recipient queue; any failed gate → no dispatch.
6. Scheduled campaign is discovered by internal dispatcher; event campaign is triggered only for the matching guest/event.
7. Duplicate webhook, duplicate event, duplicate campaign recipient and duplicate usage event remain idempotent.
8. Provider dispatch disabled → all outbound messages remain queued/deferred; no external provider call occurs.
9. Usage/cost ledger reconciles to provider outcomes and existing commercial quota/billing authorities by currency.
10. Tenant A cannot read Tenant B inbox, guests, consent, campaigns, rates or reports; tenant roles cannot read founder controls.
11. Founder admin can inspect platform-wide health and billing evidence without exposing provider secrets.
12. WhatsApp session → canonical order → paid conversion metrics reconcile to source records.

## 4. Verification gates

- Exact-head changed-source lint.
- Targeted WCE tests and full repository test suite.
- Strict TypeScript check.
- Production build and route generation.
- PostgreSQL 17 clean migration replay from the WCE baseline.
- RLS, grants, RPC, tenant isolation and founder authorization assertions.
- Exact PR-head checks for WCE-02, WCE-03–05, WCE-06, WCE-07 and WCE-08.
- No unresolved P0/P1 security, tenancy, consent, financial-integrity or reliability defects.

## 5. External acceptance dependencies

- Meta Business/WABA ownership and verified phone-number bindings.
- Approved production templates, webhook configuration and production credentials.
- Provider sandbox/live-account acceptance where required.
- Tenant/property commercial configuration and subscription entitlements.
- These external dependencies do not justify bypassing software gates. UAT must use test credentials/mocks and keep provider dispatch and billing disabled.

## 6. Integrated implementation evidence

The WCE-08 branch now includes a delivery reconciliation migration that links campaign recipients to canonical outbound messages with a tenant-scoped foreign key and synchronizes recipient state from the canonical `wa_messages.status` lifecycle. The trigger is SECURITY DEFINER with a fixed search path and is covered by PostgreSQL replay assertions.

The WCE-07 conversion report uses the privileged server-side aggregate reader only after tenant/property membership and capability checks. It returns aggregate counts and revenue by currency, not raw Guest Portal session rows. Session-to-order conversion is based on distinct converted sessions, so multiple orders from one session do not inflate the conversion rate.
WhatsApp Concierge AI usage is tagged at the existing commercial AI usage source with `source_channel = 'whatsapp'`. The tenant and founder usage views combine those real AI cost records with the WCE campaign/provider ledger, retaining the existing AI cost authority rather than fabricating token prices or duplicating the commercial billing engine.

A repository deployment guardrail is recorded at `docs/operations/DEPLOYMENT_AUTHORIZATION_GUARDRAIL.md`. CI and local build verification are permitted; Vercel deployment, promotion, release, merge and production cutover remain explicit-authorization actions.

These additions are not yet certified until the latest exact-head CI and migration replay complete successfully.

## 7. Release constraints

- No production database migrations or writes.
- No production credential mutation or provider rebind.
- No live Meta dispatch or provider billing.
- No deployment, promotion, PR merge or production cutover without explicit release authorization.
- WCE-08 certification is evidence of software readiness only; it is not production authorization.

## 8. Exit criteria

WCE-08 closes only when all WCE phases have exact-head green verification, all required end-to-end scenarios pass, tenant/founder boundaries are proven, usage and conversion reconcile to canonical sources, and no unresolved P0/P1 findings remain. If an external Meta prerequisite is unavailable, record it as a release dependency; do not fabricate a pass.

## 9. Additional end-to-end hardening

- Event-triggered campaigns remain active after each guest-scoped event and use a stable source-event identity in recipient and outbox idempotency. Repeated delivery of the same order/status event is deduplicated; a later event for the same guest can be evaluated independently.
- Provider-cost reconciliation has a bounded, service-role-only PostgreSQL RPC. It recovers missing Meta usage ledger rows from successful canonical outbound messages using the original rate snapshot and provider message ID as the idempotency key.
- AI usage records explicitly distinguish priced estimates from unpriced requests. Reports do not present an absent AI cost estimate as a zero-cost event.
- The internal dispatcher invokes bounded provider-cost reconciliation after outbound processing. No provider send is enabled by this change.
- Repository-wide operating instructions prohibit Vercel deployment, preview deployment, promotion, alias/domain changes and rollback unless the user explicitly authorizes that specific action and target environment.
