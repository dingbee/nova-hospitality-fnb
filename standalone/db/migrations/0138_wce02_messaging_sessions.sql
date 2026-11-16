-- WCE-02 — Native Meta messaging, durable webhook inbox and Guest Portal sessions.
-- Additive schema only. No production migration is authorized by this branch.
-- Meta credentials remain in api_integrations (AES-256-GCM); this migration stores
-- only verified WABA/phone mappings and scoped operational metadata.

ALTER TABLE public.api_channel_definitions
  DROP CONSTRAINT IF EXISTS api_channel_definitions_category_check;

ALTER TABLE public.api_channel_definitions
  ADD CONSTRAINT api_channel_definitions_category_check
  CHECK (category = ANY (ARRAY[
    'marketplace'::text,
    'ordering_platform'::text,
    'delivery'::text,
    'aggregator'::text,
    'messaging'::text
  ]));

INSERT INTO public.api_channel_definitions (
  key, name, description, provider_key, category, enabled, sort_order
)
VALUES (
  'whatsapp',
  'WhatsApp Business',
  'Native Meta WhatsApp Business Platform connection for guest acquisition, conversations and notifications.',
  'meta-whatsapp',
  'messaging',
  true,
  50
)
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    provider_key = EXCLUDED.provider_key,
    category = EXCLUDED.category,
    enabled = EXCLUDED.enabled,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

CREATE TABLE IF NOT EXISTS public.wa_phone_number_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES public.api_integrations(id) ON DELETE CASCADE,
  waba_id text NOT NULL CHECK (waba_id ~ '^[0-9]{3,32}$'),
  phone_number_id text NOT NULL UNIQUE CHECK (phone_number_id ~ '^[0-9]{3,32}$'),
  display_phone_number text,
  verified_name text,
  quality_rating text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'error')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_phone_number_bindings_property_tenant_fkey
    FOREIGN KEY (tenant_id, property_id)
    REFERENCES public.restaurant_properties(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT wa_phone_number_bindings_identity_uq
    UNIQUE (tenant_id, property_id, location_id, phone_number_id),
  CONSTRAINT wa_phone_number_bindings_scope_id_uq
    UNIQUE (tenant_id, property_id, location_id, id)
);

CREATE INDEX IF NOT EXISTS wa_phone_number_bindings_scope_idx
  ON public.wa_phone_number_bindings (tenant_id, property_id, location_id, status);

CREATE OR REPLACE FUNCTION public.wa_validate_phone_number_binding_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  location_tenant uuid;
  location_property uuid;
  integration_tenant uuid;
  integration_property uuid;
  integration_provider text;
  integration_channel text;
  integration_type text;
  integration_config jsonb;
BEGIN
  SELECT l.tenant_id, l.property_id
  INTO location_tenant, location_property
  FROM public.restaurant_locations l
  WHERE l.id = NEW.location_id;

  IF NOT FOUND
    OR location_tenant IS DISTINCT FROM NEW.tenant_id
    OR location_property IS DISTINCT FROM NEW.property_id THEN
    RAISE EXCEPTION 'WhatsApp receiving number outlet is outside the selected tenant/property scope';
  END IF;

  SELECT i.tenant_id, i.property_id, i.provider, i.channel_key, i.integration_type, i.config
  INTO integration_tenant, integration_property, integration_provider, integration_channel, integration_type, integration_config
  FROM public.api_integrations i
  WHERE i.id = NEW.integration_id;

  IF NOT FOUND
    OR integration_tenant IS DISTINCT FROM NEW.tenant_id
    OR integration_property IS DISTINCT FROM NEW.property_id
    OR integration_provider IS DISTINCT FROM 'meta-whatsapp'
    OR integration_channel IS DISTINCT FROM 'whatsapp'
    OR integration_type IS DISTINCT FROM 'channel'
    OR integration_config->>'wabaId' IS DISTINCT FROM NEW.waba_id
    OR (
      integration_config->>'phoneNumberId' IS DISTINCT FROM NEW.phone_number_id
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(coalesce(integration_config->'phoneNumbers', '[]'::jsonb)) phone
        WHERE phone->>'id' = NEW.phone_number_id
      )
    ) THEN
    RAISE EXCEPTION 'WhatsApp integration or phone asset is outside the selected tenant/property scope';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.wa_validate_phone_number_binding_scope() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_validate_phone_number_binding_scope() TO service_role;

DROP TRIGGER IF EXISTS wa_phone_number_binding_scope_guard ON public.wa_phone_number_bindings;
CREATE TRIGGER wa_phone_number_binding_scope_guard
BEFORE INSERT OR UPDATE OF tenant_id, property_id, location_id, integration_id
ON public.wa_phone_number_bindings
FOR EACH ROW
EXECUTE FUNCTION public.wa_validate_phone_number_binding_scope();

CREATE TABLE IF NOT EXISTS public.wa_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid,
  tenant_id uuid REFERENCES public.restaurant_tenants(id) ON DELETE SET NULL,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  waba_id text,
  phone_number_id text NOT NULL,
  event_key text NOT NULL,
  event_type text NOT NULL,
  provider_timestamp timestamptz,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  signature_verified boolean NOT NULL DEFAULT true CHECK (signature_verified = true),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry', 'processed', 'dead_letter', 'rejected')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_webhook_events_phone_event_uq UNIQUE (phone_number_id, event_key),
  CONSTRAINT wa_webhook_events_scope_id_uq UNIQUE (tenant_id, property_id, location_id, id),
  CONSTRAINT wa_webhook_events_binding_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, binding_id)
    REFERENCES public.wa_phone_number_bindings(tenant_id, property_id, location_id, id)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.wa_validate_webhook_event_binding_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $
DECLARE
  bound_tenant uuid;
  bound_property uuid;
  bound_location uuid;
  bound_waba text;
  bound_phone text;
  bound_status text;
BEGIN
  IF NEW.binding_id IS NULL THEN
    IF NEW.status <> 'rejected'
      OR NEW.tenant_id IS NOT NULL
      OR NEW.property_id IS NOT NULL
      OR NEW.location_id IS NOT NULL THEN
      RAISE EXCEPTION 'Unresolved WhatsApp receiving numbers must be quarantined without tenant context';
    END IF;
    RETURN NEW;
  END IF;

  SELECT b.tenant_id, b.property_id, b.location_id, b.waba_id,
         b.phone_number_id, b.status
  INTO bound_tenant, bound_property, bound_location, bound_waba,
       bound_phone, bound_status
  FROM public.wa_phone_number_bindings b
  WHERE b.id = NEW.binding_id;

  IF NOT FOUND
    OR bound_tenant IS DISTINCT FROM NEW.tenant_id
    OR bound_property IS DISTINCT FROM NEW.property_id
    OR bound_location IS DISTINCT FROM NEW.location_id
    OR bound_waba IS DISTINCT FROM NEW.waba_id
    OR bound_phone IS DISTINCT FROM NEW.phone_number_id
    OR bound_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'WhatsApp webhook event does not match an active verified receiving-number binding';
  END IF;

  RETURN NEW;
END;
$;

REVOKE ALL ON FUNCTION public.wa_validate_webhook_event_binding_scope() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_validate_webhook_event_binding_scope() TO service_role;

DROP TRIGGER IF EXISTS wa_webhook_event_binding_scope_guard ON public.wa_webhook_events;
CREATE TRIGGER wa_webhook_event_binding_scope_guard
BEFORE INSERT OR UPDATE OF binding_id, tenant_id, property_id, location_id, waba_id, phone_number_id, status
ON public.wa_webhook_events
FOR EACH ROW
EXECUTE FUNCTION public.wa_validate_webhook_event_binding_scope();

CREATE INDEX IF NOT EXISTS wa_webhook_events_claim_idx
  ON public.wa_webhook_events (status, next_attempt_at, received_at);

CREATE INDEX IF NOT EXISTS wa_webhook_events_phone_order_idx
  ON public.wa_webhook_events (phone_number_id, received_at, id);

CREATE INDEX IF NOT EXISTS wa_webhook_events_binding_idx
  ON public.wa_webhook_events (binding_id, received_at DESC)
  WHERE binding_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.wa_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL,
  wa_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'human_handoff', 'suspended')),
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_conversations_scope_binding_uq
    UNIQUE (tenant_id, property_id, location_id, id),
  CONSTRAINT wa_conversations_binding_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, binding_id)
    REFERENCES public.wa_phone_number_bindings(tenant_id, property_id, location_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS wa_conversations_one_open_sender_idx
  ON public.wa_conversations (binding_id, wa_user_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS wa_conversations_scope_activity_idx
  ON public.wa_conversations (tenant_id, property_id, location_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS public.wa_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  provider_message_id text NOT NULL UNIQUE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type text NOT NULL DEFAULT 'text'
    CHECK (message_type IN ('text', 'image', 'audio', 'video', 'document', 'location', 'interactive', 'template', 'unknown')),
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
  content text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_timestamp timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_messages_conversation_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, conversation_id)
    REFERENCES public.wa_conversations(tenant_id, property_id, location_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wa_messages_conversation_created_idx
  ON public.wa_messages (conversation_id, created_at, id);

CREATE INDEX IF NOT EXISTS wa_messages_scope_created_idx
  ON public.wa_messages (tenant_id, property_id, location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.wa_guest_portal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL,
  conversation_id uuid,
  created_by_event_id uuid,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  scope text NOT NULL DEFAULT 'menu_browse' CHECK (scope = 'menu_browse'),
  acquisition_channel text NOT NULL DEFAULT 'whatsapp' CHECK (acquisition_channel = 'whatsapp'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  menu_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  open_count integer NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  max_open_count integer NOT NULL DEFAULT 20 CHECK (max_open_count BETWEEN 1 AND 100),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  opened_at timestamptz,
  last_activity_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_guest_portal_sessions_binding_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, binding_id)
    REFERENCES public.wa_phone_number_bindings(tenant_id, property_id, location_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa_guest_portal_sessions_conversation_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, conversation_id)
    REFERENCES public.wa_conversations(tenant_id, property_id, location_id, id)
    ON DELETE SET NULL (conversation_id),
  CONSTRAINT wa_guest_portal_sessions_event_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, created_by_event_id)
    REFERENCES public.wa_webhook_events(tenant_id, property_id, location_id, id)
    ON DELETE SET NULL (created_by_event_id)
);

CREATE INDEX IF NOT EXISTS wa_guest_portal_sessions_scope_expiry_idx
  ON public.wa_guest_portal_sessions (tenant_id, property_id, location_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION public.wa_resolve_guest_portal_session(_token_hash text)
RETURNS TABLE (
  session_id uuid,
  tenant_id uuid,
  property_id uuid,
  location_id uuid,
  binding_id uuid,
  conversation_id uuid,
  currency text,
  menu_context jsonb,
  expires_at timestamptz,
  scope text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $
  UPDATE public.wa_guest_portal_sessions s
  SET open_count = s.open_count + 1,
      opened_at = coalesce(s.opened_at, now()),
      last_activity_at = now()
  WHERE s.token_hash = _token_hash
    AND s.scope = 'menu_browse'
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND s.open_count < s.max_open_count
    AND EXISTS (
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
  RETURNING s.id, s.tenant_id, s.property_id, s.location_id,
            s.binding_id, s.conversation_id, s.currency,
            s.menu_context, s.expires_at, s.scope;
$;

REVOKE ALL ON FUNCTION public.wa_resolve_guest_portal_session(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_resolve_guest_portal_session(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.wa_revoke_guest_portal_session(_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $
BEGIN
  UPDATE public.wa_guest_portal_sessions
  SET revoked_at = coalesce(revoked_at, now())
  WHERE id = _session_id
    AND revoked_at IS NULL;
  RETURN FOUND;
END;
$;

REVOKE ALL ON FUNCTION public.wa_revoke_guest_portal_session(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_revoke_guest_portal_session(uuid)
  TO service_role;


CREATE OR REPLACE FUNCTION public.wa_claim_webhook_events(
  _limit integer DEFAULT 20,
  _lease_seconds integer DEFAULT 60,
  _worker_id text DEFAULT 'wa-worker'
)
RETURNS SETOF public.wa_webhook_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT e.id
    FROM public.wa_webhook_events e
    WHERE (
      (e.status IN ('pending', 'retry') AND e.next_attempt_at <= now())
      OR (
        e.status = 'processing'
        AND e.locked_at < now() - make_interval(secs => LEAST(GREATEST(_lease_seconds, 10), 300))
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.wa_webhook_events earlier
      WHERE earlier.phone_number_id = e.phone_number_id
        AND (earlier.received_at, earlier.id) < (e.received_at, e.id)
        AND earlier.status IN ('pending', 'processing', 'retry', 'dead_letter')
    )
    ORDER BY e.received_at, e.id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(_limit, 1), 50)
  )
  UPDATE public.wa_webhook_events e
  SET status = 'processing',
      locked_at = now(),
      locked_by = left(coalesce(nullif(_worker_id, ''), 'wa-worker'), 100),
      attempt_count = e.attempt_count + 1
  FROM candidates c
  WHERE e.id = c.id
  RETURNING e.*;
END;
$$;

REVOKE ALL ON FUNCTION public.wa_claim_webhook_events(integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_claim_webhook_events(integer, integer, text) TO service_role;

CREATE OR REPLACE FUNCTION public.wa_apply_message_delivery_status(
  _provider_message_id text,
  _status text,
  _occurred_at timestamptz,
  _error_code text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_status text;
  current_rank integer;
  next_rank integer;
BEGIN
  IF _status NOT IN ('sent', 'delivered', 'read', 'failed') THEN
    RAISE EXCEPTION 'Unsupported WhatsApp delivery status';
  END IF;

  SELECT m.status
  INTO current_status
  FROM public.wa_messages m
  WHERE m.provider_message_id = _provider_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  current_rank := CASE current_status
    WHEN 'queued' THEN 0
    WHEN 'sent' THEN 1
    WHEN 'delivered' THEN 2
    WHEN 'read' THEN 3
    WHEN 'failed' THEN 4
    ELSE -1
  END;
  next_rank := CASE _status
    WHEN 'sent' THEN 1
    WHEN 'delivered' THEN 2
    WHEN 'read' THEN 3
    WHEN 'failed' THEN 4
    ELSE -1
  END;

  IF current_status IN ('delivered', 'read') AND _status = 'failed' THEN
    RETURN true;
  END IF;
  IF next_rank < current_rank THEN
    RETURN true;
  END IF;

  UPDATE public.wa_messages
  SET status = _status,
      sent_at = CASE WHEN _status = 'sent' THEN coalesce(sent_at, _occurred_at) ELSE sent_at END,
      delivered_at = CASE WHEN _status IN ('delivered', 'read') THEN coalesce(delivered_at, _occurred_at) ELSE delivered_at END,
      read_at = CASE WHEN _status = 'read' THEN coalesce(read_at, _occurred_at) ELSE read_at END,
      failed_at = CASE WHEN _status = 'failed' THEN coalesce(failed_at, _occurred_at) ELSE failed_at END,
      error_code = CASE WHEN _status = 'failed' THEN left(_error_code, 120) ELSE error_code END
  WHERE provider_message_id = _provider_message_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.wa_apply_message_delivery_status(text, text, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_apply_message_delivery_status(text, text, timestamptz, text)
  TO service_role;

ALTER TABLE public.wa_phone_number_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_guest_portal_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wa_phone_bindings_read_scoped ON public.wa_phone_number_bindings;
CREATE POLICY wa_phone_bindings_read_scoped
ON public.wa_phone_number_bindings
FOR SELECT TO authenticated
USING (public.restaurant_can_read_scoped(tenant_id, property_id));

DROP POLICY IF EXISTS wa_phone_bindings_insert_scoped ON public.wa_phone_number_bindings;
CREATE POLICY wa_phone_bindings_insert_scoped
ON public.wa_phone_number_bindings
FOR INSERT TO authenticated
WITH CHECK (
  public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner'::public.restaurant_role, 'general_manager'::public.restaurant_role, 'restaurant_manager'::public.restaurant_role],
    property_id
  )
);

DROP POLICY IF EXISTS wa_phone_bindings_update_scoped ON public.wa_phone_number_bindings;
CREATE POLICY wa_phone_bindings_update_scoped
ON public.wa_phone_number_bindings
FOR UPDATE TO authenticated
USING (
  public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner'::public.restaurant_role, 'general_manager'::public.restaurant_role, 'restaurant_manager'::public.restaurant_role],
    property_id
  )
)
WITH CHECK (
  public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner'::public.restaurant_role, 'general_manager'::public.restaurant_role, 'restaurant_manager'::public.restaurant_role],
    property_id
  )
);

DROP POLICY IF EXISTS wa_phone_bindings_delete_scoped ON public.wa_phone_number_bindings;
CREATE POLICY wa_phone_bindings_delete_scoped
ON public.wa_phone_number_bindings
FOR DELETE TO authenticated
USING (
  public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner'::public.restaurant_role, 'general_manager'::public.restaurant_role, 'restaurant_manager'::public.restaurant_role],
    property_id
  )
);

DROP POLICY IF EXISTS wa_conversations_read_scoped ON public.wa_conversations;
CREATE POLICY wa_conversations_read_scoped
ON public.wa_conversations
FOR SELECT TO authenticated
USING (public.restaurant_can_read_scoped(tenant_id, property_id));

DROP POLICY IF EXISTS wa_messages_read_scoped ON public.wa_messages;
CREATE POLICY wa_messages_read_scoped
ON public.wa_messages
FOR SELECT TO authenticated
USING (public.restaurant_can_read_scoped(tenant_id, property_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wa_phone_number_bindings TO authenticated;
GRANT SELECT ON public.wa_conversations, public.wa_messages TO authenticated;
GRANT ALL ON public.wa_phone_number_bindings, public.wa_webhook_events,
  public.wa_conversations, public.wa_messages, public.wa_guest_portal_sessions
  TO service_role;

NOTIFY pgrst, 'reload schema';
