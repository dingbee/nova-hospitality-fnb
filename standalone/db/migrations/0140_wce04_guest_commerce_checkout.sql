-- WCE-04 — Enable the existing Guest Portal capability for checkout and order provenance.
ALTER TABLE public.wa_guest_portal_sessions
  DROP CONSTRAINT IF EXISTS wa_guest_portal_sessions_scope_check;
ALTER TABLE public.wa_guest_portal_sessions
  ADD CONSTRAINT wa_guest_portal_sessions_scope_check
  CHECK (scope IN ('menu_browse', 'guest_commerce'));

ALTER TABLE public.restaurant_orders
  ADD COLUMN IF NOT EXISTS guest_portal_session_id uuid
  REFERENCES public.wa_guest_portal_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS restaurant_orders_guest_portal_session_idx
  ON public.restaurant_orders (tenant_id, guest_portal_session_id, opened_at DESC)
  WHERE guest_portal_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.wa_resolve_guest_portal_session(_token_hash text)
RETURNS TABLE (
  session_id uuid, tenant_id uuid, property_id uuid, location_id uuid,
  binding_id uuid, conversation_id uuid, currency text, menu_context jsonb,
  expires_at timestamptz, scope text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $wce$
  UPDATE public.wa_guest_portal_sessions s
  SET open_count = s.open_count + 1,
      opened_at = coalesce(s.opened_at, now()),
      last_activity_at = now()
  WHERE s.token_hash = _token_hash
    AND s.scope IN ('menu_browse', 'guest_commerce')
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND s.open_count < s.max_open_count
    AND EXISTS (
      SELECT 1
      FROM public.wa_phone_number_bindings b
      JOIN public.api_integrations i ON i.id = b.integration_id
      WHERE b.id = s.binding_id
        AND b.status = 'active' AND i.status = 'active'
        AND b.tenant_id = s.tenant_id
        AND b.property_id = s.property_id
        AND b.location_id = s.location_id
    )
    AND EXISTS (
      SELECT 1 FROM public.restaurant_locations l
      WHERE l.id = s.location_id AND l.status = 'active' AND l.is_storage = false
    )
  RETURNING s.id, s.tenant_id, s.property_id, s.location_id,
            s.binding_id, s.conversation_id, s.currency, s.menu_context,
            s.expires_at, s.scope;
$wce$;
REVOKE ALL ON FUNCTION public.wa_resolve_guest_portal_session(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_resolve_guest_portal_session(text) TO service_role;
NOTIFY pgrst, 'reload schema';
