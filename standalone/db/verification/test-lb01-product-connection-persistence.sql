\set ON_ERROR_STOP on
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE service_role BYPASSRLS;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.test_user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('request.test_role', true), current_user) $$;
DO $$ BEGIN CREATE TYPE public.restaurant_role AS ENUM ('owner','general_manager','restaurant_manager'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.restaurant_tenants(id uuid PRIMARY KEY);
CREATE TABLE public.restaurant_properties(id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id), UNIQUE (tenant_id,id));
CREATE TABLE public.restaurant_locations(id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id), property_id uuid NOT NULL REFERENCES public.restaurant_properties(id), slug text NOT NULL, UNIQUE(property_id,slug));
CREATE TABLE public.restaurant_members(tenant_id uuid NOT NULL, user_id uuid NOT NULL, property_id uuid, role public.restaurant_role NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE OR REPLACE FUNCTION public.restaurant_can_read_scoped(_tenant uuid, _property uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.restaurant_members m WHERE m.tenant_id=_tenant AND m.user_id=auth.uid() AND m.active AND (m.property_id IS NULL OR m.property_id=_property))
$$;
CREATE OR REPLACE FUNCTION public.restaurant_can_write_scoped(_tenant uuid, _roles public.restaurant_role[], _property uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.restaurant_members m WHERE m.tenant_id=_tenant AND m.user_id=auth.uid() AND m.active AND m.role=ANY(_roles) AND (m.property_id IS NULL OR m.property_id=_property))
$$;
INSERT INTO auth.users(id) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'),
 ('cccccccc-cccc-4ccc-8ccc-ccccccccccc3');
INSERT INTO public.restaurant_tenants(id) VALUES
 ('10000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000002');
INSERT INTO public.restaurant_properties(id,tenant_id) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001'),
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002');
INSERT INTO public.restaurant_locations(id,tenant_id,property_id,slug) VALUES
 ('70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','outlet-a');
INSERT INTO public.restaurant_members(tenant_id,user_id,property_id,role) VALUES
 ('10000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','20000000-0000-4000-8000-000000000001','owner'),
 ('10000000-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','20000000-0000-4000-8000-000000000002','owner'),
 ('10000000-0000-4000-8000-000000000002','cccccccc-cccc-4ccc-8ccc-ccccccccccc3','20000000-0000-4000-8000-000000000003','owner');

\i standalone/db/migrations/0112_lb01_product_connection_persistence.sql
\i standalone/db/migrations/0113_lb01_service_auth_nonce_ledger.sql
\i standalone/db/migrations/0114_lb01_secure_handoff_and_delivery.sql

\\i standalone/db/migrations/0115_lb01r_tenant_property_location_integrity.sql

SET ROLE authenticated;
SELECT set_config('request.test_user_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',false);
SELECT set_config('request.test_role','authenticated',false);
SELECT public.lexibite_request_staynas_connection(
 '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
 '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
 '50000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','lb01-test-connection-b'
) AS connection_id \gset
SELECT public.lexibite_approve_staynas_connection(:'connection_id');
RESET ROLE;

SET ROLE service_role;
SELECT set_config('request.test_role','service_role',false);
SELECT public.lexibite_record_staynas_approval(
 '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
 '50000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','lb01-test-connection-b'
);
RESET ROLE;

DO $lb01active$
BEGIN
 IF (SELECT status FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b') <> 'active' THEN
   RAISE EXCEPTION 'Connection must activate only after both approvals';
 END IF;
 IF (SELECT count(*) FROM public.staynas_product_connection_audit WHERE action IN ('requested','locally_approved','remotely_approved')) <> 3 THEN
   RAISE EXCEPTION 'Expected request and both approval audit records';
 END IF;
END $lb01active$;

SET ROLE authenticated;
SELECT set_config('request.test_user_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',false);
DO $lb01property$
BEGIN
 IF (SELECT count(*) FROM public.staynas_product_connections) <> 0 THEN
   RAISE EXCEPTION 'Other property member must not read connection';
 END IF;
 BEGIN
   PERFORM public.lexibite_request_staynas_connection(
    '30000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000002','lb01-test-cross-property'
   );
   RAISE EXCEPTION 'Cross-property request should have been denied';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $lb01property$;
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('request.test_user_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',false);
SELECT public.lexibite_set_staynas_connection_state(
 (SELECT id FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b'),'suspend',NULL
);
SELECT public.lexibite_set_staynas_connection_state(
 (SELECT id FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b'),'resume',NULL
);
SELECT public.lexibite_set_staynas_connection_state(
 (SELECT id FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b'),'revoke','test revocation'
);
DO $lb01revocation$
BEGIN
 IF (SELECT status FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b') <> 'revoked' THEN
   RAISE EXCEPTION 'Connection revocation did not persist';
 END IF;
 BEGIN
   PERFORM public.lexibite_approve_staynas_connection((SELECT id FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b'));
   RAISE EXCEPTION 'Revoked connection must not be re-approved';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM = 'Revoked connection must not be re-approved' THEN RAISE; END IF;
 END;
END $lb01revocation$;
-- A single integration tenant may map multiple properties.
SELECT set_config('request.test_user_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',false);
SELECT public.lexibite_request_staynas_connection(
 '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002',
 '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
 '50000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000002','lb01-test-second-property'
);
-- Revocation permits a fresh authorization with new canonical identifiers.
SELECT set_config('request.test_user_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',false);
SELECT public.lexibite_request_staynas_connection(
 '30000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000003',
 '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
 '50000000-0000-4000-8000-000000000003','60000000-0000-4000-8000-000000000003','lb01-test-reauthorization'
);
-- A different tenant cannot enumerate or administer this property's mapping.
SELECT set_config('request.test_user_id','cccccccc-cccc-4ccc-8ccc-ccccccccccc3',false);
DO $lb01test$
BEGIN
 IF (SELECT count(*) FROM public.staynas_product_connections) <> 0 THEN
   RAISE EXCEPTION 'Other tenant must not read connection';
 END IF;
 BEGIN
   PERFORM public.lexibite_request_staynas_connection(
    '30000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000004','60000000-0000-4000-8000-000000000004','lb01-test-cross-tenant'
   );
   RAISE EXCEPTION 'Cross-tenant request should have been denied';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $lb01test$;
RESET ROLE;

-- LB-01.03B: scoped credential issue/rotation/revocation and durable nonce replay prevention.
SET ROLE authenticated;
SELECT set_config('request.test_user_id','cccccccc-cccc-4ccc-8ccc-ccccccccccc3',false);
SELECT set_config('request.test_role','authenticated',false);
SELECT public.lexibite_request_staynas_connection(
 '30000000-0000-4000-8000-000000000009','40000000-0000-4000-8000-000000000009',
 '10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000003',
 '50000000-0000-4000-8000-000000000009','60000000-0000-4000-8000-000000000009','lb01-test-auth-active'
) AS service_connection_id \gset
SELECT public.lexibite_approve_staynas_connection(:'service_connection_id');
RESET ROLE;

SET ROLE service_role;
SELECT set_config('request.test_role','service_role',false);
SELECT public.lexibite_record_staynas_approval(
 '30000000-0000-4000-8000-000000000009','40000000-0000-4000-8000-000000000009',
 '50000000-0000-4000-8000-000000000009','60000000-0000-4000-8000-000000000009','lb01-test-auth-active'
);
RESET ROLE;

-- Keep the returned identifiers from the credential RPCs. The nonce test uses
-- these canonical IDs rather than repeating a prefix lookup across role changes.
CREATE TEMP TABLE lb01_test_credential_ids (
  label text PRIMARY KEY,
  credential_id uuid NOT NULL
) ON COMMIT PRESERVE ROWS;
GRANT SELECT, INSERT ON lb01_test_credential_ids TO authenticated, service_role;

-- Only the property administrator may issue or rotate the connection credential.
SET ROLE authenticated;
SELECT set_config('request.test_user_id','cccccccc-cccc-4ccc-8ccc-ccccccccccc3',false);
DO $lb01issue$
DECLARE _first uuid; _second uuid; _connection_id uuid;
BEGIN
 SELECT id INTO _connection_id FROM public.staynas_product_connections
 WHERE correlation_id='lb01-test-auth-active';
 IF _connection_id IS NULL THEN RAISE EXCEPTION 'Active credential test connection missing'; END IF;
 _first := public.lb01_issue_product_service_credential(
   _connection_id,'abcdef0123456789abcdef01',decode(repeat('aa',32),'hex'),now()+interval '1 day'
 );
 _second := public.lb01_issue_product_service_credential(
   _connection_id,'abcdef0123456789abcdef02',decode(repeat('bb',32),'hex'),now()+interval '1 day'
 );
 INSERT INTO lb01_test_credential_ids(label, credential_id)
 VALUES ('rotated', _first), ('active', _second);
 IF _first IS NULL OR _second IS NULL THEN
   RAISE EXCEPTION 'Credential issuance returned a null identifier';
 END IF;
END $lb01issue$;

RESET ROLE;

-- Inspect durable lifecycle rows as the fixture owner; service-role behavior is
-- verified independently through the nonce RPC below.
DO $lb01rotation$
DECLARE _old_status text; _new_status text; _audit_count integer;
BEGIN
 SELECT status INTO _old_status FROM public.product_service_credentials WHERE credential_prefix='abcdef0123456789abcdef01';
 SELECT status INTO _new_status FROM public.product_service_credentials WHERE credential_prefix='abcdef0123456789abcdef02';
 SELECT count(*) INTO _audit_count FROM public.product_service_credential_audit WHERE action IN ('issued','rotated');
 IF _old_status IS DISTINCT FROM 'revoked' OR _new_status IS DISTINCT FROM 'active' OR _audit_count < 2 THEN
   RAISE EXCEPTION 'Credential rotation assertion: old=%, new=%, audit=%', _old_status, _new_status, _audit_count;
 END IF;
END $lb01rotation$;

SET ROLE service_role;
SELECT set_config('request.test_role','service_role',false);
DO $lb01nonce$
DECLARE _first boolean; _replay boolean; _old_credential boolean; _expired boolean; _unknown boolean;
BEGIN
 _first := public.lb01_claim_service_nonce((SELECT credential_id FROM lb01_test_credential_ids WHERE label='active'),'0123456789abcdef0123456789abcdef',now()+interval '5 minutes');
 _replay := public.lb01_claim_service_nonce((SELECT credential_id FROM lb01_test_credential_ids WHERE label='active'),'0123456789abcdef0123456789abcdef',now()+interval '5 minutes');
 _old_credential := public.lb01_claim_service_nonce((SELECT credential_id FROM lb01_test_credential_ids WHERE label='rotated'),'fedcba9876543210fedcba9876543210',now()+interval '5 minutes');
 _expired := public.lb01_claim_service_nonce((SELECT credential_id FROM lb01_test_credential_ids WHERE label='active'),'fedcba9876543210fedcba9876543211',now()-interval '1 second');
 _unknown := public.lb01_claim_service_nonce('70000000-0000-4000-8000-000000000099','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',now()+interval '5 minutes');
 IF NOT _first OR _replay OR _old_credential OR _expired OR _unknown THEN
   RAISE EXCEPTION 'Nonce ledger assertion: first=%, replay=%, revoked=%, expired=%, unknown=%, active_id=%', _first, _replay, _old_credential, _expired, _unknown, (SELECT id FROM public.product_service_credentials WHERE credential_prefix='abcdef0123456789abcdef02');
 END IF;
END $lb01nonce$;
RESET ROLE;

-- Verify persisted nonce rows as the fixture owner, independently of the
-- service-role function execution context.
DO $lb01noncepersisted$
BEGIN
 IF (SELECT count(*) FROM public.product_service_nonces
     WHERE credential_id=(SELECT credential_id FROM lb01_test_credential_ids WHERE label='active')) <> 1 THEN
   RAISE EXCEPTION 'Expected exactly one persisted accepted nonce';
 END IF;
END $lb01noncepersisted$;

SET ROLE authenticated;
SELECT set_config('request.test_user_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',false);
DO $lb01deniedissue$
BEGIN
 BEGIN
   PERFORM public.lb01_issue_product_service_credential(
     (SELECT id FROM public.staynas_product_connections WHERE correlation_id='lb01-test-auth-active'),
     'abcdef0123456789abcdef03',decode(repeat('cc',32),'hex'),now()+interval '1 day'
   );
   RAISE EXCEPTION 'Cross-tenant credential issuance should be denied';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $lb01deniedissue$;
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('request.test_user_id','cccccccc-cccc-4ccc-8ccc-ccccccccccc3',false);
SELECT public.lb01_revoke_product_service_credential((SELECT credential_id FROM lb01_test_credential_ids WHERE label='active'),'test revocation');
RESET ROLE;

SET ROLE service_role;
SELECT set_config('request.test_role','service_role',false);
DO $lb01revoked$
BEGIN
 IF public.lb01_claim_service_nonce((SELECT credential_id FROM lb01_test_credential_ids WHERE label='active'),'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',now()+interval '5 minutes') THEN
   RAISE EXCEPTION 'Revoked credential must not claim new nonces';
 END IF;
END $lb01revoked$;
RESET ROLE;

SET ROLE authenticated;
DO $lb01credentialisolation$
BEGIN
 BEGIN
   PERFORM 1 FROM public.product_service_credentials;
   RAISE EXCEPTION 'Authenticated users must not read service credentials';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
   PERFORM 1 FROM public.product_service_nonces;
   RAISE EXCEPTION 'Authenticated users must not read service nonces';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $lb01credentialisolation$;
RESET ROLE;


-- LB-01.04: pending-state authentication, property authorization and encrypted handoff consumption.
SET ROLE authenticated;
SELECT set_config('request.test_user_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',false);
SELECT set_config('request.test_role','authenticated',false);
DO $lb01pending$
DECLARE _credential uuid; _connection uuid;
BEGIN
  SELECT id INTO _connection FROM public.staynas_product_connections
    WHERE correlation_id='lb01-test-reauthorization';
  IF _connection IS NULL OR NOT public.lb01_can_manage_product_connection(_connection) THEN
    RAISE EXCEPTION 'Authorized property owner must manage pending LB-01 connection';
  END IF;
  _credential := public.lb01_issue_product_service_credential(
    _connection,'abcdef0123456789abcdef04',decode(repeat('dd',32),'hex'),now()+interval '1 day'
  );
  IF _credential IS NULL THEN RAISE EXCEPTION 'Pending connection credential issuance failed'; END IF;
  INSERT INTO lb01_test_credential_ids(label, credential_id) VALUES ('pending', _credential);
END $lb01pending$;
RESET ROLE;

SET ROLE service_role;
SELECT set_config('request.test_role','service_role',false);
INSERT INTO public.lb01_credential_handoffs(
  connection_id, credential_id, peer_product, correlation_id, code_hash,
  encrypted_token, encryption_iv, encryption_tag, expires_at, created_by
)
SELECT c.id, p.id, 'staynas', c.correlation_id,
  decode(repeat('aa',32),'hex'), decode(repeat('cc',64),'hex'),
  decode(repeat('bb',12),'hex'), decode(repeat('ee',16),'hex'),
  now()+interval '10 minutes', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
FROM public.staynas_product_connections c
JOIN lb01_test_credential_ids i ON i.label='pending'
JOIN public.product_service_credentials p ON p.id=i.credential_id
WHERE c.correlation_id='lb01-test-reauthorization';
DO $lb01handoff$
DECLARE _first integer; _retry integer; _expired integer; _nonce boolean;
BEGIN
  _nonce := public.lb01_claim_service_nonce(
    (SELECT credential_id FROM lb01_test_credential_ids WHERE label='pending'),
    'pending-connection-nonce-00000001', now()+interval '5 minutes'
  );
  IF NOT _nonce THEN
    RAISE EXCEPTION 'Pending connection nonce diagnostic: role=%, uid=%, credential_id=%, credential_status=%, credential_expiry=%, connection_status=%',
      current_user, current_setting('request.test_role', true),
      (SELECT credential_id FROM lb01_test_credential_ids WHERE label='pending'),
      (SELECT status FROM public.product_service_credentials WHERE id=(SELECT credential_id FROM lb01_test_credential_ids WHERE label='pending')),
      (SELECT expires_at FROM public.product_service_credentials WHERE id=(SELECT credential_id FROM lb01_test_credential_ids WHERE label='pending')),
      (SELECT c.status FROM public.staynas_product_connections c
       JOIN public.product_service_credentials p ON p.connection_id=c.id
       WHERE p.id=(SELECT credential_id FROM lb01_test_credential_ids WHERE label='pending'));
  END IF;

  SELECT count(*) INTO _first FROM public.lb01_consume_credential_handoff(
    decode(repeat('aa',32),'hex'),'staynas','lb01-test-reauthorization'
  );
  SELECT count(*) INTO _retry FROM public.lb01_consume_credential_handoff(
    decode(repeat('aa',32),'hex'),'staynas','lb01-test-reauthorization'
  );
  IF _first <> 1 OR _retry <> 1 THEN
    RAISE EXCEPTION 'Handoff exchange must be safely repeatable after a lost response';
  END IF;
  UPDATE public.lb01_credential_handoffs
    SET consumed_at = now()-interval '3 minutes'
    WHERE code_hash=decode(repeat('aa',32),'hex');
  SELECT count(*) INTO _expired FROM public.lb01_consume_credential_handoff(
    decode(repeat('aa',32),'hex'),'staynas','lb01-test-reauthorization'
  );
  IF _expired <> 0 THEN RAISE EXCEPTION 'Consumed handoff must expire outside recovery window'; END IF;
  IF public.lb01_purge_expired_handoffs(100) < 1 THEN RAISE EXCEPTION 'Expired LB-01 handoff ciphertext was not purged'; END IF;
END $lb01handoff$;
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('request.test_user_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',false);
DO $lb01adminisolation$
BEGIN
  IF public.lb01_can_manage_product_connection(
    (SELECT id FROM public.staynas_product_connections WHERE correlation_id='lb01-test-reauthorization')
  ) THEN
    RAISE EXCEPTION 'Other property administrator must not manage this connection';
  END IF;
  BEGIN
    PERFORM 1 FROM public.lb01_credential_handoffs;
    RAISE EXCEPTION 'Authenticated users must not read credential handoffs';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.lb01_peer_credentials;
    RAISE EXCEPTION 'Authenticated users must not read encrypted peer credentials';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $lb01adminisolation$;
RESET ROLE;

-- Revocation must erase both stored peer-token ciphertext and unused handoff ciphertext.
SET ROLE service_role;
SELECT set_config('request.test_role','service_role',false);
INSERT INTO public.lb01_peer_credentials(
  connection_id, peer_product, credential_prefix, encrypted_token,
  encryption_iv, encryption_tag, status, imported_by
)
SELECT c.id, 'staynas', 'fedcba9876543210fedcba98',
  decode(repeat('cc',64),'hex'), decode(repeat('bb',12),'hex'),
  decode(repeat('ee',16),'hex'), 'active',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
FROM public.staynas_product_connections c
WHERE c.correlation_id='lb01-test-reauthorization';
INSERT INTO public.lb01_credential_handoffs(
  connection_id, credential_id, peer_product, correlation_id, code_hash,
  encrypted_token, encryption_iv, encryption_tag, expires_at, created_by
)
SELECT c.id, p.id, 'staynas', c.correlation_id,
  decode(repeat('bb',32),'hex'), decode(repeat('cc',64),'hex'),
  decode(repeat('bb',12),'hex'), decode(repeat('ee',16),'hex'),
  now()+interval '10 minutes', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
FROM public.staynas_product_connections c
JOIN public.product_service_credentials p ON p.connection_id=c.id
WHERE c.correlation_id='lb01-test-reauthorization'
  AND p.credential_prefix='abcdef0123456789abcdef04';
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('request.test_user_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',false);
SELECT set_config('request.test_role','authenticated',false);
SELECT public.lexibite_set_staynas_connection_state(
  (SELECT id FROM public.staynas_product_connections WHERE correlation_id='lb01-test-reauthorization'),
  'revoke',
  'LB-01 isolated revocation test'
);
RESET ROLE;

SET ROLE service_role;
SELECT set_config('request.test_role','service_role',false);
DO $lb01revocation$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lb01_peer_credentials
    WHERE credential_prefix='fedcba9876543210fedcba98'
      AND status='revoked' AND octet_length(encrypted_token)=0
  ) THEN
    RAISE EXCEPTION 'Connection revocation must erase encrypted peer credentials';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.lb01_credential_handoffs
    WHERE code_hash=decode(repeat('bb',32),'hex')
      AND consumed_at IS NOT NULL AND octet_length(encrypted_token)=0
  ) THEN
    RAISE EXCEPTION 'Connection revocation must erase encrypted handoff material';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.product_service_credentials
    WHERE credential_prefix='abcdef0123456789abcdef04' AND status='active'
  ) THEN
    RAISE EXCEPTION 'Connection revocation must invalidate issued service credentials';
  END IF;
END $lb01revocation$;
RESET ROLE;


-- LB-01R: tenant/property and outlet/property pairings are enforced for privileged writes.
SET ROLE service_role;
DO $lb01r_tenant_pair$
BEGIN
  BEGIN
    INSERT INTO public.staynas_product_connections(
      integration_tenant_id,integration_property_id,local_tenant_id,local_property_id,
      remote_tenant_id,remote_property_id,requested_by,correlation_id
    ) VALUES (
      '30000000-0000-4000-8000-000000000099','40000000-0000-4000-8000-000000000099',
      '10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000099','60000000-0000-4000-8000-000000000099',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','lb01r-tenant-mismatch'
    );
    RAISE EXCEPTION 'LB-01R expected mismatched tenant/property mapping to fail';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.restaurant_locations(id,tenant_id,property_id,slug)
    VALUES ('70000000-0000-4000-8000-000000000099',
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001','outlet-wrong-tenant');
    RAISE EXCEPTION 'LB-01R expected mismatched outlet tenant/property insert to fail';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $lb01r_tenant_pair$;
RESET ROLE;
