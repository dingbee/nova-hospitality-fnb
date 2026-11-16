# WCE-01 — Meta Platform Foundation (implementation checkpoint)

**Status:** Server-side foundation implemented; phase not closed  
**Base:** WCE-00 reconnaissance commit `8f8701abc37e1d1baf429df0b83045c1acb4d8e7`  
**Implementation branch:** `wce/wce-01-meta-platform`

## Implemented

New server-only module: `src/modules/messaging/providers/meta-cloud-api.server.ts`.

New browser-only Embedded Signup v4 module: `src/modules/messaging/embedded-signup.client.ts`. It loads the Facebook SDK only on the onboarding page, initializes the configured app/version, launches Facebook Login for Business with `config_id` and authorization-code response mode, and validates Meta-origin `WA_EMBEDDED_SIGNUP` FINISH/CANCEL/ERROR events. The authorization code and WABA/phone identifiers are delivered separately to the caller; the module does not persist or log them.

It provides:
- Central Graph API version selection, defaulting to `v27.0` and rejecting malformed versions.
- Server-side Embedded Signup authorization-code exchange.
- Meta `debug_token` inspection and enforcement of `whatsapp_business_management` and `whatsapp_business_messaging` scopes.
- WABA detail lookup and phone-number listing.
- Phone-number registration with strict six-digit PIN validation.
- WABA app webhook subscription.
- Phone-number health lookup.
- Text-message transmission using the tenant phone-number ID and bearer token.
- GET webhook challenge verification using constant-time comparison.
- POST webhook signature verification over exact raw request bytes using HMAC-SHA256 and constant-time comparison.
- Bounded request timeouts and sanitized network failures.

Tests:
- `src/modules/messaging/providers/meta-cloud-api.server.test.ts`
- `src/modules/messaging/embedded-signup.client.test.ts`

Both test files are included in the mandatory scoped CI functional test command in `.github/workflows/ci.yml`.

## Security and lifecycle rules

- The module is server-only. Do not import it into browser bundles or expose app secrets/access tokens to the client.
- The app ID, app secret, Embedded Signup configuration ID and webhook verification token are platform-controlled server configuration. Tenant access tokens are separate credentials and must be loaded only by server-side integration services.
- The module does not persist credentials. WCE-02 must use the existing encrypted integration vault and ensure tenant/property scope before supplying credentials to this module.
- Token inspection reports validity, expiry and scopes. The implementation does not invent a refresh operation: if Meta does not provide a refresh grant for the issued token type, renewal is an explicit system-user token rotation or reauthorization workflow.
- The webhook helpers are pure validation primitives. The public HTTP webhook route and durable inbox are WCE-02 work; no webhook is currently registered or publicly exposed by this change.
- A successful mock test is not evidence of a live Meta API call.

## Not yet complete

WCE-01 remains open pending:
1. Server-side onboarding callback that validates returned WABA/phone assets and binds them to an authorized tenant/property.
3. Meta app configuration and external Advanced Access/App Review/business verification.
4. Real test WABA and phone number for end-to-end onboarding, registration, webhook subscription, send and delivery-status validation.
5. Operational token rotation/revocation and integration-health state persistence.
6. CI results for the implementation branch.

No Meta credentials or business approval were available at reconnaissance time. No live Meta API calls have been attempted. No production database changes or deployments have occurred.
