-- LB-02 outlet versioning: server owns monotonic source_version.
BEGIN;
CREATE OR REPLACE FUNCTION public.lb02_increment_outlet_source_version()
RETURNS trigger LANGUAGE plpgsql SET search_path=public
AS $lb02$
BEGIN
 IF ROW(NEW.display_name,NEW.outlet_type,NEW.public_description,NEW.guest_visible_status,NEW.published_service_hours,NEW.approval_status)
    IS DISTINCT FROM
    ROW(OLD.display_name,OLD.outlet_type,OLD.public_description,OLD.guest_visible_status,OLD.published_service_hours,OLD.approval_status)
 THEN
  NEW.source_version:=OLD.source_version+1;
 ELSE
  NEW.source_version:=OLD.source_version;
 END IF;
 RETURN NEW;
END;
$lb02$;
DROP TRIGGER IF EXISTS lb02_outlet_source_version ON public.lb02_outlet_property_mappings;
CREATE TRIGGER lb02_outlet_source_version
BEFORE UPDATE ON public.lb02_outlet_property_mappings
FOR EACH ROW EXECUTE FUNCTION public.lb02_increment_outlet_source_version();
COMMIT;