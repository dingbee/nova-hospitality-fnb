-- Adversarial tests for migration 0107. Disposable PostgreSQL only.
\set ON_ERROR_STOP on
create table public.staff_access_test_data (id integer primary key, tenant_id uuid not null, property_id uuid);
alter table public.staff_access_test_data enable row level security;
create policy staff_access_test_read on public.staff_access_test_data
  for select to authenticated using (public.restaurant_can_read_scoped(tenant_id, property_id));
grant select on public.staff_access_test_data to authenticated;

insert into public.restaurant_tenants(id,name) values
 ('10000000-0000-0000-0000-000000000001','Tenant A'),
 ('10000000-0000-0000-0000-000000000002','Tenant B');
insert into public.restaurant_properties(id,tenant_id,name) values
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Property A'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','Property B'),
 ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000002','Property C');
insert into public.restaurant_members(id,tenant_id,user_id,role,property_id,pos_pin_hash,pos_pin_enabled) values
 ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','general_manager',null,null,false),
 ('30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002','bartender','20000000-0000-0000-0000-000000000001',extensions.crypt('1234',extensions.gen_salt('bf',4)),true),
 ('30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000003','accountant','20000000-0000-0000-0000-000000000002',extensions.crypt('5678',extensions.gen_salt('bf',4)),true),
 ('30000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000004','bartender','20000000-0000-0000-0000-000000000003',extensions.crypt('9012',extensions.gen_salt('bf',4)),true);
insert into public.staff_access_test_data(id,tenant_id,property_id) values
 (1,'10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001'),
 (2,'10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002'),
 (3,'10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000003');

set role authenticated;
select set_config('request.jwt.claim.sub','40000000-0000-0000-0000-000000000001',false);
select set_config('request.headers','{}',false);
do $$
declare session_a jsonb; session_b jsonb; token_a text; token_b text; actor uuid; visible integer;
begin
  if public.restaurant_effective_staff_member_id('10000000-0000-0000-0000-000000000001') is not null then raise exception 'FAIL: manager JWT alone resolved staff actor'; end if;
  select count(*) into visible from public.staff_access_test_data;
  if visible <> 0 then raise exception 'FAIL: manager JWT alone read % protected rows',visible; end if;

  session_a := public.restaurant_start_pos_session_by_pin('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','1234','terminal-A');
  token_a := session_a->>'sessionToken';
  if token_a is null or length(token_a) <> 64 then raise exception 'FAIL: no 256-bit terminal token'; end if;
  if exists(select 1 from public.restaurant_pos_sessions where id=(session_a->>'sessionId')::uuid and session_token_hash=token_a) then raise exception 'FAIL: plaintext token was stored'; end if;

  perform set_config('request.headers',jsonb_build_object('x-lexibite-staff-session',token_a)::text,true);
  actor := public.restaurant_effective_staff_member_id('10000000-0000-0000-0000-000000000001');
  if actor <> '30000000-0000-0000-0000-000000000002' then raise exception 'FAIL: valid token resolved wrong actor %',actor; end if;
  select count(*) into visible from public.staff_access_test_data;
  if visible <> 1 then raise exception 'FAIL: valid staff token saw % rows, expected 1',visible; end if;

  perform set_config('request.headers',jsonb_build_object('x-lexibite-staff-session',repeat('a',64))::text,true);
  if public.restaurant_effective_staff_member_id('10000000-0000-0000-0000-000000000001') is not null then raise exception 'FAIL: invalid token resolved actor'; end if;
  select count(*) into visible from public.staff_access_test_data;
  if visible <> 0 then raise exception 'FAIL: invalid token read protected rows'; end if;

  perform set_config('request.headers',jsonb_build_object('x-client-info','supabase-js/2; lexibite-staff-session='||token_a)::text,true);
  if public.restaurant_effective_staff_member_id('10000000-0000-0000-0000-000000000001') <> '30000000-0000-0000-0000-000000000002' then raise exception 'FAIL: x-client-info token transport'; end if;

  session_b := public.restaurant_start_pos_session_by_pin('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','5678','terminal-B');
  token_b := session_b->>'sessionToken';
  perform set_config('request.headers',jsonb_build_object('x-lexibite-staff-session',token_b)::text,true);
  actor := public.restaurant_effective_staff_member_id('10000000-0000-0000-0000-000000000001');
  if actor <> '30000000-0000-0000-0000-000000000003' then raise exception 'FAIL: terminal B wrong actor %',actor; end if;
  select count(*) into visible from public.staff_access_test_data;
  if visible <> 1 or not exists(select 1 from public.staff_access_test_data where id=2) then raise exception 'FAIL: terminal B scope mismatch'; end if;

  perform set_config('request.headers',jsonb_build_object('x-lexibite-staff-session',token_a)::text,true);
  if public.restaurant_effective_staff_member_id('10000000-0000-0000-0000-000000000001') <> '30000000-0000-0000-0000-000000000002' then raise exception 'FAIL: terminal A identity changed after terminal B start'; end if;

  -- Ending terminal A must not terminate terminal B's active session.
  perform public.restaurant_end_pos_session((session_a->>'sessionId')::uuid);
  perform set_config('request.headers',jsonb_build_object('x-lexibite-staff-session',token_b)::text,true);
  if public.restaurant_effective_staff_member_id('10000000-0000-0000-0000-000000000001') <> '30000000-0000-0000-0000-000000000003' then raise exception 'FAIL: ending terminal A disrupted terminal B'; end if;

  if public.restaurant_effective_staff_member_id('10000000-0000-0000-0000-000000000002') is not null then raise exception 'FAIL: cross-tenant actor resolution'; end if;
  select count(*) into visible from public.staff_access_test_data where id=3;
  if visible <> 0 then raise exception 'FAIL: cross-tenant data leaked'; end if;

  -- Preserve the table constraint while testing expiration in the past.
  update public.restaurant_pos_sessions set started_at=now()-interval '2 hours', expires_at=now()-interval '1 hour'
   where id=(session_b->>'sessionId')::uuid;
  perform set_config('request.headers',jsonb_build_object('x-lexibite-staff-session',token_b)::text,true);
  if public.restaurant_effective_staff_member_id('10000000-0000-0000-0000-000000000001') is not null then raise exception 'FAIL: expired token resolved actor'; end if;

  begin
    perform public.restaurant_start_pos_session_by_pin('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','9999','terminal-C');
    raise exception 'FAIL: invalid PIN accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  -- Owner mode is direct only without terminal proof; PIN activation must switch to staff-scoped RLS.
  insert into public.restaurant_members(id,tenant_id,user_id,role,property_id,pos_pin_hash,pos_pin_enabled) values
   ('30000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000005','owner',null,null,false);
  perform set_config('request.jwt.claim.sub','40000000-0000-0000-0000-000000000005',false);
  perform set_config('request.headers','{}',false);
  select count(*) into visible from public.staff_access_test_data;
  if visible <> 2 then raise exception 'FAIL: owner direct mode expected 2 tenant rows, got %',visible; end if;
  session_a := public.restaurant_start_pos_session_by_pin('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','1234','owner-terminal');
  token_a := session_a->>'sessionToken';
  perform set_config('request.headers',jsonb_build_object('x-lexibite-staff-session',token_a)::text,true);
  actor := public.restaurant_effective_staff_member_id('10000000-0000-0000-0000-000000000001');
  if actor <> '30000000-0000-0000-0000-000000000002' then raise exception 'FAIL: owner staff mode resolved wrong actor %',actor; end if;
  select count(*) into visible from public.staff_access_test_data;
  if visible <> 1 or not exists(select 1 from public.staff_access_test_data where id=1) then raise exception 'FAIL: owner inherited owner scope in staff mode'; end if;
  perform set_config('request.headers',jsonb_build_object('x-lexibite-staff-session',repeat('f',64))::text,true);
  select count(*) into visible from public.staff_access_test_data;
  if visible <> 0 then raise exception 'FAIL: invalid staff token fell back to owner access'; end if;
  if public.restaurant_staff_mode_requested() is not true then raise exception 'FAIL: invalid token did not select fail-closed staff mode'; end if;
end $;
reset role;
select 'PASS: migration 0107 applied and adversarial staff-session/RLS cases passed' as result;
