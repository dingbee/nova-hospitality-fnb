-- Guest self-order payment initiation — concurrency claim.
--
-- Root cause: selfpay.server.ts's initiateGuestPayment derived the payable
-- amount fresh from restaurant_orders and never wrote anything to claim
-- that it was doing so. Two concurrent initiation requests for the same
-- order (a double-tapped "Pay" button, two open browser tabs, a client
-- retry) each independently called the Pesapal adapter's initiate(), each
-- creating its own real hosted-checkout session with its own
-- order_tracking_id. confirmGuestPayment/recordGuestPayment's existing
-- idempotency dedupes a repeated confirmation of the *same* provider
-- reference (via restaurant_payments' (tenant_id, client_request_id)
-- unique index) — but two independently-created Pesapal sessions carry two
-- different order_tracking_ids, so that guarantee never applied across
-- them. If a guest completed (or was charged through) both sessions,
-- nothing stopped both from being recorded, overpaying the order.
--
-- Fix: three nullable columns on restaurant_orders let initiateGuestPayment
-- claim "I am the one calling Pesapal for this order right now" with a
-- single conditional UPDATE (a compare-and-swap on the order row, not a
-- second table or a second idempotency mechanism) before ever calling the
-- provider. A concurrent caller that loses the claim is hetween either the
-- winner's already-recorded live session's own redirect handed back (so a
-- duplicate tap lands the guest on the exact same checkout page, never a
-- second one)
-- or, in the rare sub-second window where the winner is still mid-flight to
-- Pesapal, told to retry shortly. See selfpay.server.ts's
-- initiateGuestPayment for the full claim/release logic.
--
-- This client is always the service-role client (guests carry no
-- restaurant_members row — see selfpay.functions.ts), so no RLS policy
-- change is required; the existing restaurant_orders grants already cover
-- service_role.

alter table public.restaurant_orders
  add column if not exists guest_payment_session_reference text,
  add column if not exists guest_payment_session_redirect_url text,
  add column if not exists guest_payment_session_expires_at timestamptz;
