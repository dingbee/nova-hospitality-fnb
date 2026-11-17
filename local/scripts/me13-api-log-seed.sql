-- ME-13: synthetic api_request_log volume to measure the P08 rate-limiter's
-- COUNT-based sliding window (audit.server.ts) at realistic scale. LOCAL ONLY.
set search_path = public;
DO $seed$
DECLARE
  t_id uuid := '11111111-1111-4111-8111-111111111111';
  cred uuid;
BEGIN
  INSERT INTO api_credentials (id, tenant_id, property_id, service_user_id, label, key_prefix, key_hash, scopes, status, created_by)
  VALUES (gen_random_uuid(), t_id, NULL, '99999999-9999-4999-8999-999999999999', 'ME-13 load test', 'me13_test_', 'x', ARRAY['orders:read'], 'active', '99999999-9999-4999-8999-999999999999')
  RETURNING id INTO cred;
  INSERT INTO api_request_log (id, request_id, tenant_id, property_id, credential_id, method, endpoint, status_code, duration_ms, ip, created_at)
  SELECT gen_random_uuid(), 'req-' || g, t_id, NULL, cred,
    'GET', '/v1/orders', 200, 10 + (g % 50),
    '10.0.' || (g % 200) || '.' || (g % 250),
    now() - (g || ' seconds')::interval
  FROM generate_series(1, 400000) g
  ON CONFLICT DO NOTHING;
  RAISE NOTICE 'api_request_log rows: %', (SELECT count(*) FROM api_request_log);
END
$seed$;
