-- WCE-04 schema and privilege acceptance assertions. Run only against the isolated CI database.
DO $wce$
DECLARE
  v_resolve oid;
  v_revoke oid;
BEGIN
  IF to_regclass('public.restaurant_guest_commerce_sessions') IS NULL THEN
    RAISE EXCEPTION 'WCE-04 commerce session table is missing';
  END IF;
  IF to_regclass('public.wa_guest_portal_sessions') IS NOT NULL THEN
    RAISE EXCEPTION 'WCE-04 legacy WhatsApp-only session table still exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = 'public.restaurant_guest_commerce_sessions'::regclass
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Guest Commerce sessions must have RLS enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'restaurant_guest_commerce_sessions'
  ) THEN
    RAISE EXCEPTION 'Guest Commerce session table must remain service-role only';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurant_guest_commerce_sessions'
      AND column_name = 'source_channel'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurant_guest_commerce_sessions'
      AND column_name = 'table_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurant_guest_commerce_sessions'
      AND column_name = 'order_type'
  ) THEN
    RAISE EXCEPTION 'Guest Commerce channel, table and order-type columns are incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurant_guest_commerce_sessions'
      AND column_name = 'token'
  ) THEN
    RAISE EXCEPTION 'Raw Guest Commerce bearer tokens must never be persisted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurant_orders'
      AND column_name = 'guest_commerce_session_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurant_orders'
      AND column_name = 'guest_commerce_channel'
  ) THEN
    RAISE EXCEPTION 'Order-to-session attribution columns are missing';
  END IF;

  SELECT p.oid INTO v_resolve
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'restaurant_resolve_guest_commerce_session'
    AND pg_get_function_identity_arguments(p.oid) = '_token_hash text';
  SELECT p.oid INTO v_revoke
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'restaurant_revoke_guest_commerce_session'
    AND pg_get_function_identity_arguments(p.oid) = '_session_id uuid';

  IF v_resolve IS NULL OR v_revoke IS NULL THEN
    RAISE EXCEPTION 'Guest Commerce service RPCs are missing';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_resolve)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_revoke) THEN
    RAISE EXCEPTION 'Guest Commerce RPCs must be SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_resolve, 'EXECUTE')
     OR has_function_privilege('authenticated', v_resolve, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_resolve, 'EXECUTE')
     OR has_function_privilege('anon', v_revoke, 'EXECUTE')
     OR has_function_privilege('authenticated', v_revoke, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_revoke, 'EXECUTE') THEN
    RAISE EXCEPTION 'Guest Commerce RPC grants are not service-role only';
  END IF;
END;
$wce$;
