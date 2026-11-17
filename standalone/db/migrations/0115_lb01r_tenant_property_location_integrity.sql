-- LB-01R / LB-02.01R: enforce tenant/property/location ownership at database boundary.
BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.restaurant_locations l JOIN public.restaurant_properties p ON p.id=l.property_id WHERE l.tenant_id<>p.tenant_id) THEN
  RAISE EXCEPTION 'LB-01R: restaurant_locations contains tenant/property ownership mismatches';
 END IF;
 IF EXISTS (SELECT 1 FROM public.staynas_product_connections c JOIN public.restaurant_properties p ON p.id=c.local_property_id WHERE c.local_tenant_id<>p.tenant_id) THEN
  RAISE EXCEPTION 'LB-01R: LexiBite connection contains mismatched tenant/property ownership';
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_properties'::regclass AND conname='restaurant_properties_tenant_id_id_key') THEN
  ALTER TABLE public.restaurant_properties ADD CONSTRAINT restaurant_properties_tenant_id_id_key UNIQUE(tenant_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_locations'::regclass AND conname='restaurant_locations_tenant_property_id_key') THEN
  ALTER TABLE public.restaurant_locations ADD CONSTRAINT restaurant_locations_tenant_property_id_key UNIQUE(tenant_id,property_id,id);
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid='public.restaurant_locations'::regclass
    AND contype='f'
    AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (tenant_id, property_id) REFERENCES restaurant_properties(tenant_id, id)%'
 ) THEN
  ALTER TABLE public.restaurant_locations ADD CONSTRAINT restaurant_locations_tenant_property_fk FOREIGN KEY(tenant_id,property_id) REFERENCES public.restaurant_properties(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.staynas_product_connections'::regclass AND conname='staynas_product_connections_local_tenant_property_fk') THEN
  ALTER TABLE public.staynas_product_connections ADD CONSTRAINT staynas_product_connections_local_tenant_property_fk FOREIGN KEY(local_tenant_id,local_property_id) REFERENCES public.restaurant_properties(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
 END IF;
END $$;
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid='public.restaurant_locations'::regclass
    AND conname='restaurant_locations_tenant_property_fk'
    AND NOT convalidated
 ) THEN
  ALTER TABLE public.restaurant_locations VALIDATE CONSTRAINT restaurant_locations_tenant_property_fk;
 END IF;
 IF EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid='public.staynas_product_connections'::regclass
    AND conname='staynas_product_connections_local_tenant_property_fk'
    AND NOT convalidated
 ) THEN
  ALTER TABLE public.staynas_product_connections VALIDATE CONSTRAINT staynas_product_connections_local_tenant_property_fk;
 END IF;
END $$;
COMMIT;