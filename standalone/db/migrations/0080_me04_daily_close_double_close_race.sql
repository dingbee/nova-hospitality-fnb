-- ME-04: a daily close could be closed twice under genuine concurrency.
--
-- restaurant_daily_close_control's guard clause was:
--   IF NEW.status<>'closed' OR OLD.status='closed' THEN RETURN NEW; END IF;
-- This was written to let a legitimate transition AWAY from 'closed' (the
-- reopen flow, NEW.status <> 'closed') pass through untouched when
-- OLD.status='closed' -- but the same clause also silently passed through
-- an attempt to close an ALREADY-closed day again (OLD.status='closed' AND
-- NEW.status='closed'), since it only checks OLD.status, never
-- distinguishing the two cases. The only thing preventing a double close
-- was closeDay()'s own application-level pre-check
-- (`if (close.status === "closed") throw`) -- a classic check-then-act
-- race: two concurrent closeDay calls for the same close both read
-- status != 'closed' before either commits, both pass the app check, and
-- both UPDATEs then succeed at the database layer with no error to either
-- caller.
--
-- Proven with two genuinely concurrent UPDATE transactions (BEGIN;
-- SELECT pg_sleep(1); UPDATE ... SET status='closed' ...; COMMIT;) against
-- a local Postgres replica: both committed successfully before this fix,
-- silently re-running the close (recomputing expected_cash/variance and
-- overwriting closed_by/closed_at with whichever process happened to
-- commit second) with no indication to the loser that its close was not
-- authoritative.
--
-- Fix: reject outright when OLD.status='closed' AND NEW.status='closed'.
-- Postgres's row lock on UPDATE serializes this correctly -- the second
-- concurrent close blocks until the first commits, then sees
-- OLD.status='closed' and is rejected, atomically, at the database layer
-- (mandate: "prefer atomic database-enforced guarantees" over an
-- application-level check-then-act). The legitimate reopen path
-- (NEW.status <> 'closed' while OLD.status='closed') and the legitimate
-- first-time close path (OLD.status <> 'closed') are both unaffected --
-- verified against the same local replica after this fix: reopen, then a
-- genuine re-close, both still succeed; a concurrent double-close now
-- yields exactly one success and one clean "This business date is already
-- closed." rejection instead of two silent successes.
--
-- This is a live production behavior change (not a Git-reconstruction
-- no-op like 0078/0079): before this migration, production had the exact
-- race described above.

CREATE OR REPLACE FUNCTION public.restaurant_daily_close_control()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE declared_count integer;
BEGIN
  IF OLD.status='closed' AND NEW.status='closed' THEN
    RAISE EXCEPTION 'This business date is already closed.' USING ERRCODE='55006';
  END IF;
  IF NEW.status<>'closed' OR OLD.status='closed' THEN RETURN NEW; END IF;
  SELECT count(*) INTO declared_count FROM public.restaurant_tender_declarations d WHERE d.close_id=NEW.id;
  IF NEW.declared_at IS NULL AND declared_count=0 THEN
    RAISE EXCEPTION 'The drawer must be declared before the day can be closed.' USING ERRCODE='check_violation';
  END IF;
  NEW.expected_cash:=public.restaurant_expected_tender(NEW.id,'cash');
  SELECT COALESCE(round(SUM(d.variance),2),0) INTO NEW.declared_variance FROM public.restaurant_tender_declarations d WHERE d.close_id=NEW.id;
  IF abs(COALESCE(NEW.declared_variance,0))>COALESCE(NEW.variance_tolerance,0)+0.005 THEN
    IF NEW.variance_authorized_by IS NULL OR COALESCE(length(btrim(NEW.variance_override_reason)),0)<10 THEN
      RAISE EXCEPTION 'The drawer is out by % beyond the tolerance of %. Closing requires an authorised reason.',round(abs(COALESCE(NEW.declared_variance,0)),2),round(COALESCE(NEW.variance_tolerance,0),2) USING ERRCODE='check_violation';
    END IF;
    NEW.variance_authorized_at:=COALESCE(NEW.variance_authorized_at,now());
  END IF;
  RETURN NEW;
END;
$function$;
