-- Live validation for P02.2-P02.4 LexiBite Demo Access (migration 0082).
-- Run as the DB superuser against a database with all migrations applied.
-- Not part of the automated migration chain: a throwaway proof script.
\set ON_ERROR_STOP on
\pset format aligned

\echo '--- fixture: the canonical demo tenant/property/location (real in production; migration 0039 only UPDATEs them, so a from-scratch local DB needs a stand-in to exercise the grant function) ---'
INSERT INTO public.restaurant_tenants (id, slug, name, status)
VALUES ('cebda97b-33b1-43bf-932e-d7fee992a6c3', 'lexibite-demo-verify-fixture', 'LexiBite Demo Restaurant', 'active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.restaurant_properties (id, tenant_id, slug, name)
VALUES ('d6674bdc-ebe2-4bb7-801a-54b1b8dfc218', 'cebda97b-33b1-43bf-932e-d7fee992a6c3', 'kilimanjaro-grill-verify-fixture', 'Kilimanjaro Grill')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.restaurant_locations (id, tenant_id, property_id, slug, name)
VALUES ('fb15e245-b2bf-4d07-abb6-213bbeafa584', 'cebda97b-33b1-43bf-932e-d7fee992a6c3', 'd6674bdc-ebe2-4bb7-801a-54b1b8dfc218', 'kilimanjaro-grill-west-verify-fixture', 'Kilimanjaro Grill West')
ON CONFLICT (id) DO NOTHING;
-- A second, unrelated tenant to prove cross-tenant isolation (step 7).
INSERT INTO public.restaurant_tenants (id, slug, name, status)
VALUES ('11111111-1111-1111-1111-111111111111', 'other-tenant-verify-fixture', 'Some Other Restaurant', 'active')
ON CONFLICT (id) DO NOTHING;

\echo '--- fixtures: two demo visitors, one commercial admin, one outsider ---'
INSERT INTO auth.users (email) VALUES ('demo.visitor.one@example.test') RETURNING id AS visitor1 \gset
INSERT INTO auth.users (email) VALUES ('demo.visitor.two@example.test') RETURNING id AS visitor2 \gset
INSERT INTO auth.users (email) VALUES ('demo.unverified@example.test') RETURNING id AS unverified \gset
INSERT INTO auth.users (email) VALUES ('platform.admin@example.test') RETURNING id AS admin_user \gset
INSERT INTO commercial_administrators (user_id, status) VALUES (:'admin_user', 'active');

INSERT INTO lexibite_demo_registrations
  (first_name, last_name, work_email, work_email_normalized, company, job_role, country, auth_user_id, status)
VALUES
  ('Demo', 'One', 'demo.visitor.one@example.test', 'demo.visitor.one@example.test', 'Acme', 'Ops', 'TZ', :'visitor1', 'verified')
RETURNING id AS reg1 \gset
INSERT INTO lexibite_demo_registrations
  (first_name, last_name, work_email, work_email_normalized, company, job_role, country, auth_user_id, status)
VALUES
  ('Demo', 'Unverified', 'demo.unverified@example.test', 'demo.unverified@example.test', 'Acme', 'Ops', 'TZ', :'unverified', 'pending_verification')
RETURNING id AS reg2 \gset

\echo '--- 1. anon has no grant on the function at all ---'
SET ROLE anon;
DO $$ BEGIN
  PERFORM public.restaurant_grant_demo_session();
  RAISE EXCEPTION 'FAIL: anon was able to call restaurant_grant_demo_session';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: anon denied execute on restaurant_grant_demo_session';
END $$;
RESET ROLE;

\echo '--- 2. unauthenticated (authenticated role, no claims) is rejected inside the function ---'
SET ROLE authenticated;
RESET request.jwt.claims;
DO $$ BEGIN
  PERFORM public.restaurant_grant_demo_session();
  RAISE EXCEPTION 'FAIL: no-claims caller was granted a demo session';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%no authenticated caller%' THEN
    RAISE NOTICE 'PASS: no-claims caller rejected (%)', SQLERRM;
  ELSE RAISE EXCEPTION 'FAIL: unexpected error %', SQLERRM;
  END IF;
END $$;
RESET ROLE;

\echo '--- 3. authenticated but no verified registration is rejected ---'
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'unverified', 'role', 'authenticated')::text, false);
DO $$ BEGIN
  PERFORM public.restaurant_grant_demo_session();
  RAISE EXCEPTION 'FAIL: unverified registration was granted a demo session';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%not verified%' THEN
    RAISE NOTICE 'PASS: unverified registration rejected (%)', SQLERRM;
  ELSE RAISE EXCEPTION 'FAIL: unexpected error %', SQLERRM;
  END IF;
END $$;
RESET ROLE;
RESET request.jwt.claims;

\echo '--- 4. verified visitor is granted exactly viewer on the canonical demo tenant ---'
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'visitor1', 'role', 'authenticated')::text, false);
SELECT * FROM public.restaurant_grant_demo_session();
RESET ROLE;

-- psql does not perform :'var' substitution inside dollar-quoted bodies
-- (it would otherwise clobber every plpgsql ":=" assignment), so values
-- needed inside a DO $$ block are passed through a session GUC instead.
SELECT set_config('nova_test.visitor1', :'visitor1', false);
DO $$
DECLARE r record;
BEGIN
  SELECT m.tenant_id, m.property_id, m.user_id, m.role INTO r FROM public.restaurant_members m
    WHERE m.user_id = current_setting('nova_test.visitor1')::uuid;
  IF r.tenant_id::text <> 'cebda97b-33b1-43bf-932e-d7fee992a6c3' OR r.role <> 'viewer' THEN
    RAISE EXCEPTION 'FAIL: unexpected membership grant %', r;
  END IF;
  RAISE NOTICE 'PASS: visitor1 granted viewer on the canonical demo tenant only (%)', r;
END $$;

\echo '--- 5. re-activating is idempotent (no duplicate membership/session rows) ---'
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'visitor1', 'role', 'authenticated')::text, false);
SELECT * FROM public.restaurant_grant_demo_session();
RESET ROLE;
DO $$
DECLARE member_count int; session_count int;
BEGIN
  SELECT count(*) INTO member_count FROM public.restaurant_members WHERE user_id = current_setting('nova_test.visitor1')::uuid;
  SELECT count(*) INTO session_count FROM public.lexibite_demo_sessions WHERE user_id = current_setting('nova_test.visitor1')::uuid;
  IF member_count <> 1 OR session_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: re-activation duplicated rows (members=%, sessions=%)', member_count, session_count;
  END IF;
  RAISE NOTICE 'PASS: re-activation stayed idempotent (1 membership, 1 session row)';
END $$;

\echo '--- 6. a demo viewer cannot write an order (RLS denies the write-role list) ---'
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'visitor1', 'role', 'authenticated')::text, false);
DO $$ BEGIN
  INSERT INTO public.restaurant_orders (tenant_id, property_id, order_number)
  VALUES ('cebda97b-33b1-43bf-932e-d7fee992a6c3', 'd6674bdc-ebe2-4bb7-801a-54b1b8dfc218', 'DEMO-TEST-1');
  RAISE EXCEPTION 'FAIL: viewer was able to insert a restaurant order';
EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
  IF SQLSTATE = '42501' THEN RAISE NOTICE 'PASS: viewer denied writing an order (RLS)';
  ELSE RAISE EXCEPTION 'FAIL: unexpected error %/%', SQLSTATE, SQLERRM;
  END IF;
END $$;
RESET ROLE;

\echo '--- 7. a demo viewer cannot read a different tenant (tenant isolation) ---'
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'visitor1', 'role', 'authenticated')::text, false);
DO $$
DECLARE cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM public.restaurant_tenants
    WHERE id <> 'cebda97b-33b1-43bf-932e-d7fee992a6c3';
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL: viewer could read % other tenant row(s)', cnt;
  END IF;
  RAISE NOTICE 'PASS: viewer reads zero rows from every tenant except the canonical demo tenant';
END $$;
RESET ROLE;
RESET request.jwt.claims;

\echo '--- 8. reset requires commercial admin, denied for the demo viewer ---'
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'visitor1', 'role', 'authenticated')::text, false);
DO $$ BEGIN
  PERFORM public.restaurant_reset_demo_environment(true);
  RAISE EXCEPTION 'FAIL: demo viewer was able to call the reset function';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%commercial administration required%' THEN
    RAISE NOTICE 'PASS: demo viewer denied reset (%)', SQLERRM;
  ELSE RAISE EXCEPTION 'FAIL: unexpected error %', SQLERRM;
  END IF;
END $$;
RESET ROLE;

\echo '--- 9. reset succeeds (dry run) for a genuine commercial admin ---'
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_user', 'role', 'authenticated')::text, false);
SELECT * FROM public.restaurant_reset_demo_environment(true);
RESET ROLE;
RESET request.jwt.claims;

\echo '--- 10. two verified visitors never see or affect each other'"'"'s session row ---'
INSERT INTO lexibite_demo_registrations
  (first_name, last_name, work_email, work_email_normalized, company, job_role, country, auth_user_id, status)
VALUES
  ('Demo', 'Two', 'demo.visitor.two@example.test', 'demo.visitor.two@example.test', 'Acme', 'Ops', 'TZ', :'visitor2', 'verified');
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'visitor2', 'role', 'authenticated')::text, false);
SELECT * FROM public.restaurant_grant_demo_session();
DO $$
DECLARE cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM public.lexibite_demo_sessions; -- RLS: self-read only
  IF cnt <> 1 THEN RAISE EXCEPTION 'FAIL: visitor2 can see % session rows (expected 1, their own)', cnt; END IF;
  RAISE NOTICE 'PASS: visitor2 sees only their own demo session row (RLS self-read)';
END $$;
RESET ROLE;
RESET request.jwt.claims;

\echo '--- 11. access BEFORE expiry: the RLS predicate change (migration 0083) has not broken a live, unexpired demo session ---'
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'visitor1', 'role', 'authenticated')::text, false);
DO $$
DECLARE cnt int; can_read boolean;
BEGIN
  can_read := public.restaurant_can_read('cebda97b-33b1-43bf-932e-d7fee992a6c3');
  SELECT count(*) INTO cnt FROM public.restaurant_tenants WHERE id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3';
  IF NOT can_read OR cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL: unexpired visitor1 lost read access (can_read=%, tenant rows visible=%)', can_read, cnt;
  END IF;
  RAISE NOTICE 'PASS: visitor1 still reads the canonical demo tenant before expiry (restaurant_can_read=true, 1 tenant row visible)';
END $$;
RESET ROLE;
RESET request.jwt.claims;

\echo '--- 12. denial AFTER expiry: expiring the session (without touching restaurant_members at all) must deny access ---'
UPDATE public.lexibite_demo_sessions SET expires_at = now() - interval '1 hour'
  WHERE user_id = :'visitor1';
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'visitor1', 'role', 'authenticated')::text, false);
DO $$
DECLARE cnt int; can_read boolean;
BEGIN
  can_read := public.restaurant_can_read('cebda97b-33b1-43bf-932e-d7fee992a6c3');
  SELECT count(*) INTO cnt FROM public.restaurant_tenants WHERE id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3';
  IF can_read OR cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL: expired visitor1 still has read access (can_read=%, tenant rows visible=%)', can_read, cnt;
  END IF;
  RAISE NOTICE 'PASS: expired visitor1 denied read access (restaurant_can_read=false, 0 tenant rows visible) — their restaurant_members row was never touched, only expires_at';
END $$;
RESET ROLE;
RESET request.jwt.claims;

\echo '--- 13. denial AFTER revocation: an admin revoking a still-unexpired session must deny access immediately ---'
SELECT id AS visitor2_session FROM public.lexibite_demo_sessions WHERE user_id = :'visitor2' \gset
SELECT set_config('nova_test.visitor2_session', :'visitor2_session', false);

-- Baseline: visitor2's session still has hours left on the clock — prove
-- access works BEFORE revocation, so the denial below is attributable to
-- the revoke call itself, not to some other cause.
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'visitor2', 'role', 'authenticated')::text, false);
DO $$
DECLARE can_read boolean;
BEGIN
  can_read := public.restaurant_can_read('cebda97b-33b1-43bf-932e-d7fee992a6c3');
  IF NOT can_read THEN
    RAISE EXCEPTION 'FAIL: visitor2 already denied before revocation — test setup is wrong';
  END IF;
END $$;
RESET ROLE;
RESET request.jwt.claims;

SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_user', 'role', 'authenticated')::text, false);
DO $$ BEGIN
  IF NOT public.restaurant_revoke_demo_session(current_setting('nova_test.visitor2_session')::uuid) THEN
    RAISE EXCEPTION 'FAIL: restaurant_revoke_demo_session reported no row revoked';
  END IF;
  RAISE NOTICE 'PASS: restaurant_revoke_demo_session (as commercial admin) revoked visitor2''s session';
END $$;
RESET ROLE;
RESET request.jwt.claims;

SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'visitor2', 'role', 'authenticated')::text, false);
DO $$
DECLARE cnt int; can_read boolean;
BEGIN
  can_read := public.restaurant_can_read('cebda97b-33b1-43bf-932e-d7fee992a6c3');
  SELECT count(*) INTO cnt FROM public.restaurant_tenants WHERE id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3';
  IF can_read OR cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL: revoked visitor2 still has read access (can_read=%, tenant rows visible=%)', can_read, cnt;
  END IF;
  RAISE NOTICE 'PASS: revoked visitor2 denied read access immediately, with hours still left on expires_at';
END $$;
RESET ROLE;
RESET request.jwt.claims;

\echo '--- 14. a REAL member (no demo session row at all) is completely unaffected by any of the above ---'
INSERT INTO auth.users (email) VALUES ('real.member.verify-fixture@example.test') RETURNING id AS real_member \gset
INSERT INTO public.restaurant_members (tenant_id, user_id, role)
VALUES ('cebda97b-33b1-43bf-932e-d7fee992a6c3', :'real_member', 'owner');
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'real_member', 'role', 'authenticated')::text, false);
DO $$
DECLARE can_read boolean;
BEGIN
  can_read := public.restaurant_can_read('cebda97b-33b1-43bf-932e-d7fee992a6c3');
  IF NOT can_read THEN
    RAISE EXCEPTION 'FAIL: a real member with no demo session row was denied — restaurant_member_active regressed a real customer';
  END IF;
  RAISE NOTICE 'PASS: a real member (never through the demo flow) reads normally throughout — zero regression';
END $$;
RESET ROLE;
RESET request.jwt.claims;
DELETE FROM public.restaurant_members WHERE user_id = :'real_member';
DELETE FROM auth.users WHERE id = :'real_member';

\echo '--- cleanup: remove every synthetic fixture this script created ---'
DELETE FROM public.lexibite_demo_sessions WHERE user_id IN (:'visitor1', :'visitor2');
DELETE FROM public.restaurant_members WHERE user_id IN (:'visitor1', :'visitor2');
DELETE FROM public.lexibite_demo_registrations WHERE auth_user_id IN (:'visitor1', :'visitor2', :'unverified');
DELETE FROM public.commercial_administrators WHERE user_id = :'admin_user';
DELETE FROM auth.users WHERE id IN (:'visitor1', :'visitor2', :'unverified', :'admin_user');
DELETE FROM public.restaurant_locations WHERE id = 'fb15e245-b2bf-4d07-abb6-213bbeafa584';
DELETE FROM public.restaurant_properties WHERE id = 'd6674bdc-ebe2-4bb7-801a-54b1b8dfc218';
DELETE FROM public.restaurant_tenants WHERE id IN ('cebda97b-33b1-43bf-932e-d7fee992a6c3', '11111111-1111-1111-1111-111111111111');

\echo '=== ALL LIVE VALIDATION CHECKS PASSED ==='
