-- P0-04: make tenant-wide central-store membership checks RLS-safe.
-- The 0110 policies queried restaurant_members directly from another RLS
-- policy. If the caller's own membership row is hidden by restaurant_members
-- RLS, even a tenant-wide owner cannot see the central store. Resolve the
-- membership predicate in a narrowly scoped SECURITY DEFINER helper instead.

CREATE OR REPLACE FUNCTION public.restaurant_has_tenant_wide_membership(
  _tenant_id uuid,
  _user_id uuid,
  _roles public.restaurant_role[] DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $p0_04$
  SELECT _user_id IS NOT NULL
    AND public.restaurant_member_active(_user_id, _tenant_id)
    AND EXISTS (
      SELECT 1
      FROM public.restaurant_members m
      WHERE m.tenant_id = _tenant_id
        AND m.user_id = _user_id
        AND m.property_id IS NULL
        AND (_roles IS NULL OR m.role = ANY(_roles))
    );
$p0_04$;

REVOKE ALL ON FUNCTION public.restaurant_has_tenant_wide_membership(
  uuid, uuid, public.restaurant_role[]
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restaurant_has_tenant_wide_membership(
  uuid, uuid, public.restaurant_role[]
) TO authenticated, service_role;

DROP POLICY IF EXISTS "locations read scoped" ON public.restaurant_locations;
CREATE POLICY "locations read scoped" ON public.restaurant_locations
  FOR SELECT TO authenticated
  USING (
    (
      scope = 'property'
      AND (
        public.restaurant_can_read_scoped(tenant_id, property_id)
        OR public.restaurant_can_write_scoped(
          tenant_id,
          ARRAY[
            'owner'::public.restaurant_role,
            'general_manager'::public.restaurant_role,
            'restaurant_manager'::public.restaurant_role
          ],
          property_id
        )
      )
    )
    OR (
      scope = 'tenant'
      AND public.restaurant_has_tenant_wide_membership(tenant_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS "locations write scoped (insert)" ON public.restaurant_locations;
CREATE POLICY "locations write scoped (insert)" ON public.restaurant_locations
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      scope = 'property'
      AND public.restaurant_can_write_scoped(
        tenant_id,
        ARRAY[
          'owner'::public.restaurant_role,
          'general_manager'::public.restaurant_role,
          'restaurant_manager'::public.restaurant_role
        ],
        property_id
      )
    )
    OR (
      scope = 'tenant'
      AND public.restaurant_has_tenant_wide_membership(
        tenant_id,
        auth.uid(),
        ARRAY[
          'owner'::public.restaurant_role,
          'general_manager'::public.restaurant_role
        ]
      )
    )
  );

DROP POLICY IF EXISTS "locations write scoped (update)" ON public.restaurant_locations;
CREATE POLICY "locations write scoped (update)" ON public.restaurant_locations
  FOR UPDATE TO authenticated
  USING (
    (
      scope = 'property'
      AND public.restaurant_can_write_scoped(
        tenant_id,
        ARRAY[
          'owner'::public.restaurant_role,
          'general_manager'::public.restaurant_role,
          'restaurant_manager'::public.restaurant_role
        ],
        property_id
      )
    )
    OR (
      scope = 'tenant'
      AND public.restaurant_has_tenant_wide_membership(
        tenant_id,
        auth.uid(),
        ARRAY[
          'owner'::public.restaurant_role,
          'general_manager'::public.restaurant_role
        ]
      )
    )
  )
  WITH CHECK (
    (
      scope = 'property'
      AND public.restaurant_can_write_scoped(
        tenant_id,
        ARRAY[
          'owner'::public.restaurant_role,
          'general_manager'::public.restaurant_role,
          'restaurant_manager'::public.restaurant_role
        ],
        property_id
      )
    )
    OR (
      scope = 'tenant'
      AND public.restaurant_has_tenant_wide_membership(
        tenant_id,
        auth.uid(),
        ARRAY[
          'owner'::public.restaurant_role,
          'general_manager'::public.restaurant_role
        ]
      )
    )
  );

DROP POLICY IF EXISTS "locations write scoped (delete)" ON public.restaurant_locations;
CREATE POLICY "locations write scoped (delete)" ON public.restaurant_locations
  FOR DELETE TO authenticated
  USING (
    (
      scope = 'property'
      AND public.restaurant_can_write_scoped(
        tenant_id,
        ARRAY[
          'owner'::public.restaurant_role,
          'general_manager'::public.restaurant_role,
          'restaurant_manager'::public.restaurant_role
        ],
        property_id
      )
    )
    OR (
      scope = 'tenant'
      AND public.restaurant_has_tenant_wide_membership(
        tenant_id,
        auth.uid(),
        ARRAY[
          'owner'::public.restaurant_role,
          'general_manager'::public.restaurant_role
        ]
      )
    )
  );
