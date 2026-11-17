# RELEASE-08 — Guest Payment Concurrency Certification

## Scope
Close the guest self-order payment initiation concurrency race identified in the market-entry release protocol.

## Defect
Before the fix, two concurrent `initiateGuestPayment` requests for the same order could both reach the payment provider and create independent hosted-checkout sessions. Existing payment idempotency only protected repeated confirmation of the same provider reference; it did not prevent two different provider sessions for one order.

## Implemented control
The production path now uses three fields on `public.restaurant_orders` as a single compare-and-swap claim:

- `guest_payment_session_reference`
- `guest_payment_session_redirect_url`
- `guest_payment_session_expires_at`

Each initiation receives a unique claim token. A caller must acquire the live claim before calling the provider. Losing callers reuse an already-live checkout session or receive `initiation_in_progress`.

Ownership-qualified finalize/release writes prevent a late provider response from overwriting or clearing a newer caller's session.

The provider call itself is bounded by the same 30-second claim deadline through `AbortController`, preventing an expired caller from continuing an independent live provider request after another caller has acquired the claim.

## Evidence

- Upstream implementation merged in PR #35.
- Eight concurrency regressions were reported passing on the exact post-rebase branch, including genuine overlapping initiation calls and provider-abort TTL tests.
- Production build was reported green on the implementation branch.
- Migration `0085_selfpay_guest_payment_session_claim.sql` is present in the canonical repository.
- The live Supabase database now contains all three required columns.
- Live migration ledger contains `0085_selfpay_guest_payment_session_claim`.
- No guest payment session rows existed in the live database at certification time, so no live customer payment state required migration.

## Certification boundary

This certification closes the identified guest-payment initiation concurrency defect. It does not certify the external Pesapal account/configuration, live provider settlement, or the complete payment subsystem.

## Status

**RELEASE-08 — CERTIFIED**

Next gate: RELEASE-09 operational Import Studio / Kilimanjaro Grill dataset certification.
