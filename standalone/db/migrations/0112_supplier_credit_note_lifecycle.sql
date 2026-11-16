-- PW-08 supplier credit-note lifecycle.
-- Credit notes are immutable source documents; applications are append-only.
-- Applying a note to an invoice is a single locked database transaction.

CREATE TABLE IF NOT EXISTS public.restaurant_supplier_credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  supplier_id uuid NOT NULL REFERENCES public.restaurant_suppliers(id) ON DELETE RESTRICT,
  reference_invoice_id uuid REFERENCES public.restaurant_supplier_invoices(id) ON DELETE RESTRICT,
  document_number text NOT NULL,
  supplier_credit_note_number text NOT NULL,
  credit_date date NOT NULL DEFAULT current_date,
  currency text NOT NULL DEFAULT 'TZS',
  subtotal numeric(14,2) NOT NULL CHECK (subtotal >= 0),
  tax_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total numeric(14,2) NOT NULL CHECK (total > 0),
  reason text NOT NULL CHECK (length(trim(reason)) >= 5),
  notes text,
  status text NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded', 'partially_applied', 'applied', 'voided')),
  recorded_by uuid NOT NULL,
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_supplier_credit_note_totals_check
    CHECK (abs(total - (subtotal + tax_total)) <= 0.01),
  CONSTRAINT restaurant_supplier_credit_note_document_unique
    UNIQUE (tenant_id, document_number),
  CONSTRAINT restaurant_supplier_credit_note_supplier_ref_unique
    UNIQUE (tenant_id, supplier_id, supplier_credit_note_number)
);

CREATE INDEX IF NOT EXISTS idx_supplier_credit_notes_tenant_date
  ON public.restaurant_supplier_credit_notes (tenant_id, credit_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_credit_notes_invoice
  ON public.restaurant_supplier_credit_notes (tenant_id, reference_invoice_id);

GRANT SELECT, INSERT ON public.restaurant_supplier_credit_notes TO authenticated;
GRANT ALL ON public.restaurant_supplier_credit_notes TO service_role;
ALTER TABLE public.restaurant_supplier_credit_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "supplier credit notes read" ON public.restaurant_supplier_credit_notes;
DROP POLICY IF EXISTS "supplier credit notes insert" ON public.restaurant_supplier_credit_notes;
CREATE POLICY "supplier credit notes read" ON public.restaurant_supplier_credit_notes
  FOR SELECT TO public
  USING (
    public.restaurant_can_read(tenant_id)
    OR public.restaurant_can_write(
      tenant_id,
      ARRAY[
        'owner'::public.restaurant_role,
        'general_manager'::public.restaurant_role,
        'restaurant_manager'::public.restaurant_role,
        'purchasing_officer'::public.restaurant_role,
        'accountant'::public.restaurant_role
      ]
    )
  );
CREATE POLICY "supplier credit notes insert" ON public.restaurant_supplier_credit_notes
  FOR INSERT TO public
  WITH CHECK (
    public.restaurant_can_write(
      tenant_id,
      ARRAY[
        'owner'::public.restaurant_role,
        'general_manager'::public.restaurant_role,
        'restaurant_manager'::public.restaurant_role,
        'purchasing_officer'::public.restaurant_role,
        'accountant'::public.restaurant_role
      ]
    )
  );

CREATE TABLE IF NOT EXISTS public.restaurant_supplier_credit_note_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  credit_note_id uuid NOT NULL REFERENCES public.restaurant_supplier_credit_notes(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES public.restaurant_supplier_invoices(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  idempotency_key uuid NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  applied_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_supplier_credit_note_application_idempotency_unique
    UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_supplier_credit_note_applications_note
  ON public.restaurant_supplier_credit_note_applications (tenant_id, credit_note_id);
CREATE INDEX IF NOT EXISTS idx_supplier_credit_note_applications_invoice
  ON public.restaurant_supplier_credit_note_applications (tenant_id, invoice_id);

GRANT SELECT ON public.restaurant_supplier_credit_note_applications TO authenticated;
GRANT ALL ON public.restaurant_supplier_credit_note_applications TO service_role;
ALTER TABLE public.restaurant_supplier_credit_note_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "supplier credit note applications read" ON public.restaurant_supplier_credit_note_applications;
CREATE POLICY "supplier credit note applications read" ON public.restaurant_supplier_credit_note_applications
  FOR SELECT TO public
  USING (
    public.restaurant_can_read(tenant_id)
    OR public.restaurant_can_write(
      tenant_id,
      ARRAY[
        'owner'::public.restaurant_role,
        'general_manager'::public.restaurant_role,
        'restaurant_manager'::public.restaurant_role,
        'purchasing_officer'::public.restaurant_role,
        'accountant'::public.restaurant_role
      ]
    )
  );

CREATE OR REPLACE FUNCTION public.restaurant_apply_supplier_credit_note(
  _tenant_id uuid,
  _credit_note_id uuid,
  _invoice_id uuid,
  _amount numeric,
  _reason text,
  _idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_note public.restaurant_supplier_credit_notes%ROWTYPE;
  v_invoice public.restaurant_supplier_invoices%ROWTYPE;
  v_existing public.restaurant_supplier_credit_note_applications%ROWTYPE;
  v_note_applied numeric(14,2);
  v_invoice_credits numeric(14,2);
  v_note_remaining numeric(14,2);
  v_invoice_remaining numeric(14,2);
  v_application public.restaurant_supplier_credit_note_applications%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'AUTHENTICATION_REQUIRED';
  END IF;
  IF NOT public.restaurant_can_write(
    _tenant_id,
    ARRAY[
      'owner'::public.restaurant_role,
      'general_manager'::public.restaurant_role,
      'restaurant_manager'::public.restaurant_role,
      'purchasing_officer'::public.restaurant_role,
      'accountant'::public.restaurant_role
    ]
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'CREDIT_NOTE_APPLICATION_FORBIDDEN';
  END IF;
  IF _amount IS NULL OR _amount <= 0 OR _idempotency_key IS NULL OR length(trim(coalesce(_reason, ''))) < 3 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_CREDIT_NOTE_APPLICATION';
  END IF;

  SELECT * INTO v_note
  FROM public.restaurant_supplier_credit_notes
  WHERE tenant_id = _tenant_id AND id = _credit_note_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'SUPPLIER_CREDIT_NOTE_NOT_FOUND';
  END IF;

  SELECT * INTO v_invoice
  FROM public.restaurant_supplier_invoices
  WHERE tenant_id = _tenant_id AND id = _invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'SUPPLIER_INVOICE_NOT_FOUND';
  END IF;

  SELECT * INTO v_existing
  FROM public.restaurant_supplier_credit_note_applications
  WHERE tenant_id = _tenant_id AND idempotency_key = _idempotency_key;
  IF FOUND THEN
    IF v_existing.credit_note_id <> _credit_note_id
      OR v_existing.invoice_id <> _invoice_id
      OR abs(v_existing.amount - _amount) > 0.0001 THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'CREDIT_NOTE_IDEMPOTENCY_KEY_REUSED';
    END IF;
    RETURN jsonb_build_object(
      'applicationId', v_existing.id,
      'creditNoteId', v_existing.credit_note_id,
      'invoiceId', v_existing.invoice_id,
      'amountApplied', v_existing.amount,
      'idempotentReplay', true
    );
  END IF;

  IF v_note.status = 'voided' OR v_note.status = 'applied' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CREDIT_NOTE_NOT_APPLICABLE';
  END IF;
  IF v_invoice.status = 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CANCELLED_INVOICE_NOT_APPLICABLE';
  END IF;
  IF v_note.supplier_id IS DISTINCT FROM v_invoice.supplier_id
    OR upper(v_note.currency) IS DISTINCT FROM upper(v_invoice.currency) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CREDIT_NOTE_INVOICE_SUPPLIER_OR_CURRENCY_MISMATCH';
  END IF;
  IF NOT public.restaurant_can_write_scoped(
    _tenant_id,
    ARRAY[
      'owner'::public.restaurant_role,
      'general_manager'::public.restaurant_role,
      'restaurant_manager'::public.restaurant_role,
      'purchasing_officer'::public.restaurant_role,
      'accountant'::public.restaurant_role
    ],
    v_invoice.property_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'CREDIT_NOTE_APPLICATION_PROPERTY_FORBIDDEN';
  END IF;
  IF v_note.reference_invoice_id IS NOT NULL AND v_note.reference_invoice_id <> v_invoice.id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CREDIT_NOTE_REFERENCE_INVOICE_MISMATCH';
  END IF;

  IF v_note.property_id IS NOT NULL
    AND v_note.property_id IS DISTINCT FROM v_invoice.property_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CREDIT_NOTE_PROPERTY_SCOPE_MISMATCH';
  END IF;
  IF v_note.location_id IS NOT NULL
    AND v_note.location_id IS DISTINCT FROM v_invoice.location_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CREDIT_NOTE_LOCATION_SCOPE_MISMATCH';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_note_applied
  FROM public.restaurant_supplier_credit_note_applications
  WHERE tenant_id = _tenant_id AND credit_note_id = _credit_note_id;
  SELECT coalesce(sum(amount), 0) INTO v_invoice_credits
  FROM public.restaurant_supplier_credit_note_applications
  WHERE tenant_id = _tenant_id AND invoice_id = _invoice_id;

  v_note_remaining := round(v_note.total - v_note_applied, 2);
  v_invoice_remaining := round(v_invoice.total - v_invoice.amount_paid - v_invoice_credits, 2);
  IF _amount - v_note_remaining > 0.0001 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CREDIT_NOTE_OVER_APPLICATION';
  END IF;
  IF _amount - v_invoice_remaining > 0.0001 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVOICE_CREDIT_EXCEEDS_OUTSTANDING_BALANCE';
  END IF;

  INSERT INTO public.restaurant_supplier_credit_note_applications (
    tenant_id, credit_note_id, invoice_id, amount, idempotency_key, reason, applied_by
  ) VALUES (
    _tenant_id, _credit_note_id, _invoice_id, round(_amount, 2), _idempotency_key, trim(_reason), v_actor
  ) RETURNING * INTO v_application;

  v_note_remaining := round(v_note_remaining - _amount, 2);
  v_invoice_remaining := round(v_invoice_remaining - _amount, 2);
  UPDATE public.restaurant_supplier_credit_notes
  SET status = CASE WHEN v_note_remaining <= 0.01 THEN 'applied' ELSE 'partially_applied' END
  WHERE tenant_id = _tenant_id AND id = _credit_note_id;

  UPDATE public.restaurant_supplier_invoices
  SET payment_status = CASE
    WHEN payment_status = 'disputed' THEN payment_status
    WHEN amount_paid + v_invoice_credits + round(_amount, 2) >= total - 0.01 THEN 'paid'
    WHEN amount_paid + v_invoice_credits + round(_amount, 2) > 0 THEN 'partially_paid'
    ELSE 'unpaid'
  END
  WHERE tenant_id = _tenant_id AND id = _invoice_id;

  INSERT INTO public.restaurant_procurement_audit (
    tenant_id, document_type, document_id, document_number, action,
    previous_state, new_state, reason, actor_id, metadata
  ) VALUES (
    _tenant_id, 'supplier_credit_note', _credit_note_id, v_note.document_number,
    'credit_note_applied', v_note.status,
    CASE WHEN v_note_remaining <= 0.01 THEN 'applied' ELSE 'partially_applied' END,
    trim(_reason), v_actor,
    jsonb_build_object(
      'invoice_id', _invoice_id,
      'application_id', v_application.id,
      'amount_applied', round(_amount, 2),
      'credit_note_remaining', v_note_remaining,
      'invoice_outstanding', v_invoice_remaining,
      'currency', v_note.currency
    )
  );

  RETURN jsonb_build_object(
    'applicationId', v_application.id,
    'creditNoteId', _credit_note_id,
    'invoiceId', _invoice_id,
    'amountApplied', v_application.amount,
    'creditNoteRemaining', v_note_remaining,
    'invoiceOutstanding', v_invoice_remaining,
    'idempotentReplay', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.restaurant_apply_supplier_credit_note(uuid, uuid, uuid, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restaurant_apply_supplier_credit_note(uuid, uuid, uuid, numeric, text, uuid) TO authenticated, service_role;
