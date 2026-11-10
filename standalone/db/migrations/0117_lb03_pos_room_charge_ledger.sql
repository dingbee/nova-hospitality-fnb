-- LB-03.01 — LexiBite POS-side financial correlation ledger and durable delivery outbox.
-- POS orders/payments remain authoritative; this ledger stores integration state only.
BEGIN;

CREATE TABLE IF NOT EXISTS public.lb03_pos_room_charge_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 property_id uuid,
 outlet_id uuid,
 order_id uuid NOT NULL REFERENCES public.restaurant_orders(id) ON DELETE RESTRICT,
 pos_payment_id uuid REFERENCES public.restaurant_payments(id) ON DELETE RESTRICT,
 integration_connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
 integration_property_id uuid NOT NULL,
 guest_reference uuid NOT NULL,
 stay_reference uuid NOT NULL,
 request_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 amount numeric(14,2) NOT NULL CHECK(amount>0 AND amount=round(amount,2)),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 tax_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(tax_breakdown)='array'),
 service_charge numeric(14,2) NOT NULL DEFAULT 0 CHECK(service_charge>=0),
 discount_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(discount_amount>=0),
 correlation_id text NOT NULL,
 state text NOT NULL DEFAULT 'INITIATED' CHECK(state IN (
  'INITIATED','AUTHORIZATION_PENDING','AUTHORIZED','REJECTED','POSTING_PENDING',
  'POSTED','POSTING_FAILED','REVERSAL_PENDING','REVERSED','RECONCILIATION_REQUIRED',
  'RECONCILED','EXPIRED'
 )),
 authorization_reference text,
 authorization_expires_at timestamptz,
 staynas_posting_id uuid,
 staynas_posting_reference text,
 reversed_at timestamptz,
 reversal_reference text,
 last_error_code text,
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 next_attempt_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT lb03_pos_room_charge_order_uq UNIQUE(tenant_id,order_id),
 CONSTRAINT lb03_pos_room_charge_idempotency_uq UNIQUE(tenant_id,idempotency_key),
 CONSTRAINT lb03_pos_room_charge_auth_ref_uq UNIQUE(authorization_reference),
 CONSTRAINT lb03_pos_room_charge_post_ref_uq UNIQUE(staynas_posting_reference)
);
CREATE INDEX IF NOT EXISTS lb03_pos_room_charge_recovery_idx
 ON public.lb03_pos_room_charge_operations(state,next_attempt_at,updated_at)
 WHERE state IN ('AUTHORIZATION_PENDING','POSTING_PENDING','POSTING_FAILED','REVERSAL_PENDING','RECONCILIATION_REQUIRED');

CREATE TABLE IF NOT EXISTS public.lb03_pos_room_charge_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operation_id uuid NOT NULL REFERENCES public.lb03_pos_room_charge_operations(id) ON DELETE RESTRICT,
 event_type text NOT NULL CHECK(event_type IN ('authorize','post','reverse','reconcile')),
 idempotency_key text NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','delivered','dead_lettered')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 available_at timestamptz NOT NULL DEFAULT now(),
 leased_at timestamptz,
 delivered_at timestamptz,
 last_error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT lb03_pos_room_charge_outbox_idempotency_uq UNIQUE(operation_id,event_type,idempotency_key)
);
CREATE INDEX IF NOT EXISTS lb03_pos_room_charge_outbox_dispatch_idx
 ON public.lb03_pos_room_charge_outbox(state,available_at,created_at)
 WHERE state IN ('pending','leased');

CREATE TABLE IF NOT EXISTS public.lb03_pos_room_charge_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 operation_id uuid NOT NULL REFERENCES public.lb03_pos_room_charge_operations(id) ON DELETE RESTRICT,
 event_type text NOT NULL,
 prior_state text,
 next_state text,
 actor_product text NOT NULL CHECK(actor_product IN ('lexibite','staynAS','system')),
 actor_id uuid,
 correlation_id text NOT NULL,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(evidence)='object'),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS lb03_pos_room_charge_audit_operation_idx
 ON public.lb03_pos_room_charge_audit(operation_id,occurred_at,id);

CREATE TABLE IF NOT EXISTS public.lb03_pos_room_charge_reconciliation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operation_id uuid NOT NULL REFERENCES public.lb03_pos_room_charge_operations(id) ON DELETE RESTRICT,
 outcome text NOT NULL CHECK(outcome IN (
  'MATCHED','MISSING_IN_STAYNAS','MISSING_IN_LEXIBITE','AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH','DUPLICATE_POSTING','STATUS_MISMATCH','REVERSAL_MISMATCH','PENDING_REVIEW'
 )),
 pos_amount numeric(14,2),
 staynas_amount numeric(14,2),
 pos_currency text,
 staynas_currency text,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(evidence)='object'),
 reviewed_by uuid,
 reviewed_at timestamptz,
 resolution text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lb03_pos_room_charge_reconciliation_operation_idx
 ON public.lb03_pos_room_charge_reconciliation(operation_id,created_at DESC);

ALTER TABLE public.lb03_pos_room_charge_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lb03_pos_room_charge_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lb03_pos_room_charge_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lb03_pos_room_charge_reconciliation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lb03_pos_room_charge_operations,public.lb03_pos_room_charge_outbox,
 public.lb03_pos_room_charge_audit,public.lb03_pos_room_charge_reconciliation FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.lb03_pos_room_charge_operations,public.lb03_pos_room_charge_outbox,
 public.lb03_pos_room_charge_audit,public.lb03_pos_room_charge_reconciliation TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.lb03_pos_room_charge_audit_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.lb03_pos_transition_room_charge(
 _operation_id uuid,_expected_state text,_next_state text,_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS public.lb03_pos_room_charge_operations
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $lb03$
DECLARE v_op public.lb03_pos_room_charge_operations%ROWTYPE;
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' THEN RAISE EXCEPTION 'Service authentication required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(_evidence)<>'object' THEN RAISE EXCEPTION 'Evidence must be an object' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_op FROM public.lb03_pos_room_charge_operations WHERE id=_operation_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Room-charge operation not found' USING ERRCODE='P0002'; END IF;
 IF v_op.state<>_expected_state THEN
  IF v_op.state=_next_state THEN RETURN v_op; END IF;
  RAISE EXCEPTION 'Illegal room-charge transition: expected %, found %',_expected_state,v_op.state USING ERRCODE='55000';
 END IF;
 IF NOT (
  (_expected_state='INITIATED' AND _next_state IN ('AUTHORIZATION_PENDING','REJECTED')) OR
  (_expected_state='AUTHORIZATION_PENDING' AND _next_state IN ('AUTHORIZED','REJECTED','EXPIRED','RECONCILIATION_REQUIRED')) OR
  (_expected_state='AUTHORIZED' AND _next_state IN ('POSTING_PENDING','EXPIRED')) OR
  (_expected_state='POSTING_PENDING' AND _next_state IN ('POSTED','POSTING_FAILED','RECONCILIATION_REQUIRED')) OR
  (_expected_state='POSTING_FAILED' AND _next_state IN ('POSTING_PENDING','RECONCILIATION_REQUIRED')) OR
  (_expected_state='POSTED' AND _next_state IN ('REVERSAL_PENDING','RECONCILIATION_REQUIRED')) OR
  (_expected_state='REVERSAL_PENDING' AND _next_state IN ('REVERSED','RECONCILIATION_REQUIRED')) OR
  (_expected_state='REVERSED' AND _next_state IN ('RECONCILIATION_REQUIRED','RECONCILED')) OR
  (_expected_state='POSTED' AND _next_state='RECONCILED') OR
  (_expected_state='RECONCILIATION_REQUIRED' AND _next_state IN ('POSTING_PENDING','REVERSAL_PENDING','RECONCILED'))
 ) THEN RAISE EXCEPTION 'Unsupported room-charge state transition' USING ERRCODE='22023'; END IF;
 UPDATE public.lb03_pos_room_charge_operations SET state=_next_state,updated_at=now()
  WHERE id=_operation_id RETURNING * INTO v_op;
 INSERT INTO public.lb03_pos_room_charge_audit(operation_id,event_type,prior_state,next_state,actor_product,correlation_id,evidence)
 VALUES(v_op.id,'room_charge.state_changed',_expected_state,_next_state,'staynAS',v_op.correlation_id,_evidence);
 RETURN v_op;
END;
$lb03$;

REVOKE ALL ON FUNCTION public.lb03_pos_transition_room_charge(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lb03_pos_transition_room_charge(uuid,text,text,jsonb) TO service_role;
COMMIT;
