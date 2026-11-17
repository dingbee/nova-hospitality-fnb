# WCE-06 — Campaign Governance & Commercial Controls

**Programme:** LexiBite WhatsApp Commerce & Engagement  
**Dependency base:** WCE-03–05 continuation, PR #199 head `7337213f4f4cfc0d64fcefe2fbd880a74c2fbbb3`  
**Implementation branch:** `wce/wce-06-campaign-commercial-controls`  
**Status:** EXECUTION CONTRACT — implementation and verification pending  
**Production promotion / DB writes / credential changes:** NOT AUTHORIZED

## 1. Objective

Deliver governed WhatsApp campaign operations and auditable commercial controls without introducing a parallel CRM, subscription, entitlement, billing, pricing, or order authority.

WhatsApp remains the acquisition, engagement, and notification channel. The LexiBite Guest Commerce Portal remains the primary visual menu, cart, checkout, and order experience. The canonical LexiBite commerce services remain authoritative.

## 2. Scope

### 2.1 Template governance

- Maintain a tenant-scoped registry of WhatsApp message templates and Meta template categories.
- Track template lifecycle states, including local draft, submitted, approved, rejected, paused, and disabled; Meta approval state is authoritative where a provider status exists.
- Persist provider template identifiers, locale, category, parameter contract, approval evidence, status timestamps, and version history.
- Prevent campaigns from using unapproved, paused, disabled, or category-incompatible templates.
- Keep template submission and approval synchronization server-side and auditable.

### 2.2 Consent, suppression, and audience segmentation

- Reuse the WCE-05 append-only guest consent ledger; do not create a second consent source.
- Enforce explicit, purpose-specific WhatsApp marketing consent at audience resolution and again immediately before dispatch.
- Honour STOP/opt-out and blocked-guest suppression across scheduled and event-triggered campaigns.
- Support tenant/property-scoped, explainable segments using permitted CRM attributes and consent state.
- Do not infer consent from a guest's transactional conversation or prior purchase.

### 2.3 Campaign orchestration

- Support draft, scheduled, event-triggered, running, paused, completed, cancelled, and failed campaign states.
- Resolve campaign audience, template, locale, property/outlet scope, schedule, and idempotency server-side.
- Use durable queue/outbox delivery with bounded leases, retry policy, deduplication, delivery reconciliation, and auditable operator actions.
- Re-check consent, guest suppression, template approval, entitlement, and sending caps at dispatch time.
- Provide safe pause/cancel semantics and prevent duplicate sends after worker retries.

### 2.4 Subscription entitlement, caps, and suspension

- Reuse the existing commercial subscription, capability entitlement, quota, override, and usage services.
- Do not introduce a separate WCE subscription or billing authority.
- Gate campaign creation and dispatch by the effective tenant subscription and configured capability entitlements.
- Enforce admin-configured campaign/message caps, overage policy, and suspension state; never hardcode plan prices or limits.
- Respect effective-dated overrides and ensure suspended/expired tenants cannot continue dispatch through queued work.

### 2.5 Effective-dated pricing and cost attribution

- Support effective-dated Meta messaging rates by market and message category, with currency and source/evidence metadata.
- Preserve historical rate snapshots for usage already recorded; rate changes must not rewrite past cost evidence.
- Attribute costs separately to:
  1. Meta WhatsApp provider messaging charges;
  2. LexiBite subscription / commercial charges;
  3. AI / Concierge provider usage.
- Keep provider cost, LexiBite charge, and AI usage distinct; do not double-count or blend them into a single opaque amount.
- Reuse existing commercial billing periods and reporting structures.

### 2.6 Usage ledger, billing, and reporting

- Record append-only, idempotent usage events for accepted dispatches, provider outcomes, category/market rate snapshots, and attributable AI usage.
- Link usage to tenant, property, campaign, template, conversation/message, provider, category, currency, effective rate, and billing period where applicable.
- Reconcile submitted, accepted, delivered, failed, retried, suppressed, and billable quantities without treating them as interchangeable.
- Expose tenant-scoped usage and cost reporting; founder-level consolidated reporting belongs in WCE-07.
- Reconciliation must be repeatable and idempotent.

## 3. Security and architecture constraints

- Derive tenant, property, outlet, guest, and provider binding from verified server-side context; never trust client-supplied scope.
- Enforce tenant/property isolation in database constraints, RLS, service contracts, and tests.
- Keep Meta credentials encrypted and tenant/property-configured using the existing integration credential mechanism.
- Never expose provider secrets to tenant clients, campaign payloads, logs, or analytics.
- Keep service-role-only queue claim/dispatch operations protected with fixed search paths and explicit grants.
- Keep consent, usage, rate snapshots, and campaign audit evidence append-only where financial or compliance integrity requires it.
- No production database writes, production migrations, credential changes, deployment, or promotion.

## 4. Required acceptance evidence

1. Template lifecycle tests cover approval, rejection, pause, disable, locale/category mismatch, and stale provider status.
2. Consent tests prove opt-in required, STOP takes effect immediately, queued campaigns re-check consent, and blocked guests are suppressed.
3. Segment tests prove tenant/property isolation and deterministic membership.
4. Campaign tests prove schedule/event idempotency, pause/cancel, worker retry, duplicate suppression, and delivery reconciliation.
5. Entitlement tests prove plan/capability/quota gating, effective-dated overrides, cap enforcement, and suspension of queued dispatch.
6. Pricing tests prove market/category/effective-date selection, currency handling, historical snapshot immutability, and no hardcoded rates.
7. Cost tests prove separate Meta, LexiBite, and AI attribution with no duplicate billing.
8. Usage-ledger tests prove append-only evidence, idempotent ingestion, reconciliation, and tenant-scoped reporting.
9. PostgreSQL 17 clean migration replay and RLS/grant assertions pass.
10. Changed-source lint, WCE tests, full repository tests, strict typecheck, production build, and route generation pass on the exact PR head.

## 5. Exit criteria

WCE-06 is not closed by schema or UI completion alone. It closes only when implementation, migration replay, security tests, cost/usage reconciliation, and exact-head CI are green, with no unresolved P0/P1 tenancy, consent, security, or financial-integrity defects.

## 6. Explicit non-goals

- No conversational ordering system or duplicate storefront.
- No duplicate guest CRM or consent ledger.
- No parallel subscription, entitlement, quota, or billing engine.
- No production Meta campaign dispatch or live provider billing during UAT.
- No production migration, credential mutation, deployment, or promotion.
- No unrelated redesign or feature work.
