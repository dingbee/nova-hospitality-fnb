-- WCE-05 — property-approved FAQ knowledge for grounded Guest Concierge answers.
CREATE TABLE IF NOT EXISTS public.restaurant_guest_faqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en', 'sw')),
  question text NOT NULL CHECK (length(trim(question)) BETWEEN 4 AND 500),
  answer text NOT NULL CHECK (length(trim(answer)) BETWEEN 4 AND 3000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_guest_faqs_property_scope_fkey
    FOREIGN KEY (tenant_id, property_id)
    REFERENCES public.restaurant_properties(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT restaurant_guest_faqs_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT restaurant_guest_faqs_question_uq UNIQUE (tenant_id, property_id, locale, question)
);
CREATE INDEX IF NOT EXISTS restaurant_guest_faqs_active_idx
  ON public.restaurant_guest_faqs (tenant_id, property_id, locale, sort_order)
  WHERE status = 'active';

ALTER TABLE public.restaurant_guest_faqs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS restaurant_guest_faqs_read_scoped ON public.restaurant_guest_faqs;
CREATE POLICY restaurant_guest_faqs_read_scoped
ON public.restaurant_guest_faqs
FOR SELECT TO authenticated
USING (status = 'active' AND public.restaurant_can_read_scoped(tenant_id, property_id));
GRANT SELECT ON public.restaurant_guest_faqs TO authenticated;
GRANT ALL ON public.restaurant_guest_faqs TO service_role;
NOTIFY pgrst, 'reload schema';
