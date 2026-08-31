-- Restaurant business-identity logo storage (GEP4).
--
-- restaurant_tenants.settings.business (0001_fnb_core.sql, extended by
-- masterdata.server.ts's upsertBusinessProfile) already holds legalName/
-- tradingName; this adds the storage side for a logo image, referenced by
-- settings.business.logoUrl (a public URL string, exactly like
-- restaurant_menu_items.image_url).
--
-- Bucket is public-read for the same reason as restaurant-menu-images
-- (0009_menu_item_images.sql): the guest self-order surface is anonymous
-- and renders the logo in a plain <img> tag with no Supabase session to
-- authenticate a read. There is no confidentiality requirement on a
-- restaurant's own public logo. Writes are the sensitive operation and are
-- restricted to authenticated staff, scoped to the tenant that owns the
-- path — reusing the exact same tenant-ownership check menu images already
-- use (restaurant_owns_menu_image_path is deliberately bucket-agnostic: it
-- only inspects the object path's first segment, not the bucket).
--
-- Path convention: {tenant_id}/{filename} — one logo per tenant, no
-- per-entity segment needed (unlike menu images, which are per menu item).
-- tenant_id is always the first path segment and is always computed
-- server-side from a capability-checked tenantId — never accepted as a raw
-- path from the client (see tenant-logo.server.ts).
--
-- SVG is deliberately not an allowed MIME type: this bucket is public-read
-- and served to arbitrary browsers with no Content-Disposition override, so
-- an uploaded SVG could carry an embedded <script> that executes if the
-- object's public URL is opened directly rather than rendered inside an
-- <img> tag. Rejecting SVG outright is the safe choice here, matching the
-- same jpeg/png/webp-only restriction restaurant-menu-images already uses.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'restaurant-tenant-logos',
  'restaurant-tenant-logos',
  true,
  1572864, -- 1.5MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

do $$ begin
  create policy "tenant logos public read"
    on storage.objects for select
    to public
    using (bucket_id = 'restaurant-tenant-logos');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "tenant logos tenant write"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'restaurant-tenant-logos' and public.restaurant_owns_menu_image_path(name));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "tenant logos tenant update"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'restaurant-tenant-logos' and public.restaurant_owns_menu_image_path(name))
    with check (bucket_id = 'restaurant-tenant-logos' and public.restaurant_owns_menu_image_path(name));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "tenant logos tenant delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'restaurant-tenant-logos' and public.restaurant_owns_menu_image_path(name));
exception when duplicate_object then null; end $$;
