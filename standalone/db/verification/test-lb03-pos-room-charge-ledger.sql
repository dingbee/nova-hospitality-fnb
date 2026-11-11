\set ON_ERROR_STOP on

ALTER TABLE public.staynas_product_connections ADD COLUMN IF NOT EXISTS remote_tenant_id uuid;

CREATE TABLE public.restaurant_orders(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id),
 property_id uuid NOT NULL REFERENCES public.restaurant_properties(id),
 location_id uuid NOT NULL REFERENCES public.restaurant_locations(id),
 total numeric(14,2) NOT NULL,currency text NOT NULL
);
CREATE TABLE public.restaurant_payments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id),
 order_id uuid NOT NULL REFERENCES public.restaurant_orders(id),
 amount numeric(14,2) NOT NULL,state text NOT NULL,refund_of uuid
);
INSERT INTO public.restaurant_orders VALUES(
 'a0000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 '20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',120,'TZS'
);
INSERT INTO public.restaurant_payments(id,tenant_id,order_id,amount,state) VALUES(
 'b0000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 'a0000000-0000-4000-8000-000000000001',120,'room_charged'
);
\i standalone/db/migrations/0121_lb03_pos_room_charge_ledger.sql

INSERT INTO public.lb03_pos_room_charge_operations(
 id,tenant_id,property_id,outlet_id,order_id,pos_payment_id,integration_connection_id,
 integration_property_id,guest_reference,stay_reference,request_id,idempotency_key,
 request_fingerprint,amount,currency,correlation_id,state
) VALUES(
 'd0000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
 '30000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',
 'b0000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
 '50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001',
 '90000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001',
 'lb03-pos-uat-001',repeat('a',64),120,'TZS','lb02-e2e-correlation','INITIATED'
);

SET ROLE service_role;
SELECT set_config('request.test_role','service_role',false);
DO $lb03pos$
DECLARE v public.lb03_pos_room_charge_operations%ROWTYPE;
BEGIN
 SELECT * INTO v FROM public.lb03_pos_transition_room_charge(
  'd0000000-0000-4000-8000-000000000001',
  'INITIATED','AUTHORIZATION_PENDING','{"request":"created"}'::jsonb
 );
 IF v.state<>'AUTHORIZATION_PENDING' THEN RAISE EXCEPTION 'POS operation did not enter authorization pending'; END IF;
 SELECT * INTO v FROM public.lb03_pos_transition_room_charge(
  v.id,'AUTHORIZATION_PENDING','AUTHORIZED','{"authorization":"confirmed"}'::jsonb
 );
 IF v.state<>'AUTHORIZED' THEN RAISE EXCEPTION 'POS operation did not enter authorized state'; END IF;
 SELECT * INTO v FROM public.lb03_pos_transition_room_charge(
  v.id,'AUTHORIZED','POSTING_PENDING','{"posting":"submitted"}'::jsonb
 );
 IF v.state<>'POSTING_PENDING' THEN RAISE EXCEPTION 'POS operation did not enter posting pending'; END IF;
 SELECT * INTO v FROM public.lb03_pos_transition_room_charge(
  v.id,'POSTING_PENDING','POSTED','{"postingReference":"FOL-LB03-UAT"}'::jsonb
 );
 IF v.state<>'POSTED' THEN RAISE EXCEPTION 'POS operation did not reach posted'; END IF;
 BEGIN
  PERFORM public.lb03_pos_transition_room_charge(v.id,'POSTED','AUTHORIZED','{}'::jsonb);
  RAISE EXCEPTION 'Illegal backward transition was accepted';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
 END;
END $lb03pos$;
RESET ROLE;

DO $lb03assert$
BEGIN
 IF (SELECT count(*) FROM public.lb03_pos_room_charge_audit WHERE operation_id=(SELECT id FROM public.lb03_pos_room_charge_operations WHERE idempotency_key='lb03-pos-uat-001'))<>4 THEN
  RAISE EXCEPTION 'Expected four immutable state transition audit events';
 END IF;
 IF (SELECT count(*) FROM public.lb03_pos_room_charge_outbox)<>0 THEN
  RAISE EXCEPTION 'Unexpected outbox records in isolated state-machine fixture';
 END IF;
END $lb03assert$;
