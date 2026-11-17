-- WCE-04: one guest commerce capability/session model across WhatsApp,
-- website, social/direct links and QR entry. The WhatsApp-specific session
-- table is promoted in place so existing WCE-03 tokens remain valid.
ALTER TABLE public.wa_guest_portal_sessions
  RENAME TO restaurant_guest_commerce_sessions;

ALTER TABLE public.restaurant_guest_commerce_sessions
  RENAME COLUMN acquisition_channel TO source_channel;

ALTER TABLE public.restaurant_guest_commerce_sessions
  DROP CONSTRAINT wa_guest_portal_sessions_scope_check;
ALTER TABLE public.restaurant_guest_commerce_sessions
  DROP CONSTRAINT wa_guest_portal_sessions_acquisition_channel_check;
ALTER TABLE public.restaurant_guest_commerce_sessions
  DROP CONSTRAINT wa_guest_portal_sessions_binding_scope_fkey;

UPDATE public.restaurant_guest_commerce_sessions
SET scope = 'guest_commerce'
WHERE scope = 'menu_browse';

ALTER TABLE public.restaurant_guest_commerce_sessions
  ADD CONSTRAINT restaurant_guest_commerce_sessions_scope_check
    CHECK (scope = 'guest_commerce'),
  ADD CONSTRAINT restaurant_guest_commerce_sessions_source_channel_check
    CHECK (source_channel IN ('whatsapp', 'website', 'qr', 'social', 'direct', 'concierge')),
  ADD CONSTRAINT restaurant_guest_commerce_sessions_channel_binding_check
    CHECK (
      (source_channel = 'whatsapp' AND binding_id IS NOT NULL AND conversation_id IS NOT NULL)
      OR (source_channel <> 'whatsapp' AND binding_id IS NULL)
    ),
  ADD CONSTRAINT restaurant_guest_commerce_sessions_binding_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, binding_id)
    REFERENCES public.wa_phone_number_bindings(tenant_id, property_id, location_id, id)
    ON DELETE RESTRICT;

ALTER TABLE public.restaurant_guest_commerce_sessions
  ALTER COLUMN binding_id DROP NOT NULL,
  ADD COLUMN table_id uuid,
  ADD COLUMN order_type public.restaurant_order_type NOT NULL DEFAULT 'takeaway',
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_tables_guest_scope_id_uq
  ON public.restaurant_tables (tenant_id, property_id, location_id, id);

ALTER TABLE public.restaurant_guest_commerce_sessions
  ADD CONSTRAINT restaurant_guest_commerce_sessions_table_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, table_id)
    REFERENCES public.restaurant_tables(tenant_id, property_id, location_id, id)
    ON DELETE SET NULL (table_id);

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_guest_commerce_sessions_scope_id_uq
  ON public.restaurant_guest_commerce_sessions (tenant_id, property_id, location_id, id);

ALTER INDEX public.wa_guest_portal_sessions_scope_expiry_idx
  RENAME TO restaurant_guest_commerce_sessions_scope_expiry_idx;

DROP FUNCTION IF EXISTS public.wa_resolve_guest_portal_session(text);
DROP FUNCTION IF EXISTS public.wa_revoke_guest_portal_session(uuid);

CREATE OR REPLACE FUNCTION public.restaurant_resolve_guest_commerce_session(_token_hash text)
RETURNS TABLE (
  session_id uuid,
  tenant_id uuid,
  property_id uuid,
  location_id uuid,
  binding_id uuid,
  conversation_id uuid,
  table_id uuid,
  source_channel text,
  order_type public.restaurant_order_type,
  currency text,
  menu_context jsonb,
  expires_at timestamptz,
  scope text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $wce$
  UPDATE public.restaurant_guest_commerce_sessions s
  SET open_count = s.open_count + 1,
      opened_at = coalesce(s.opened_at, now()),
      last_activity_at = now()
  WHERE s.token_hash = _token_hash
    AND s.scope = 'guest_commerce'
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND s.open_count < s.max_open_count
    AND EXISTS (
      SELECT 1
      FROM public.restaurant_tenants t
      WHERE t.id = s.tenant_id
        AND t.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM public.restaurant_properties p
      WHERE p.id = s.property_id
        AND p.tenant_id = s.tenant_id
        AND p.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM public.restaurant_locations l
      WHERE l.id = s.location_id
        AND l.tenant_id = s.tenant_id
        AND l.property_id = s.property_id
        AND l.status = 'active'
        AND l.is_storage = false
    )
    AND (
      s.binding_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.wa_phone_number_bindings b
        JOIN public.api_integrations i ON i.id = b.integration_id
        WHERE b.id = s.binding_id
          AND b.status = 'active'
          AND i.status = 'active'
          AND b.tenant_id = s.tenant_id
          AND b.property_id = s.property_id
          AND b.location_id = s.location_id
      )
    )
    AND (
      s.table_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.restaurant_tables rt
        WHERE rt.id = s.table_id
          AND rt.tenant_id = s.tenant_id
          AND rt.property_id = s.property_id
          AND rt.location_id = s.location_id
          AND rt.active = true
      )
    )
  RETURNING s.id, s.tenant_id, s.property_id, s.location_id,
            s.binding_id, s.conversation_id, s.table_id, s.source_channel,
            s.order_type, s.currency, s.menu_context, s.expires_at, s.scope;
$wce$;

REVOKE ALL ON FUNCTION public.restaurant_resolve_guest_commerce_session(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_resolve_guest_commerce_session(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.restaurant_revoke_guest_commerce_session(_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $wce$
BEGIN
  UPDATE public.restaurant_guest_commerce_sessions
  SET revoked_at = coalesce(revoked_at, now())
  WHERE id = _session_id
    AND revoked_at IS NULL;
  RETURN FOUND;
END;
$wce$;

REVOKE ALL ON FUNCTION public.restaurant_revoke_guest_commerce_session(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_revoke_guest_commerce_session(uuid)
  TO service_role;

ALTER TABLE public.restaurant_orders
  ADD COLUMN guest_commerce_session_id uuid,
  ADD COLUMN guest_commerce_channel text,
  ADD CONSTRAINT restaurant_orders_guest_commerce_channel_check
    CHECK (
      guest_commerce_channel IS NULL
      OR guest_commerce_channel IN ('whatsapp', 'website', 'qr', 'social', 'direct', 'concierge')
    ),
  ADD CONSTRAINT restaurant_orders_guest_commerce_session_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, guest_commerce_session_id)
    REFERENCES public.restaurant_guest_commerce_sessions(tenant_id, property_id, location_id, id)
    ON DELETE SET NULL (guest_commerce_session_id);

CREATE INDEX IF NOT EXISTS restaurant_orders_guest_commerce_session_idx
  ON public.restaurant_orders (tenant_id, guest_commerce_session_id)
  WHERE guest_commerce_session_id IS NOT NULL;

ALTER TABLE public.restaurant_guest_commerce_sessions ENABLE ROW LEVEL SECURITY;
