-- ME-06: production/Git reconciliation (mandate section 26).
--
-- While reproducing a refund-overage scenario for ME-06's certification,
-- three fiscal-critical objects were found live in production
-- (`nova-hospitality-fnb`, lusiqcmxfxhnehxmwihs) with no corresponding
-- migration anywhere in Git history — the same class of gap ME-04's
-- DEFECT 5 found for restaurant_tender_declarations' columns, and for the
-- same underlying reason: these objects predate this repository's Git
-- history and were never captured when the rest of the schema was.
--
--   * restaurant_payment_refund_integrity — a BEFORE INSERT/UPDATE trigger
--     on restaurant_payments enforcing exactly the invariant mandate
--     section 3.4 requires ("Refunded value must never exceed refundable
--     value"): it locks the original payment row (FOR UPDATE), sums
--     refunds already recorded against it, and rejects an insert that
--     would push the cumulative total past the original payment's amount.
--     It also rejects a refund reversing itself, a refund of a refund, a
--     refund crossing bills, and a non-refund row carrying a negative
--     amount without a refund_of reference.
--   * restaurant_payments_period_lock — a BEFORE INSERT/UPDATE/DELETE
--     trigger on restaurant_payments rejecting a write once the business
--     day the payment's own created_at falls in is closed
--     (restaurant_day_is_locked, already canonical via 0076/0080).
--   * restaurant_order_items_period_lock — a BEFORE UPDATE trigger on
--     restaurant_order_items rejecting a line being voided once the
--     order's own opening business day is closed.
--
-- Recovered verbatim via pg_get_functiondef against production. This
-- migration only reconstructs them for Git reproducibility — it changes
-- no production behavior (all three already exist there identically).
-- ME-06's own genuine defect finding in the first of these three
-- (a retry-idempotency bug) is fixed separately in migration 0082, which
-- does change production behavior.

CREATE OR REPLACE FUNCTION public.restaurant_payment_refund_integrity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE orig record; already numeric; BEGIN IF NEW.refund_of IS NULL THEN IF NEW.amount<0 THEN RAISE EXCEPTION 'A negative payment must reference the payment it reverses.' USING ERRCODE='check_violation'; END IF; RETURN NEW; END IF; IF NEW.id=NEW.refund_of THEN RAISE EXCEPTION 'A payment cannot reverse itself.' USING ERRCODE='check_violation'; END IF; SELECT * INTO orig FROM public.restaurant_payments WHERE id=NEW.refund_of AND tenant_id=NEW.tenant_id FOR UPDATE; IF orig IS NULL THEN RAISE EXCEPTION 'The payment being refunded does not exist on this tenant.' USING ERRCODE='check_violation'; END IF; IF orig.refund_of IS NOT NULL THEN RAISE EXCEPTION 'A refund cannot itself be refunded.' USING ERRCODE='check_violation'; END IF; IF orig.order_id<>NEW.order_id THEN RAISE EXCEPTION 'That payment belongs to a different bill.' USING ERRCODE='check_violation'; END IF; IF NEW.amount>=0 THEN RAISE EXCEPTION 'A refund must be recorded as a negative amount.' USING ERRCODE='check_violation'; END IF; SELECT COALESCE(SUM(abs(amount)),0) INTO already FROM public.restaurant_payments WHERE tenant_id=NEW.tenant_id AND refund_of=NEW.refund_of AND id<>NEW.id; IF already+abs(NEW.amount)>abs(orig.amount)+0.005 THEN RAISE EXCEPTION 'Refund exceeds original payment.' USING ERRCODE='check_violation'; END IF; RETURN NEW; END; $function$;

DROP TRIGGER IF EXISTS restaurant_payment_refund_integrity ON public.restaurant_payments;
CREATE TRIGGER restaurant_payment_refund_integrity
  BEFORE INSERT OR UPDATE ON public.restaurant_payments
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_payment_refund_integrity();

CREATE OR REPLACE FUNCTION public.restaurant_payments_period_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE _loc uuid; _row record; BEGIN _row:=COALESCE(NEW,OLD); SELECT o.location_id INTO _loc FROM public.restaurant_orders o WHERE o.id=_row.order_id AND o.tenant_id=_row.tenant_id; IF public.restaurant_day_is_locked(_row.tenant_id,_loc,(_row.created_at)::date) THEN RAISE EXCEPTION 'That business day is closed. Reopen the day before posting or reversing money against it.' USING ERRCODE='55006'; END IF; RETURN _row; END; $function$;

DROP TRIGGER IF EXISTS restaurant_payments_period_lock ON public.restaurant_payments;
CREATE TRIGGER restaurant_payments_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.restaurant_payments
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_payments_period_lock();

CREATE OR REPLACE FUNCTION public.restaurant_order_items_period_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE _loc uuid; _opened date; BEGIN SELECT o.location_id,(o.created_at)::date INTO _loc,_opened FROM public.restaurant_orders o WHERE o.id=NEW.order_id AND o.tenant_id=NEW.tenant_id; IF NEW.status='voided' AND COALESCE(OLD.status::text,'')<>'voided' AND public.restaurant_day_is_locked(NEW.tenant_id,_loc,_opened) THEN RAISE EXCEPTION 'That business day is closed. Reopen the day before voiding a line on it.' USING ERRCODE='55006'; END IF; RETURN NEW; END; $function$;

DROP TRIGGER IF EXISTS restaurant_order_items_period_lock ON public.restaurant_order_items;
CREATE TRIGGER restaurant_order_items_period_lock
  BEFORE UPDATE ON public.restaurant_order_items
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_order_items_period_lock();
