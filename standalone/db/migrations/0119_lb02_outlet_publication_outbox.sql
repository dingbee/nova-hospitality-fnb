-- LB-02.02/05 — LexiBite approved outlet publication and durable outbound delivery.
BEGIN;
ALTER TABLE public.lb02_outlet_property_mappings
  ADD COLUMN IF NOT EXISTS outlet_reference uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS lb02_outlet_mapping_reference_uq
  ON public.lb02_outlet_property_mappings(connection_id, outlet_reference);

CREATE TABLE IF NOT EXISTS public.lb02_outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('outlet.published.v1','outlet.status_changed.v1')),
  event_version integer NOT NULL DEFAULT 1 CHECK (event_version=1),
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version>0),
  correlation_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','delivered','dead_lettered','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_at timestamptz,
  delivered_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code)<=80),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lb02_lexi_outbox_idempotency_uq UNIQUE(connection_id,idempotency_key),
  CONSTRAINT lb02_lexi_outbox_payload_allowlist_ck CHECK (
    payload - ARRAY['outletReference','propertyReference','displayName','outletType','publicDescription','guestVisibleStatus','serviceHours','sourceVersion']::text[] = '{}'::jsonb
  )
);
CREATE INDEX IF NOT EXISTS lb02_lexi_outbox_dispatch_idx
 ON public.lb02_outbox_events(state,available_at,created_at) WHERE state IN ('pending','leased');

CREATE TABLE IF NOT EXISTS public.lb02_outbox_delivery_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 event_id uuid NOT NULL REFERENCES public.lb02_outbox_events(id) ON DELETE RESTRICT,
 connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
 attempt_number integer NOT NULL CHECK(attempt_number>0),
 outcome text NOT NULL CHECK(outcome IN ('accepted','retryable_failure','terminal_failure')),
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 error_code text CHECK(error_code IS NULL OR length(error_code)<=80),
 next_attempt_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT lb02_lexi_delivery_attempt_uq UNIQUE(event_id,attempt_number)
);

ALTER TABLE public.lb02_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lb02_outbox_delivery_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lb02_outbox_events,public.lb02_outbox_delivery_attempts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.lb02_outbox_events,public.lb02_outbox_delivery_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.lb02_publish_approved_outlet()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $lb02$
DECLARE v_event_type text; v_version bigint; v_correlation text;
BEGIN
 IF NEW.approval_status <> 'approved' OR NEW.approved_at IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND
   ROW(NEW.display_name,NEW.outlet_type,NEW.public_description,NEW.guest_visible_status,NEW.published_service_hours,NEW.approval_status)
   IS NOT DISTINCT FROM
   ROW(OLD.display_name,OLD.outlet_type,OLD.public_description,OLD.guest_visible_status,OLD.published_service_hours,OLD.approval_status)
 THEN RETURN NEW; END IF;
 SELECT c.correlation_id INTO v_correlation FROM public.staynas_product_connections c
 WHERE c.id=NEW.connection_id AND c.status='active'
   AND c.local_approved_at IS NOT NULL AND c.remote_approved_at IS NOT NULL
   AND c.remote_product='staynas' AND c.integration_property_id=NEW.integration_property_id
   AND c.remote_property_id=NEW.remote_property_id;
 IF v_correlation IS NULL THEN RETURN NEW; END IF;
 v_version:=NEW.source_version;
 v_event_type:=CASE WHEN TG_OP='INSERT' THEN 'outlet.published.v1' ELSE 'outlet.status_changed.v1' END;
 INSERT INTO public.lb02_outbox_events(
  connection_id,event_type,aggregate_id,aggregate_version,correlation_id,idempotency_key,payload
 ) VALUES (
  NEW.connection_id,v_event_type,NEW.outlet_reference,v_version,v_correlation,
  NEW.outlet_reference::text||':'||v_version::text,
  jsonb_build_object(
   'outletReference',NEW.outlet_reference,
   'propertyReference',NEW.integration_property_id,
   'displayName',NEW.display_name,
   'outletType',NEW.outlet_type,
   'publicDescription',NEW.public_description,
   'guestVisibleStatus',NEW.guest_visible_status,
   'serviceHours',NEW.published_service_hours,
   'sourceVersion',v_version
  )
 ) ON CONFLICT(connection_id,idempotency_key) DO NOTHING;
 RETURN NEW;
END;
$lb02$;
DROP TRIGGER IF EXISTS lb02_outlet_publish_outbox ON public.lb02_outlet_property_mappings;
CREATE TRIGGER lb02_outlet_publish_outbox
AFTER INSERT OR UPDATE OF display_name,outlet_type,public_description,guest_visible_status,published_service_hours,approval_status,approved_at,source_version
ON public.lb02_outlet_property_mappings
FOR EACH ROW EXECUTE FUNCTION public.lb02_publish_approved_outlet();

CREATE OR REPLACE FUNCTION public.lb02_claim_outlet_outbox(_connection_id uuid,_limit integer DEFAULT 25)
RETURNS TABLE(event_id uuid,event_type text,event_version integer,aggregate_id uuid,aggregate_version bigint,
 correlation_id text,idempotency_key text,payload jsonb,attempt_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $lb02$
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' THEN RAISE EXCEPTION 'Service authentication required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.staynas_product_connections c WHERE c.id=_connection_id
  AND c.status='active' AND c.local_approved_at IS NOT NULL AND c.remote_approved_at IS NOT NULL)
 THEN RAISE EXCEPTION 'LB-02 connection is not active' USING ERRCODE='42501'; END IF;
 RETURN QUERY
 WITH candidates AS (
  SELECT e.id FROM public.lb02_outbox_events e WHERE e.connection_id=_connection_id
   AND e.state IN ('pending','leased') AND e.available_at<=now()
   AND (e.state='pending' OR e.leased_at<now()-interval '2 minutes')
  ORDER BY e.created_at LIMIT greatest(1,least(coalesce(_limit,25),100)) FOR UPDATE SKIP LOCKED
 ), claimed AS (
  UPDATE public.lb02_outbox_events e SET state='leased',leased_at=now(),attempt_count=e.attempt_count+1
  FROM candidates c WHERE e.id=c.id RETURNING e.*
 )
 SELECT c.id,c.event_type,c.event_version,c.aggregate_id,c.aggregate_version,c.correlation_id,
  c.idempotency_key,c.payload,c.attempt_count FROM claimed c;
END;
$lb02$;

CREATE OR REPLACE FUNCTION public.lb02_record_outlet_delivery(
 _event_id uuid,_outcome text,_http_status integer DEFAULT NULL,_error_code text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $lb02$
DECLARE v_event public.lb02_outbox_events%ROWTYPE; v_next timestamptz;
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' THEN RAISE EXCEPTION 'Service authentication required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_event FROM public.lb02_outbox_events WHERE id=_event_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Outbox event not found' USING ERRCODE='P0002'; END IF;
 IF v_event.state IN ('delivered','dead_lettered','cancelled') THEN RETURN v_event.state; END IF;
 IF _outcome NOT IN ('accepted','retryable_failure','terminal_failure') THEN RAISE EXCEPTION 'Invalid delivery outcome' USING ERRCODE='22023'; END IF;
 IF _outcome='accepted' THEN
  UPDATE public.lb02_outbox_events SET state='delivered',delivered_at=now(),leased_at=NULL,last_error_code=NULL WHERE id=_event_id;
  INSERT INTO public.lb02_outbox_delivery_attempts(event_id,connection_id,attempt_number,outcome,http_status)
   VALUES(_event_id,v_event.connection_id,v_event.attempt_count,'accepted',_http_status) ON CONFLICT DO NOTHING;
  RETURN 'delivered';
 ELSIF _outcome='terminal_failure' OR v_event.attempt_count>=10 THEN
  UPDATE public.lb02_outbox_events SET state='dead_lettered',leased_at=NULL,last_error_code=left(coalesce(_error_code,'terminal_failure'),80) WHERE id=_event_id;
  INSERT INTO public.lb02_outbox_delivery_attempts(event_id,connection_id,attempt_number,outcome,http_status,error_code)
   VALUES(_event_id,v_event.connection_id,v_event.attempt_count,'terminal_failure',_http_status,left(coalesce(_error_code,'terminal_failure'),80)) ON CONFLICT DO NOTHING;
  RETURN 'dead_lettered';
 ELSE
  v_next:=now()+make_interval(secs=>least(3600,15*power(2,least(v_event.attempt_count-1,8))::integer)*(0.5+random()));
  UPDATE public.lb02_outbox_events SET state='pending',leased_at=NULL,available_at=v_next,last_error_code=left(coalesce(_error_code,'retryable_failure'),80) WHERE id=_event_id;
  INSERT INTO public.lb02_outbox_delivery_attempts(event_id,connection_id,attempt_number,outcome,http_status,error_code,next_attempt_at)
   VALUES(_event_id,v_event.connection_id,v_event.attempt_count,'retryable_failure',_http_status,left(coalesce(_error_code,'retryable_failure'),80),v_next) ON CONFLICT DO NOTHING;
  RETURN 'retry_scheduled';
 END IF;
END;
$lb02$;
REVOKE ALL ON FUNCTION public.lb02_claim_outlet_outbox(uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.lb02_record_outlet_delivery(uuid,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lb02_claim_outlet_outbox(uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.lb02_record_outlet_delivery(uuid,text,integer,text) TO service_role;
COMMIT;