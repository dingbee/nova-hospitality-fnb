# WCE-01 — Native Meta Cloud API Foundation

**Status:** VERIFIED — software foundation and mocked contract suite pass; live Meta onboarding remains externally gated  
**Implementation branch:** `wce/wce-01-meta-platform`  
**Verified commit:** `791909404e3483e47be3fb5ed03f9878121026c7`  
**CI run:** `43954209682` — TypeScript, changed-source lint, production build, scoped tests and full repository test suite all PASS.

## Implemented

### Meta Cloud API client

`src/modules/messaging/providers/meta-cloud-api.server.ts` provides:
- Central Graph API version configuration (default `v27.0`) with strict format validation.
- Server-side Embedded Signup authorization-code exchange.
- `debug_token` inspection, app-ID matching and required WhatsApp scope validation.
- WABA detail retrieval and phone-number listing.
- Six-digit phone-number registration and WABA application subscription.
- Phone-number health inspection and outbound text messaging.
- GET webhook challenge verification.
- POST webhook signature verification over the exact raw request body using HMAC-SHA256 and constant-time comparison.
- Bounded request timeouts and sanitized network errors.
- Structured error metadata: HTTP status, Graph code/subcode, `fbtrace_id`, retryability and numeric `Retry-After` guidance.
- No blind automatic retry of message POSTs; callers must apply operation-specific idempotency before retrying mutations.

### Embedded Signup v4 browser contract

- `src/modules/messaging/embedded-signup.client.ts` loads and initializes the Facebook SDK only in the browser, launches Login for Business using the configured `config_id`, and handles authorization-code response.
- `src/modules/messaging/embedded-signup.contracts.ts` owns the pure message contract and validates Meta-origin FINISH/CANCEL/ERROR events. It is separated from the browser module so it can be tested without crossing the repository's client/server import-protection boundary.
- Authorization code and FINISH WABA/phone identifiers are delivered separately. The browser does not store access tokens or app secrets.

### Server-side onboarding and credential lifecycle

`src/modules/messaging/providers/meta-onboarding.server.ts` completes the server half of Embedded Signup:
1. Validates input and authenticated operator tenant/property authority using the existing `tenant.manage` capability.
2. Enforces the existing `advanced_integrations` commercial entitlement.
3. Exchanges the authorization code and inspects the returned token.
4. Enforces app ID, token validity, expiry window and required WhatsApp scopes.
5. Re-fetches WABA and phone assets from Meta and verifies the selected phone belongs to the selected WABA.
6. Registers the phone number and subscribes the WABA to the app.
7. Persists the tenant/property integration through existing `registerIntegration` / `updateIntegration` functions. Access tokens are encrypted by the existing `api_integrations` vault path and commercial audit is written by that existing service.
8. Stores expiry, scopes, WABA/phone identity, Graph version and safe phone metadata in integration config. Re-running onboarding updates the existing tenant/property integration and rotates its encrypted token rather than creating a duplicate.

The server function returns only safe connection metadata. It never returns the access token. The six-digit phone registration PIN is not persisted. The browser cannot choose another tenant's identity without passing the server-side authorization checks.

## Test coverage

- `src/modules/messaging/providers/meta-cloud-api.server.test.ts`
- `src/modules/messaging/embedded-signup.test.ts`
- `src/modules/messaging/providers/meta-onboarding.server.test.ts`

Coverage includes Graph version validation, authorization-code exchange, token inspection and scopes, WABA/phone operations, phone registration, WABA subscription, outbound message validation, provider error classification, 429 retry metadata, webhook challenge/signature validation, Meta-origin message parsing, malformed/cancelled signup events, tenant/property authorization, WABA/phone mismatch rejection, encrypted integration-vault handoff, and existing-connection token rotation.

The latest CI run passed:
- Strict TypeScript typecheck.
- Changed-source ESLint.
- Production build.
- Scoped WCE functional tests.
- Full repository test suite.
- Existing database integration/regression jobs in the same CI workflow.

## External dependencies — not fabricated

The following are required for live Meta onboarding and are not software implementation blockers:
- Meta developer app ID and app secret configured in server environment.
- Meta Business verification and approved WABA.
- Embedded Signup v4 configuration ID.
- Required WhatsApp permissions and Advanced Access/App Review.
- A real Meta test WABA and phone number, including the business-controlled registration PIN.
- Verified callback/webhook URL and Meta webhook subscription.
- Live send/delivery-status test and token-expiry/reauthorization exercise.

No live Meta API response or successful external onboarding is claimed. The platform has not supplied those credentials/approvals in this execution context.

## Boundary with subsequent phases

WCE-01 supplies the provider client, browser onboarding contract and secure server-side connection bootstrap. The public webhook HTTP route, durable event inbox, verified receiving-number tenant/property/outlet resolver, delivery-state processor, session continuity and automated operational health/revocation monitoring are WCE-02 work. Those capabilities must be implemented before any live customer traffic.

**Closure decision:** WCE-01 software foundation is VERIFIED and CLOSED against its implementable acceptance gate. Live Meta certification remains an external acceptance item for WCE-08. No production database writes, migrations, deployments or live Meta calls occurred.
