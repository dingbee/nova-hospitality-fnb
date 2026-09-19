-- ME-06: restaurant_payment_refund_integrity (reconstructed verbatim from
-- production in migration 0081) excludes only the row being inserted
-- itself from its "already refunded" sum:
--
--   SELECT COALESCE(SUM(abs(amount)),0) INTO already
--     FROM restaurant_payments
--     WHERE tenant_id=NEW.tenant_id AND refund_of=NEW.refund_of AND id<>NEW.id;
--
-- id is gen_random_uuid()-generated fresh on every INSERT, so a genuine
-- idempotent RETRY of a refund request (same client_request_id, after a
-- client timeout or double-submit — the exact scenario
-- refundPayment/bill.server.ts is built to resolve via insert-then-
-- recover-on-23505, matching ME-03/ME-04's established pattern) is never
-- excluded: the retry's row has a different id than the first successful
-- attempt, so the trigger counts the first attempt's amount in "already"
-- and adds the retry's own amount on top of it. For any refund that
-- consumes the full remaining balance — the common case — this makes the
-- retry appear to exceed the original payment, and the trigger rejects it
-- with "Refund exceeds original payment." This is a BEFORE INSERT trigger,
-- so it fires and raises before Postgres ever reaches the unique-index
-- check on (tenant_id, client_request_id) that refundPayment's
-- insert-then-recover depends on to detect a duplicate gracefully — the
-- retry never gets a chance to resolve idempotently; it fails outright.
--
-- Reproduced against a local Postgres 16 replica running this exact
-- reconstructed trigger (migration 0081): a 40.00 payment refunded in
-- full (client_request_id 'r1'), then the identical request repeated
-- (same client_request_id, same amount) — the retry was rejected with
-- "Refund exceeds original payment." instead of resolving to the existing
-- refund row. This is a genuine, currently-live production defect,
-- independent of anything ME-01 through ME-04 already covered.
--
-- Fix: also exclude any existing refund row that shares this insert's own
-- client_request_id (when set) from the "already refunded" sum — it is
-- this refund being retried, not an additional one. The row lock on the
-- original payment (unchanged) still closes the genuine-concurrency case:
-- two distinct, simultaneous refund attempts against the same payment
-- still serialize on it and are correctly judged against each other's
-- real prior amounts. The unique index on (tenant_id, client_request_id)
-- still catches the actual duplicate row afterward, exactly as designed.

CREATE OR REPLACE FUNCTION public.restaurant_payment_refund_integrity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  orig record;
  already numeric;
BEGIN
  IF NEW.refund_of IS NULL THEN
    IF NEW.amount<0 THEN
      RAISE EXCEPTION 'A negative payment must reference the payment it reverses.' USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id=NEW.refund_of THEN
    RAISE EXCEPTION 'A payment cannot reverse itself.' USING ERRCODE='check_violation';
  END IF;

  SELECT * INTO orig FROM public.restaurant_payments WHERE id=NEW.refund_of AND tenant_id=NEW.tenant_id FOR UPDATE;
  IF orig IS NULL THEN
    RAISE EXCEPTION 'The payment being refunded does not exist on this tenant.' USING ERRCODE='check_violation';
  END IF;
  IF orig.refund_of IS NOT NULL THEN
    RAISE EXCEPTION 'A refund cannot itself be refunded.' USING ERRCODE='check_violation';
  END IF;
  IF orig.order_id<>NEW.order_id THEN
    RAISE EXCEPTION 'That payment belongs to a different bill.' USING ERRCODE='check_violation';
  END IF;
  IF NEW.amount>=0 THEN
    RAISE EXCEPTION 'A refund must be recorded as a negative amount.' USING ERRCODE='check_violation';
  END IF;

  -- ME-06: a retry of this exact idempotent request already exists as its
  -- own committed row (same client_request_id) — it is this refund, not
  -- an additional one. Excluding it here lets the retry pass through to
  -- the (tenant_id, client_request_id) unique index, which is what
  -- actually resolves the retry idempotently.
  SELECT COALESCE(SUM(abs(amount)),0) INTO already
    FROM public.restaurant_payments
    WHERE tenant_id=NEW.tenant_id
      AND refund_of=NEW.refund_of
      AND id<>NEW.id
      AND (NEW.client_request_id IS NULL OR client_request_id IS DISTINCT FROM NEW.client_request_id);

  IF already+abs(NEW.amount)>abs(orig.amount)+0.005 THEN
    RAISE EXCEPTION 'Refund exceeds original payment.' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
