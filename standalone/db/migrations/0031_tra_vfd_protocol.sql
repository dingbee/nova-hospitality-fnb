-- 0031_tra_vfd_protocol.sql
--
-- TRA VFD TEST/sandbox protocol persistence. Additive only — extends the
-- fiscal foundation (0025) and its property-scope closure (0028); no
-- existing table is dropped, no existing column is repurposed to mean
-- something incompatible with what it already stores.
--
-- Nothing here stores a real TRA secret in plaintext or invents TRA-issued
-- identity. Credentials issued by TRA at registration (username/password,
-- access tokens) are encrypted at rest by the application layer before
-- being written here (see fiscal/providers/tra/traCrypto.server.ts) using a
-- server-only key that never reaches the client — this table exists so the
-- ciphertext has somewhere durable to live, never so the plaintext does.

-- ---------------------------------------------------------------------------
-- 1. Tax classification: TRA requires one of five legally distinct VAT
--    classes (A=18% standard, B/C/D/E=0% but legally different — special,
--    zero-rated, special relief, exempt). restaurant_tax_rules already
--    carries a tenant-defined rate/code; it cannot losslessly encode TRA's
--    5-way split (multiple 0% rules could mean different TRA classes), so
--    the taxpayer must explicitly map each tax rule to its TRA class once.
--    Never inferred/guessed by the application beyond the one unambiguous
--    case (18% -> A) — see traXml.ts's resolveTaxCode.
-- ---------------------------------------------------------------------------
ALTER TABLE public.restaurant_tax_rules
  ADD COLUMN IF NOT EXISTS tra_tax_code text;

DO $$ BEGIN
  ALTER TABLE public.restaurant_tax_rules
    ADD CONSTRAINT restaurant_tax_rules_tra_tax_code_check
    CHECK (tra_tax_code IS NULL OR tra_tax_code IN ('A','B','C','D','E'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. TRA-issued credentials/token per fiscal configuration (one VFD).
--    Deliberately its own table, never joined into the configuration read
--    surface (getFiscalConfiguration selects only restaurant_fiscal_
--    configurations + restaurant_fiscal_devices) so an encrypted blob can
--    never end up in a server-fn response by accident.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.restaurant_fiscal_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  fiscal_configuration_id uuid NOT NULL REFERENCES public.restaurant_fiscal_configurations(id) ON DELETE CASCADE,
  tra_username text,
  tra_password_encrypted text,
  access_token_encrypted text,
  token_type text,
  issued_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fiscal_configuration_id)
);

ALTER TABLE public.restaurant_fiscal_credentials ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_fiscal_credentials TO authenticated;
GRANT ALL ON public.restaurant_fiscal_credentials TO service_role;

-- Mirrors restaurant_fiscal_device_property (0028): a SECURITY DEFINER
-- lookup so the RLS policy on this table doesn't need the calling role to
-- already have read access to restaurant_fiscal_configurations to resolve
-- its own scope.
CREATE OR REPLACE FUNCTION public.restaurant_fiscal_configuration_property(_config_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT property_id FROM public.restaurant_fiscal_configurations WHERE id = _config_id;
$$;
REVOKE ALL ON FUNCTION public.restaurant_fiscal_configuration_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_fiscal_configuration_property(uuid) TO authenticated, service_role;

CREATE POLICY "fiscal_credentials_read scoped" ON public.restaurant_fiscal_credentials
  FOR SELECT TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[], public.restaurant_fiscal_configuration_property(fiscal_configuration_id)));
CREATE POLICY "fiscal_credentials_write scoped" ON public.restaurant_fiscal_credentials
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[], public.restaurant_fiscal_configuration_property(fiscal_configuration_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[], public.restaurant_fiscal_configuration_property(fiscal_configuration_id)));

-- ---------------------------------------------------------------------------
-- 3. Fiscal numbering counters — GC (global, per VFD, never resets), DC
--    (daily, resets per fiscal day / ZNUM) and ZNUMBER (progressive Z-report
--    number, per VFD, never resets). One concurrency-safe allocator mirrors
--    the existing restaurant_next_document_number pattern exactly: an
--    atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING under the row's
--    own lock, so two simultaneous POS receipts can never be handed the
--    same sequence value.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.restaurant_fiscal_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  fiscal_configuration_id uuid NOT NULL REFERENCES public.restaurant_fiscal_configurations(id) ON DELETE CASCADE,
  counter_type text NOT NULL CHECK (counter_type IN ('gc','dc','znumber')),
  -- 'ALL' for gc/znumber (never reset); YYYYMMDD fiscal day for dc.
  period_key text NOT NULL,
  next_value bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fiscal_configuration_id, counter_type, period_key)
);

ALTER TABLE public.restaurant_fiscal_counters ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_fiscal_counters TO authenticated;
GRANT ALL ON public.restaurant_fiscal_counters TO service_role;

CREATE POLICY "fiscal_counters_read scoped" ON public.restaurant_fiscal_counters
  FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, public.restaurant_fiscal_configuration_property(fiscal_configuration_id)));
-- Writes only ever happen through restaurant_fiscal_next_counter()
-- (SECURITY DEFINER below), which enforces its own authorization by virtue
-- of running inside requestFiscalization/registerVfd's already-checked
-- code path — this policy exists so RLS is never silently bypassed for any
-- other write path.
CREATE POLICY "fiscal_counters_write scoped" ON public.restaurant_fiscal_counters
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], public.restaurant_fiscal_configuration_property(fiscal_configuration_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], public.restaurant_fiscal_configuration_property(fiscal_configuration_id)));

CREATE OR REPLACE FUNCTION public.restaurant_fiscal_next_counter(
  _tenant uuid, _fiscal_config uuid, _counter_type text, _period_key text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _allocated bigint;
BEGIN
  INSERT INTO public.restaurant_fiscal_counters (tenant_id, fiscal_configuration_id, counter_type, period_key, next_value)
  VALUES (_tenant, _fiscal_config, _counter_type, _period_key, 1)
  ON CONFLICT (tenant_id, fiscal_configuration_id, counter_type, period_key)
  DO UPDATE SET next_value = public.restaurant_fiscal_counters.next_value + 1, updated_at = now()
  RETURNING next_value INTO _allocated;
  RETURN _allocated;
END;
$$;
REVOKE ALL ON FUNCTION public.restaurant_fiscal_next_counter(uuid, uuid, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_fiscal_next_counter(uuid, uuid, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Fiscal receipt: TRA numbering + the exact original signed XML, frozen
--    at first submission so a retry (network timeout / no ACK) resends the
--    identical bytes instead of regenerating a new date/time/sequence.
-- ---------------------------------------------------------------------------
ALTER TABLE public.restaurant_fiscal_receipts
  ADD COLUMN IF NOT EXISTS gc_number bigint,
  ADD COLUMN IF NOT EXISTS dc_number bigint,
  ADD COLUMN IF NOT EXISTS znum text,
  ADD COLUMN IF NOT EXISTS rctvnum text,
  ADD COLUMN IF NOT EXISTS rct_date text,
  ADD COLUMN IF NOT EXISTS rct_time text,
  ADD COLUMN IF NOT EXISTS original_request_xml text,
  ADD COLUMN IF NOT EXISTS ack_code text,
  ADD COLUMN IF NOT EXISTS ack_message text,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_fiscal_receipts_tenant_config_gc_key
  ON public.restaurant_fiscal_receipts (tenant_id, fiscal_configuration_id, gc_number)
  WHERE gc_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Acknowledgement: safe TRA ACK fields (RCTNUM/DATE/TIME/ACKCODE/ACKMSG
--    carry no secret — safe to persist verbatim for audit/dispute).
-- ---------------------------------------------------------------------------
ALTER TABLE public.restaurant_fiscal_acknowledgements
  ADD COLUMN IF NOT EXISTS ack_code text,
  ADD COLUMN IF NOT EXISTS ack_message text,
  ADD COLUMN IF NOT EXISTS raw_response jsonb;

-- ---------------------------------------------------------------------------
-- 6. Z-report: ZNUMBER (progressive TRA Z-report number, reuses the
--    existing z_number column, previously always null/unused in the draft-
--    only foundation) is NOT the same value as ZNUM (YYYYMMDD fiscal day,
--    new column) — TRA's own docs are explicit that these are different
--    numbers and must never be confused.
-- ---------------------------------------------------------------------------
ALTER TABLE public.restaurant_fiscal_z_reports
  ADD COLUMN IF NOT EXISTS znum text,
  ADD COLUMN IF NOT EXISTS request_xml text,
  ADD COLUMN IF NOT EXISTS ack_code text,
  ADD COLUMN IF NOT EXISTS ack_message text,
  ADD COLUMN IF NOT EXISTS regid_snapshot text,
  ADD COLUMN IF NOT EXISTS efd_serial_snapshot text,
  ADD COLUMN IF NOT EXISTS submission_attempt_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.restaurant_fiscal_z_reports.z_number IS
  'TRA ZNUMBER — the progressive Z-report sequence number for this VFD. Distinct from znum (YYYYMMDD fiscal day).';
