-- P09 enterprise closure — inventory items property scope.
--
-- Provenance (ME-00 baseline reconciliation): reconstructed verbatim from
-- production's own migration ledger (supabase_migrations.schema_migrations,
-- version 20260914071410, created_by engutoto@googlemail.com). Applying it
-- again against production is a no-op.

DROP POLICY IF EXISTS "inv items write" ON public.restaurant_inventory_items;
CREATE POLICY "inv items write scoped" ON public.restaurant_inventory_items FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::public.restaurant_role[], property_id));
