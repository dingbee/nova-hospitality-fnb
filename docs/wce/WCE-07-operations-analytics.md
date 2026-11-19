# WCE-07 — Founder & Tenant Operations, Reporting and Analytics

**Programme:** LexiBite WhatsApp Commerce & Engagement  
**Dependency:** WCE-06 campaign governance and commercial controls  
**Implementation branch:** `wce/wce-07-operations-analytics`  
**Status:** IMPLEMENTATION VERIFIED — exact-head CI #458 PASS; integrated hardening continues in WCE-08  
**Production promotion / DB writes / credential changes:** NOT AUTHORIZED

## 1. Objective

Deliver the operational control surfaces required to run LexiBite WhatsApp Commerce safely across tenants. WCE-07 separates founder-level platform administration from tenant-level guest operations while reusing WCE-02 through WCE-06 domain services and evidence.

WhatsApp remains the acquisition, engagement, conversation and notification channel. The LexiBite Guest Portal remains the visual commerce and checkout authority. No parallel CRM, consent, subscription, entitlement, quota, billing or commerce authority may be introduced.

## 2. Founder-only platform control centre

Founder controls are restricted to the existing commercial/platform administrator authorization boundary. They must not appear in tenant navigation or be callable by tenant roles.

- Provider catalogue and Meta WhatsApp integration onboarding status.
- Tenant/property phone-number bindings, WABA/phone identifiers and integration health; never reveal access tokens or secrets.
- Webhook verification, last receipt, processing lag, retries/dead letters and delivery health.
- Internal dispatcher health, queue depth, oldest queued item, send outcomes and reconciliation backlog.
- Consolidated tenant/property usage with distinct Meta provider cost, LexiBite commercial usage and AI cost attribution.
- Revenue/billing evidence through existing commercial billing periods and invoice/usage authorities.
- Security posture: binding coverage, stale credentials/connection state, failed signature checks, access and audit events.
- Auditable founder actions for onboarding, pause/resume, provider rebind and security remediation.

No founder metric may be derived from client-supplied tenant IDs without a server-side founder authorization check.

## 3. Tenant operations workspace

All tenant-facing queries and mutations derive tenant, property and outlet from verified server context and respect RLS. Tenant users must never see another tenant's guests, messages, campaigns, rates, usage or conversion data.

### 3.1 WhatsApp inbox
- Tenant/property-scoped conversation list and message history.
- Open, human-handoff, closed and blocked/suppressed states.
- Read-only delivery and webhook status evidence.
- Staff handover and safe response workflow through the canonical outbox.
- No direct provider send from browser code.

### 3.2 Guest CRM and consent
- Reuse WCE-05 guest identity and append-only consent ledger.
- Guest profile, preferred language, linked conversations, orders and loyalty history.
- Current consent state, purpose, source and immutable event history.
- STOP/opt-out and blocked-guest suppression visibility.
- Never infer marketing consent from an order or transactional conversation.

### 3.3 Templates and campaigns
- Reuse WCE-06 template registry, Meta approval lifecycle and campaign state.
- Tenant users can manage tenant/property templates and campaigns within effective entitlement.
- Show template category, language, provider approval, rejection/pause state and usage.
- Show campaign audience/evaluation, scheduled/event trigger, caps, queued/sent/delivered/failed/suppressed outcomes.
- Campaign dispatch and Meta template submission remain explicitly disabled by default in UAT.

### 3.4 Usage, reports and conversion analytics
- Tenant/property usage reports sourced from WCE-06 append-only usage ledger and existing commercial quota/billing services.
- Separate Meta provider cost, LexiBite commercial usage and AI usage; preserve currency and rate snapshots.
- Reconcile queued, accepted, sent, delivered, failed, suppressed and billable events without treating them as equivalent.
- Conversion funnel: WhatsApp entry/handoff → Guest Portal session → canonical order → completed/paid outcome.
- Use canonical session/order linkage; do not create a duplicate order or attribution authority.
- Date-range and property/outlet filters must remain tenant-scoped.

## 4. Architecture and security constraints

- Founder APIs call existing `assertCommercialAdmin` before service-role data access.
- Tenant APIs use authenticated tenant context and existing permission/RLS boundaries; never trust client-provided tenant/property identifiers.
- Do not expose Meta credentials, global Meta rate cards, cross-tenant aggregates, or platform revenue to tenant roles.
- Keep provider secrets encrypted in the existing integration credential mechanism.
- Reuse WCE-02 inbox/outbox, WCE-05 CRM/consent, WCE-06 templates/campaigns/usage and existing commercial billing.
- Do not introduce duplicate subscriptions, entitlements, quotas, billing, guest CRM, consent, ordering or checkout.
- No production database writes/migrations, credential changes, live campaign dispatch, provider billing, deployment or promotion.

## 5. Required acceptance evidence

1. Founder-only API and route authorization tests; tenant roles receive denial for all platform controls.
2. Tenant role/property isolation tests across inbox, CRM, consent, templates, campaigns, usage and analytics.
3. No provider secret or global rate-card leakage in API responses, logs or client bundles.
4. Inbox tests cover conversation scope, handover and canonical outbox response path.
5. CRM/consent tests prove append-only history, STOP handling and blocked-guest suppression.
6. Template/campaign tests prove WCE-06 entitlement, approval, consent, caps and UAT dispatch gates remain enforced.
7. Usage tests prove separate Meta/LexiBite/AI attribution, currency/rate snapshots and idempotent reconciliation.
8. Conversion tests prove WhatsApp session-to-canonical-order linkage and tenant/property attribution.
9. Founder dashboard aggregates are reconciled against source records and existing commercial billing periods.
10. Changed-source lint, WCE tests, full repository tests, strict typecheck, production build/route generation and PostgreSQL 17 replay pass on exact PR head.

## 6. Initial implementation evidence

The dependent implementation branch currently includes:
- Tenant WhatsApp operations route with inbox/history, guest CRM and consent visibility, template/campaign workspace, usage and conversion reporting.
- Tenant-scoped server functions with restaurant membership, property/location scope and capability checks.
- Draft template creation and governed campaign draft/activate/pause actions; Meta template submission is not exposed in UAT.
- Founder-only platform control route with commercial-admin authorization, integration/binding health, webhook and outbound queue status, usage attribution, invoice balances by currency and security signals.
- Global provider dispatch is default-off unless `LEXIBITE_WHATSAPP_DISPATCH_ENABLED=true`; campaign dispatch additionally requires `LEXIBITE_WHATSAPP_CAMPAIGN_DISPATCH_ENABLED=true`. No live provider dispatch or billing is permitted in UAT.
- Authorization tests for founder-only platform reads and tenant access checks.

This is implementation evidence only. Exact-head lint, targeted tests, full tests, strict typecheck, build/route generation and PostgreSQL 17 replay remain required.

## 7. Exit criteria

WCE-07 closes only when founder/tenant surfaces are implemented, access boundaries are proven, reporting reconciles to canonical source evidence, conversion analytics are accurate, and exact-head CI is green. UI completion alone is not acceptance.

## 8. Explicit non-goals

- No parallel inbox, CRM, consent, subscription, entitlement, quota, billing or commerce system.
- No conversational ordering system.
- No tenant visibility into founder-only integration, security, consolidated revenue or global provider pricing.
- No production credential mutation, DB migration, live Meta campaign dispatch, provider billing, deployment or promotion.

## Exact-head verification

WCE-07 branch head `c7bdc305f024a1b77874d99beeedaca8b0ff2a93` passed exact-head WCE CI run #458: changed-source lint, targeted WCE tests, full repository tests, strict typecheck, production build/route generation and PostgreSQL 17 clean migration replay. This is software verification only; it does not authorize merge, Vercel deployment, production migration or live Meta dispatch.

## AI cost reporting integrity

AI request counts remain sourced from the canonical commercial AI usage ledger. A cost amount is reported only when the provider/costing path supplies an explicit estimate. Records without a cost estimate are counted as unpriced; they are never presented as zero-cost requests.

## Commercial usage visibility

Tenant reporting now separates Meta provider cost and AI cost from the current-period LexiBite campaign-message quota counter. Founder reporting aggregates active-period quota consumption by tenant/property from the existing commercial usage counters. Quota units are not misrepresented as monetary cost.
