# WCE-03 — WhatsApp-to-Guest-Portal Handoff

**Status:** CLOSED — software acceptance verified; live Meta delivery remains external  
**Migration:** `0139_wce03_whatsapp_portal_handoff.sql`  
**Branch:** `wce/wce-03-portal-handoff`  
**PR:** #196 (draft; stacked on WCE-02 PR #195)  
**Acceptance commit:** `80c4ce0c8a91d41dea081341322312b3c1475cec`

## Scope and architecture

WhatsApp is the acquisition, conversation and notification channel. The Guest Portal is the visual menu-entry surface. This phase does not create a second catalogue, checkout, order, payment, reservation, CRM or fulfilment engine.

The handoff reuses the existing LexiBite tenant/property/outlet bindings, encrypted `api_integrations` credential vault, sellable-catalogue service, commercial audit service and Meta Cloud API client.

## Inbound-to-portal flow

1. The verified, durably persisted Meta webhook event is claimed by the WCE-02 inbox worker.
2. An inbound WhatsApp message creates or reuses the conversation scoped to its verified receiving-number binding.
3. The worker invokes the WCE-03 handoff orchestrator with the event, conversation and provider sender number. Tenant, property, outlet and binding scope are carried from the verified server-side event; customer payloads cannot choose scope.
4. The orchestrator suppresses a second active handoff and uses the webhook event/conversation idempotency key to prevent duplicate jobs.
5. A short-lived browse-only Guest Portal session is created. Its token is random, stored only as a SHA-256 hash, and scoped to the active tenant/property/outlet binding.
6. The URL and welcome message are encrypted before they enter `wa_outbound_jobs`. The raw URL/token is not stored as plaintext in the queue or outbound message record.
7. The dispatcher sends the text through the existing Meta Cloud API client. A successful provider message ID is recorded and linked to the outbox job.
8. The Guest Portal validates the token server-side, rechecks active tenant/property/outlet/binding and currency, then returns a public-safe projection from the existing sellable-catalogue service. It is browse-only in WCE-03.

If session creation fails, the orchestrator queues a safe fallback message rather than creating an untracked portal capability.

## Outbound reliability and controls

- Encrypted outbox with tenant/property/outlet foreign-key scope, event/conversation idempotency, and a service-role-only claim RPC.
- Worker claims use leases and bounded attempts.
- Free-form messages are rejected outside Meta's 24-hour customer-service window.
- Known retryable Meta rate-limit responses use bounded backoff.
- Network timeouts, server errors and ambiguous provider outcomes are marked `uncertain`; they are never automatically retried because doing so could duplicate a customer message.
- Operator requeue requires explicit confirmation that Meta did not deliver the prior attempt, tenant/property authorization and commercial audit evidence.
- Sent message content redacts Guest Portal URLs; provider IDs and delivery status remain linked to the authoritative message record.
- Session and outbound queue tables have RLS enabled and no authenticated policies; access is through scoped server operations/service-only RPCs.

## Guest Portal security and UX

- Session scope: `menu_browse` only; no cart, checkout, payment or order-tracking authorization is granted.
- 30-minute session expiry and 20 successful resolution limit inherited from WCE-02.
- Tenant/property/outlet identifiers are not exposed as URL parameters.
- Portal response is `no-store`, `private`, `noindex` and `no-referrer`; external product images suppress referrer information.
- Menu prices are served in the session's property currency. A stale or mismatched currency context fails closed; there is no USD fallback.
- Only active customer-facing outlets and currently sellable, configured-price catalogue items are exposed.

## Acceptance evidence

**CI:** [GitHub Actions run 44015515830](https://github.com/dingbee/nova-hospitality-fnb/actions/runs/44015515830)  
**Commit:** `80c4ce0c8a91d41dea081341322312b3c1475cec` — SUCCESS.

- PostgreSQL 17 clean migration replay: 164 applied migrations; one UAT-only policy/data repair skipped by the isolated replay harness.
- Public schema RLS: 223/223 tables enabled.
- WCE-03 migration and scoped service-only privilege assertions: PASS.
- Production build: PASS.
- Strict TypeScript typecheck: PASS.
- Changed-source lint step: PASS.
- Scoped integration suite: 155/155 tests across 23 files.
- Full repository suite: 2,641/2,641 tests across 247 files.
- Existing migration, LB-02/LB-03, operational-cost and profitability regression gates: PASS.
- Guest Portal authorization-gate allowlist updated to recognize the token-scoped server function; full suite confirms the exception remains explicit.

## External/live acceptance

Software acceptance does not claim live Meta delivery. Live onboarding and delivery still require the Meta app/business verification, Embedded Signup configuration, Advanced Access/App Review, verified WABA/phone, runtime Meta secrets, HTTPS Guest Portal base URL and scheduled dispatcher configuration.

No production migration, production database write, credential change, deployment or promotion was performed. PR #195 and PR #196 remain unmerged. Production release remains unauthorized.
