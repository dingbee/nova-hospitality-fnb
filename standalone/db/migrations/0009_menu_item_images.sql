-- Menu item image storage.
--
-- restaurant_menu_items.image_url (0001_fnb_core.sql) has been readable by
-- POS and self-order since it was added, but nothing could ever write it —
-- there was no storage bucket and no management UI. This adds the storage
-- side; menu.server.ts / menu-image.server.ts add the write path.
--
-- Bucket is public-read: self-order is anonymous and renders image_url in
-- a plain <img> tag with no Supabase session to authenticate a read. Public
-- read is fine for menu photography — there is no confidentiality
-- requirement on a picture of a dish. Writes are the sensitive operation:
-- insert/update/delete are restricted to authenticated restaurant staff,
-- scoped to the tenant that owns the path.
--
-- Path convention: {tenant_id}/{menu_item_id}/{filename}. tenant_id is
-- always the first path segment and is always computed server-side from a
-- capability-checked, DB-verified tenantId — never accepted as a raw path
-- from the client (see menu-image.server.ts). property_id/location_id are
-- not part of the path: restaurant_menu_items does not carry them directly
-- (only its parent restaurant_menus does), and tenant_id is the only
-- boundary that matters for storage isolation here.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'restaurant-menu-images',
  'restaurant-menu-images',
  true,
  2097152, -- 2MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

create or replace function public.restaurant_owns_menu_image_path(_name text)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    public.restaurant_is_platform_admin(auth.uid())
    or exists (
      select 1 from public.restaurant_members m
      where m.user_id = auth.uid()
        and m.tenant_id::text = (storage.foldername(_name))[1]
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.restaurant_owns_menu_image_path(text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_owns_menu_image_path(text) TO authenticated, service_role;

do $$ begin
  create policy "menu images public read"
    on storage.objects for select
    to public
    using (bucket_id = 'restaurant-menu-images');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "menu images tenant write"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'restaurant-menu-images' and public.restaurant_owns_menu_image_path(name));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "menu images tenant update"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'restaurant-menu-images' and public.restaurant_owns_menu_image_path(name))
    with check (bucket_id = 'restaurant-menu-images' and public.restaurant_owns_menu_image_path(name));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "menu images tenant delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'restaurant-menu-images' and public.restaurant_owns_menu_image_path(name));
exception when duplicate_object then null; end $$;
