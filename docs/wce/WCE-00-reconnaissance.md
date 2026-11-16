# WCE-00 — Repository and Architecture Reconnaissance

**Programme:** LexiBite WhatsApp Conversational Commerce (WCE-00 → WCE-08)  
**Status:** Findings established; implementation path approved with explicit gates  
**Inspection date:** 2026-11-16  
**Repository baseline inspected during continuation:** `main` at `f6fd6824c672b386c1b0a4c450dd08cc5a28c443` (the WCE branch originated at `5e68a32dbd502092564f24f49a8e82effce6cf97`)  
**Supabase project:** `nova-hospitality-fnb` (`lusiqcmxfxhnehxmwihs`, PostgreSQL 17.11)  
**Inspection mode:** GitHub source inspection + live Supabase read-only catalog, migration and policy inspection. No production writes, migrations, credential reads, or customer/financial row reads were performed.

## 1. Executive finding

The repository already contains substantial reusable capabilities for guest ordering, authoritative pricing, POS order creation, Pesapal verification, AI menu assistance, commercial entitlement governance, encrypted third-party integrations, a universal channel catalogue, restaurant events, and outbound webhook delivery.

It does **not** contain a native Meta WhatsApp Cloud API integration or WhatsApp-specific data model. Existing WhatsApp references are a limited notification adapter using Twilio-era environment configuration. This is not a native Meta integration and must not be treated as one.

The approved implementation is an additive native Meta messaging adapter and conversation domain. WhatsApp is the acquisition, conversation, identity and notification channel; the LexiBite Guest Portal is the primary visual commerce interface for menu discovery, cart, checkout and tracking; the existing LexiBite Commerce Engine remains authoritative for quote, order, payment, inventory and fulfilment. Conversational ordering remains an alternative interaction. Both interfaces must call the same domain services and must never create a second order, menu, pricing, payment, inventory, reservation or subscription authority.

WCE-00 establishes a safe implementation blueprint. Database changes remain gated by the migration-provenance reconciliation and the specific security findings in this report.

## 2. Repository and runtime baseline

- Canonical branch: `main`; inspected commit `5e68a32dbd502092564f24f49a8e82effce6cf97`.
- Current `main` migration directory: 157 SQL files under `standalone/db/migrations/`; duplicate numeric prefixes exist and filenames are not a safe migration ordering key.
- Connected production migration ledger: 171 applied records.
- Live public schema: 217 tables; all 217 have RLS enabled; none has FORCE ROW LEVEL SECURITY.
- No WhatsApp-specific tables were found in the live public schema.
- PostgreSQL: 17.11, Supabase project status ACTIVE_HEALTHY.
- `pg_cron` and `pg_net` are installed. A five-minute cron dispatches the existing LB-02 integration endpoint; another daily job generates due operational expenses. This is not a general WhatsApp queue.
- `pgmq` is available in the extension catalogue but is not installed.
- Latest observed repository CI activity was on `feature/p0-02-inventory-intelligence`; run `43941886632` was pending at inspection time. It is unrelated to WCE and was not modified.

## 3. Existing capability inventory and reuse contracts

| WCE requirement | Existing source of truth / service | Finding and required treatment |
|---|---|---|
| Menus and products | `restaurant_menus`, `restaurant_menu_items`; menu/catalogue services | Reuse existing sellable catalogue and property/location scope. |
| Pricing, modifiers, tax, service charge | `src/modules/restaurant/pricing/`, `sales/modifiers.server.ts`, pricing resolution | Reuse canonical quote path. Never calculate order totals in the WhatsApp adapter or trust model/client prices. |
| Order creation and POS | `src/modules/restaurant/selforder/selforder.server.ts`, `src/modules/restaurant/sales/sales.server.ts` | Reuse `createGuestOrder` and the existing order lifecycle; preserve database idempotency and POS/kitchen events. |
| Guest sessions | `restaurant_guest_sessions`, `selforder` services | Current sessions are table-bound and time-boxed. WhatsApp needs a separate verified sender/conversation identity; do not pretend a WhatsApp sender is a table session. |
| Payments | `src/modules/restaurant/selforder/providers/pesapal.server.ts`, `selfpay.server.ts`, `api/pesapal-ipn.ts` | Existing server-side Pesapal verification is reusable, but its current adapter reads global `PESAPAL_*` environment variables. It is not yet tenant-configured; WCE-04 must introduce tenant/property configuration through the encrypted integration boundary and inject the resolved credentials server-side. |
| Mobile money | `restaurant_mobile_money_provider_connections`, mobile-money payment core | Tenant provider configuration and collection lifecycle already exist. Reuse the authoritative payment settlement path; do not treat a collection request as captured funds. |
| Reservations | `restaurant_stock_reservations` | This is inventory reservation, not guest table booking. No restaurant guest-reservation service was located in the inspected source. `bookings` belongs to the hospitality/PMS bridge and must not be assumed to provide restaurant table availability. WCE-04 must either identify an existing reservation contract in a later full search or introduce a properly scoped restaurant reservation service; no availability may be invented. |
| AI Concierge | `src/modules/restaurant/selforder/selfnova.server.ts`, `selforder-asknova.ts`, reasoning provider | Ask NOVA is a grounded menu-discovery assistant and already uses commercial AI entitlement and usage governance. Extend through authorized domain tools; do not create a second AI transport or allow direct financial/stock mutation. |
| Commercial subscriptions and quotas | `restaurant_subscriptions`, `commercial_capabilities`, `commercial_plan_entitlements`, `commercial_quota_definitions`, `commercial_usage_counters` | Reuse the commercial entitlement system. Do not create `wa_subscriptions`. Add WhatsApp capability and quota definitions through the existing commercial governance path. |
| AI cost attribution | `commercial_ai_usage_log`, `src/modules/commercial/ai-governance.server.ts` | Reuse for model token and AI processing cost. Keep AI cost separate from Meta messaging charges. |
| Integration registry and secrets | `api_integrations`, `src/modules/api-platform/crypto.server.ts` | `api_integrations` already has tenant/property scope and AES-256-GCM ciphertext/IV/tag fields. Its server-held `NOVA_API_PLATFORM_ENCRYPTION_KEY` fails closed if missing. Reuse this credential vault rather than creating a parallel `wa_credentials` table unless a proven multi-secret lifecycle requirement cannot be represented safely. |
| Channel catalogue and provider boundary | `api_channel_definitions`, `src/modules/api-platform/channel-catalog.ts`, `channel-connectors.server.ts`, `docs/universal-channel-integration.md` | Register Meta WhatsApp as a native provider adapter. Current channel category constraint allows marketplace, ordering_platform, delivery and aggregator only; add a distinct messaging category through a reconciled migration. Keep platform channel definition governance founder-only. |
| Outbound webhook delivery | `api_webhook_endpoints`, `api_webhook_deliveries` | Existing subsystem is for tenant-configured outbound webhooks; it is not a Meta inbound event inbox. |
| Durable integration inbox/outbox | LB-02 tables `lb02_inbox_events`, `lb02_outbox_events`, delivery attempts and cron dispatcher | These are StayNas-product-connection-specific, with strict product/event contracts. Reuse patterns only; do not attach WhatsApp events to LB-02 tables or weaken their scope. |
| Restaurant events | `src/modules/restaurant/events/contracts.ts`, `emit.server.ts` | Use existing domain events for order/payment/kitchen lifecycle notifications. Add only missing event contracts; no duplicate event bus. |
| CRM/customer identity | `guests`, `guest_preferences`, guest-context services | These are not safe as a tenant CRM identity store (see security finding below). No canonical restaurant customer or loyalty domain was found. WCE-05 must establish a tenant-scoped restaurant customer identity and loyalty contract without linking StayNas guest identities by phone/email or merging profiles. |
| Analytics | commercial usage, restaurant events, analytical foundations | Extend existing event/analytics architecture with WhatsApp attribution and tenant/property filters. |

## 4. Live schema and security findings

### 4.1 Confirmed reusable schema

Live catalog inspection confirmed:
- `api_integrations` has `tenant_id`, optional `property_id`, `provider`, `integration_type`, `channel_key`, JSON config and encrypted secret fields.
- `api_webhook_endpoints` and `api_webhook_deliveries` are tenant/property-aware, with uniqueness on endpoint/event and retry metadata.
- `api_channel_definitions` is platform-managed; the authenticated read policy exposes enabled definitions only.
- Order, order-item and payment tables contain tenant ownership, property resolution and idempotency fields.
- Commercial entitlements, quotas, counters and AI usage records already exist.
- `restaurant_mobile_money_provider_connections` already has encrypted credential fields and tenant scope.

### 4.2 Security finding — existing guest records are not suitable for WhatsApp CRM

The live `guests` and `guest_preferences` tables have no tenant_id/property_id columns. Their current authenticated policies check only that `auth.uid()` is non-null. They do not provide tenant isolation.

**Disposition:** WCE must not use these tables as the WhatsApp customer master or expose them through the WhatsApp inbox. Do not automatically match or merge WhatsApp numbers with StayNas/PMS guest records. WCE-05 must create or establish a canonical restaurant customer domain with tenant ownership, optional property attribution, strict RLS, normalized identity and explicit consent. This is a new restaurant customer capability, not a duplicate of StayNas guest profiles.

### 4.3 RLS and privileged execution

- All 217 public tables have RLS enabled, but FORCE RLS is not enabled. Service-role code bypasses RLS and must therefore enforce tenant/property scope in server-side authorization and repository functions.
- The inspected commercial-admin check uses the dedicated `commercial_administrators` allow-list and `restaurant_is_commercial_admin`; this is the correct founder-only governance boundary.
- Existing `api_integrations` and webhook endpoint policies allow tenant owners/general managers to manage their own scoped configuration. They must not grant access to Meta platform app secrets or global onboarding settings.
- Several existing security-definer helpers are callable by authenticated users with a fixed `search_path=public`; WCE migrations must not broaden their grants or introduce public-executable security-definer functions. Review every new function's owner, search path, EXECUTE grants and authorization checks.
- WCE-specific inbox, messages, customer consent, campaigns and usage data must have tenant and property scope where applicable, explicit RLS policies, indexes and server-side scope checks. Never trust tenant/property IDs from a WhatsApp message payload.

### 4.4 Live Supabase Security Advisor baseline

The live Supabase security advisor was also run read-only on 2026-11-16. It reported:
- 23 public tables with RLS enabled but no policies. The listed tables are predominantly internal idempotency, invitation, migration-audit, credential handoff, integration inbox/outbox, delivery-attempt and reconciliation stores. No-policy RLS is deny-by-default for normal API roles; each table's grants and intended service-role-only access still require verification before it is reused.
- 2 anonymous-executable SECURITY DEFINER functions: `lb01_revoke_connection_credentials()` and `lb02_publish_approved_outlet()`. Both are trigger functions with fixed `search_path=public`, but their EXECUTE grants to anon/authenticated are unnecessary and should be removed in a separate security-hardening change after confirming trigger execution remains intact.
- 70 authenticated-executable SECURITY DEFINER functions. This count is not itself proof of a vulnerability; each exposed RPC requires review of caller identity, tenant/property checks, argument trust and grants. WCE must not add a SECURITY DEFINER RPC without explicit authorization tests.
- 1 mutable-search-path warning for `configure_mobile_money_tenant_provider(...)`. It is SECURITY INVOKER and uses schema-qualified table names, but its search path/grants need hardening review before WCE-04 relies on it directly.
- Supabase Auth leaked-password protection is disabled. This is an inherited account/project security setting and was not changed during read-only reconnaissance.

The database catalog query found 115 SECURITY DEFINER functions; all had a function-level search_path setting, but Supabase's advisor identified the separate mutable-search-path case above. Do not interpret RLS-enabled/no-policy tables or SECURITY DEFINER counts in isolation as exploit evidence; validate grants, caller context and function bodies.

### 4.5 Migration provenance reconciliation

The live ledger has 171 records while the current repository has 156 migration files. This is explained in part by:
- the original `0001_fnb_core.sql` being applied in five ledger parts;
- migration transfers and schema-parity repair records;
- subsequent migration renames and split/consolidated implementations;
- production ledger names that differ from current source filenames (for example, cost-reconciliation and operational-consumables/profitability migrations).

The current live schema contains the expected recent operational-consumables and profitability tables, and the latest production ledger records those phases. However, the 171-to-156 mapping is not yet a complete checksum/provenance reconciliation. A filename-count comparison alone is not evidence of schema drift or parity.

**Gate:** Before WCE-02 creates or applies any migration, produce an explicit ledger-to-source mapping for every non-exact migration name, identify genuinely production-only SQL, compare the affected live schema objects with source, and prove a clean-database replay using the repository's established migration verification path. No production schema writes are authorized by WCE-00.

## 5. Meta platform requirements and external dependencies

The implementation target is the native Meta WhatsApp Business Platform Cloud API.

- Embedded Signup v4 uses a Facebook Login for Business configuration and the phone-number-first flow.
- Cloud API onboarding requires the WhatsApp Business Account and messaging assets, with Advanced Access for `whatsapp_business_management` and `whatsapp_business_messaging`.
- Meta's current developer reference surfaced Graph API v27.0 at inspection time. API version must be centralized/configurable and upgraded deliberately, not scattered in source.
- Webhook verification must implement Meta's GET challenge handshake and POST request signature validation against the raw request body using the app secret. Signature validation must occur before parsing/processing the event.
- Tokens returned by onboarding must be exchanged/validated server-side and encrypted at rest. Browser code may receive only safe onboarding status and public app/config identifiers.
- Meta app creation, business verification, App Review/Advanced Access, Embedded Signup configuration ID, app secret, system-user/token setup and a verified WABA/phone number are external dependencies. No credentials or approval evidence were available in repository or connected project inspection. Do not simulate a successful Meta handshake or send.

Official references:
- [WhatsApp Business Platform overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview/)
- [Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4)
- [Meta Webhooks getting started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/)
- [WhatsApp Business Management API](https://developers.facebook.com/docs/whatsapp/business-management-api/guides)

## 6. WCE target architecture

```
Customer WhatsApp
   -> Meta Cloud API
   -> HTTPS webhook gateway
   -> raw-body signature verification
   -> durable wa_webhook_events inbox (idempotent)
   -> verified phone-number -> tenant/property resolver
   -> conversation state + message orchestration
   -> approved intent/operation router
      -> menu/catalogue + pricing quote
      -> existing guest order / POS service
      -> existing Pesapal/payment core
      -> validated reservation service
      -> CRM / loyalty / consent
      -> AI Concierge (authorized tools only)
   -> Meta Cloud API sender
   -> message status events + usage ledger + analytics
```

### 6.1 Provider and credential model

- Provider adapter key: `meta-whatsapp`; customer-facing channel key: `whatsapp`.
- Reuse `api_integrations` for encrypted tenant/property Meta credentials and integration lifecycle where its existing constraints fit.
- Add `wa_business_accounts` and `wa_phone_numbers` for WABA/phone-number ownership, verified Meta identifiers, property mapping, onboarding state and health.
- Add `messaging` to the channel-category contract and DB constraint through a separately verified migration.
- Keep the Meta app ID, app secret, Embedded Signup configuration and platform-wide webhook verification secret in founder-governed server configuration/secret storage. Tenant WABA tokens remain separately scoped and encrypted.
- Do not create a duplicate `wa_credentials` or `wa_subscriptions` table unless a later implementation proves the existing integration vault or commercial subscription contract cannot satisfy the requirement.

### 6.2 Durable event and conversation model

New WhatsApp-specific entities are expected for:
- `wa_webhook_events` — inbound inbox, provider event ID uniqueness, raw-body hash, verified status, claim/lease, retry schedule, processing outcome and dead-letter state;
- `wa_conversations` and `wa_messages` — tenant/property and verified phone-number scope, provider IDs, direction, delivery state and retention controls;
- `wa_templates` — provider template identity, locale, category, approval/rejection and version state;
- `wa_customer_consents` — channel, purpose, source, timestamp, policy version and opt-out state;
- `wa_campaigns` — tenant/property-scoped campaigns with approval, audience, scheduling and suppression controls;
- `wa_usage_ledger` — immutable per-message provider usage/cost facts, with market, category, pricing-rule version, provider message ID and idempotency;
- `wa_audit_logs` — security and administrative changes where existing audit contracts are insufficient.

The existing commercial usage counters remain the entitlement/quota aggregate; the immutable WhatsApp usage ledger is the evidence source for message-level cost attribution. Meta charges, LexiBite subscription charges and AI processing costs remain distinct.

### 6.3 Trust, ordering and payment invariants

- Tenant/property resolution comes only from the verified receiving phone-number registry, never from sender content or client-supplied IDs.
- Verify HMAC signature over exact raw bytes before accepting a webhook event.
- Acknowledge only after durable inbox persistence; process asynchronously with idempotent claims, bounded retries, dead-letter recovery and replay tooling.
- Provider message IDs and webhook event IDs are unique. Replays and out-of-order delivery must not duplicate customer messages, orders or payments.
- The WhatsApp adapter may prepare a cart, but final product availability, modifiers, price, tax, charges, currency and order validity are re-derived by LexiBite services at confirmation.
- Order creation uses the existing order idempotency key and canonical POS event flow.
- A payment message, receipt image or customer screenshot is never proof of payment. Only server-side Pesapal/provider verification can transition the authoritative payment state.
- Reservation availability and confirmation must be validated by the authoritative reservation service.
- AI may invoke only allowlisted domain operations with authorization, entitlement and confirmation checks.

## 7. Updated architecture — WhatsApp initiation, Guest Portal completion

The primary journey is:

`WhatsApp inbound → verified Meta webhook → receiving-number tenant/property/outlet resolution → customer identity/consent resolution → short-lived server-side Guest Portal session → branded portal deep link → live menu → cart → server-validated checkout → verified payment → one authoritative LexiBite order → POS/kitchen → fulfilment notifications → CRM and analytics attribution`.

The Guest Portal is not a second commerce engine. Its existing table-scoped route `/order/$tableId` and self-order services are reusable for the catalogue, modifiers, server-side order creation, Pesapal payment verification and POS lifecycle. However, the current public experience is QR/table-bound: `/order/` explicitly instructs guests to scan a table QR code. It does not yet provide a general WhatsApp/property/outlet session entry point. Its `restaurant_guest_sessions` are table-bound dining sessions and must not be repurposed as WhatsApp handoff sessions.

Required separation:
- **WhatsApp channel:** Meta webhook, customer conversation, verified sender, consent, acquisition and status notifications.
- **Guest Portal handoff session:** short-lived, revocable, high-entropy server-side session bound to verified receiving-number mapping, tenant, property, outlet, menu context and acquisition attribution. URL token is a scoped entry capability, not unrestricted login.
- **Guest Commerce:** existing catalogue/pricing/order services remain authoritative; cart can be portal-local until checkout, where all values are recalculated.
- **CRM:** separate tenant-scoped restaurant customer identity and consent domain; do not use the currently unscoped `guests` / `guest_preferences` tables as a cross-channel CRM.
- **Payments:** existing provider settlement and server-side verification; tenant/property configuration must be resolved server-side before initiation.
- **Attribution:** persist source/channel/campaign/session context through order and payment records without trusting client-supplied tenant identifiers.

## 8. Updated phase dependency map

| Phase | Main dependency / exit gate |
|---|---|
| WCE-00 | Actual repository baseline, portal-first architecture, capability/security matrix, migration provenance plan and external dependency register verified. |
| WCE-01 | Meta Cloud API client and Embedded Signup v4 browser contracts; token lifecycle/error handling and mocked contract CI. Live onboarding additionally requires Meta app, verified business, configuration, Advanced Access and test WABA/phone. |
| Migration gate | Reconcile all 171 live ledger records against the current 157 SQL files, resolve duplicate numeric prefixes and historical split/rename/consolidation provenance, then prove isolated clean replay. No WCE DDL before this gate. |
| WCE-02 | Tenant/property/outlet resolution, encrypted credential-vault integration, durable Meta webhook inbox, idempotency/retry/dead-letter and secure non-table-bound Guest Portal sessions. |
| WCE-03 | WhatsApp-to-Guest-Portal handoff, deep-link/session continuity, branded mobile entry, attribution and failure fallback. |
| WCE-04 | Unified Guest Commerce using existing menu, modifier, price/tax, inventory, cart/checkout, order and POS contracts; no parallel order engine. |
| WCE-05 | Order lifecycle attribution, tenant-isolated restaurant CRM/consent, AI concierge with allowlisted domain operations and human handover. |
| WCE-06 | Tenant/property Pesapal configuration, authoritative payment verification, restaurant table reservations only if no existing domain is found, and fulfilment integration. |
| WCE-07 | Existing subscription/entitlement/quota governance, Meta usage/cost ledger, templates/consent/campaign controls and founder/tenant analytics boundaries. |
| WCE-08 | Cross-tenant and cross-property integrated E2E, clean migration replay, RLS, payment/order idempotency, Meta contracts and UAT certification. |

## 9. WCE-00 exit assessment

**Architecture path:** Updated to WhatsApp initiation and Guest Portal completion; baseline closure still pending verification of migration provenance and current branch/CI state.  
**Reusable domain services:** Identified.  
**Live project and schema:** Identified and read-only inspected.  
**WhatsApp-specific schema:** Absent.  
**Native Meta credentials/approvals:** Not available; external dependency.  
**Known implementation risks:** Guest CRM RLS is not tenant-safe; Pesapal currently uses global environment credentials; no restaurant reservation service was located; channel category needs a messaging type.  
**Migration provenance:** Not closed. The live ledger has 171 records and current `main` has 157 SQL files; 14-record count difference is not proof of missing migrations. Exact record-to-file lineage, including duplicate prefixes and historical source-only/live-only records, remains a blocking gate before WCE-02 DDL.

### Required next actions

1. Preserve this report as the WCE-00 baseline.
2. Complete migration provenance reconciliation before any WCE schema migration.
3. Begin WCE-01 provider foundation independently of Meta approval, with no false live-success claims.
4. Do not deploy or promote production.
5. Continue through WCE-08 only with evidence-backed phase closure and no unresolved P0/P1 defects.
