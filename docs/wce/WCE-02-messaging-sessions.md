# WCE-02 — Messaging and Guest Portal Session Infrastructure

**Status:** IMPLEMENTED — verification pending combined CI  
**Migration:** `0138_wce02_messaging_sessions.sql`  
**Branch:** `wce/wce-02-messaging-sessions`  
**PR:** #195

## Architecture

WhatsApp is a messaging/acquisition channel, not a second commerce engine. The provider is registered in the existing universal channel catalogue as `messaging`; the generic channel form deliberately hides Meta and generic create/update operations reject it. Connection and reauthorization must use the Meta Embedded Signup server flow. Connection health uses the encrypted `api_integrations` credential vault.

One WABA is supported per property at this stage, with multiple Meta-verified phone assets retained in that integration's encrypted configuration. Each phone number is bound to one active customer-facing outlet through `wa_phone_number_bindings`. Tenant, property, outlet, integration, WABA and phone asset consistency is enforced by foreign keys and a database trigger.

## Durable inbound event flow

1. Meta GET challenge is checked against `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
2. POST verifies `X-Hub-Signature-256` against the exact raw body using HMAC-SHA256 and `META_APP_SECRET`.
3. The handler resolves the receiving `phone_number_id` against an active verified binding. It never accepts tenant/property IDs from the webhook payload.
4. Valid events are persisted to `wa_webhook_events` before HTTP 200. Unknown, disabled or mismatched numbers are quarantined as rejected events without tenant context.
5. Event identity is unique per receiving number and payload/change hash. Provider message IDs are separately unique in `wa_messages`.
6. The one-minute Supabase cron dispatcher claims events with leases and `FOR UPDATE SKIP LOCKED`. Claims are ordered per receiving number; an earlier retry/dead-letter blocks later events for that number.
7. Failures use bounded exponential retry. Exhausted events enter dead-letter; authorized tenant/property operators may requeue them, with commercial audit evidence.
8. Inbound messages create/reuse scoped conversations. Delivery status updates are monotonic (sent → delivered → read); an early status with no corresponding outbound message is retried.

## Session security

`wa_guest_portal_sessions` stores only a SHA-256 token hash. The raw 256-bit random token is returned once to the server caller and placed in the Guest Portal URL; tenant/property/customer IDs are not URL parameters.

- 30-minute expiry.
- Browse-menu scope only.
- Maximum 20 successful resolutions per token.
- Atomic service-only resolve RPC checks expiry, revocation, binding, integration and outlet active state.
- Server-side revocation; issuing a new session revokes prior active sessions for that conversation.
- Checkout and order-tracking authorization are intentionally separate and belong to WCE-04/WCE-05.

The Guest Portal base URL is read from `LEXIBITE_GUEST_PORTAL_BASE_URL`; production requires HTTPS. There is no guessed fallback URL.

## Database and authorization

| Table | Access |
|---|---|
| `wa_phone_number_bindings` | Tenant/property-scoped authenticated read/write via existing role helpers |
| `wa_conversations` | Tenant/property-scoped authenticated read; server-side writes |
| `wa_messages` | Tenant/property-scoped authenticated read; server-side writes |
| `wa_webhook_events` | RLS enabled, no authenticated policies; service role only |
| `wa_guest_portal_sessions` | RLS enabled, no authenticated policies; service role only |

All five new public tables have RLS enabled. Service-only RPCs claim inbox events, apply monotonic message delivery status, resolve browse sessions and revoke sessions. The database prevents cross-tenant/property/outlet foreign-key combinations.

The current restaurant RBAC model exposes tenant/property scopes, not a separate outlet-membership grant. Outlet identity is nevertheless persisted and enforced for routing and session context; outlet-specific staff visibility remains a separate RBAC enhancement if required.

## Runtime configuration

- `META_APP_ID`, `META_APP_SECRET`
- `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `LEXIBITE_GUEST_PORTAL_BASE_URL` (HTTPS in production)
- Existing `CRON_SECRET` matching the Supabase Vault secret `lexibite_cron_secret`

The migration registers `lexibite-wa-webhook-dispatch` every minute using the existing Vault secret and the current LexiBite API origin. Local replay records the schedule inactive and performs no HTTP request.

## Acceptance evidence required

- Combined PR #195 CI: clean PostgreSQL 17 replay including migration 0138, 222-table RLS assertion, service-only function grants, channel catalogue and cron assertions, WCE tests, typecheck, lint, production build and full repository tests.
- No live Meta request is claimed. Live onboarding still requires Meta Business verification, Embedded Signup configuration, Advanced Access/App Review and a real test WABA/phone.
- No production migration, production database write, credential change, deployment or promotion has been performed.
