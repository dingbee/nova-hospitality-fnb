-- NOVA Hospitality — Restaurant & Bar OS
-- Local runtime: Supabase platform compatibility stubs.
--
-- PRODUCTIZATION-2 established that the Restaurant & Bar product does not
-- depend on Storage, Realtime, Edge Functions, pgmq, pg_net, vault or
-- pg_cron. A handful of *legacy hospitality* migrations in the shared history
-- still reference them. Because the migration history is authoritative and
-- must not be rewritten, the local runtime provides inert stubs so the same
-- migrations apply cleanly against vanilla PostgreSQL 16/17.
--
-- These stubs are deliberately no-ops: nothing in the Restaurant & Bar
-- surface calls them, and a local install must never silently gain
-- outbound-network or scheduler behaviour.

-- ---------- storage (object metadata only; no object server locally) ----------
CREATE SCHEMA IF NOT EXISTS storage;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id) ON DELETE CASCADE,
  name text,
  owner uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
GRANT ALL ON storage.objects, storage.buckets TO service_role;

CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT string_to_array(name, '/');
$$;

-- ---------- net (outbound HTTP) — intentionally inert ----------
CREATE SCHEMA IF NOT EXISTS net;
CREATE OR REPLACE FUNCTION net.http_post(
  url text,
  body jsonb DEFAULT '{}'::jsonb,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint
LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'net.http_post is disabled in the NOVA local runtime (url=%)', url;
  RETURN 0;
END;
$$;
REVOKE ALL ON FUNCTION net.http_post(text, jsonb, jsonb, jsonb, integer) FROM PUBLIC;

-- ---------- vault — local runtime keeps secrets in the process env ----------
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE,
  description text DEFAULT '',
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON vault.secrets FROM PUBLIC;

CREATE OR REPLACE FUNCTION vault.create_secret(
  new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT ''
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE new_id uuid;
BEGIN
  INSERT INTO vault.secrets(name, description, secret)
  VALUES (new_name, new_description, new_secret)
  ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret, updated_at = now()
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION vault.update_secret(
  secret_id uuid, new_secret text DEFAULT NULL, new_name text DEFAULT NULL,
  new_description text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE vault.secrets SET
    secret = COALESCE(new_secret, secret),
    name = COALESCE(new_name, name),
    description = COALESCE(new_description, description),
    updated_at = now()
  WHERE id = secret_id;
END;
$$;
REVOKE ALL ON FUNCTION vault.create_secret(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION vault.update_secret(uuid, text, text, text) FROM PUBLIC;

-- ---------- cron — no scheduler in the local appliance ----------
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (
  jobid bigserial PRIMARY KEY,
  jobname text UNIQUE,
  schedule text,
  command text,
  active boolean NOT NULL DEFAULT true
);

CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE new_id bigint;
BEGIN
  INSERT INTO cron.job(jobname, schedule, command, active)
  VALUES (job_name, schedule, command, false)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid INTO new_id;
  RAISE NOTICE 'cron.schedule recorded but inactive in the NOVA local runtime (%).', job_name;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION cron.unschedule(job_name text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job WHERE jobname = job_name;
  RETURN true;
END;
$$;

-- ---------- pgmq — queue stubs (Restaurant & Bar does not enqueue) ----------
CREATE SCHEMA IF NOT EXISTS pgmq;
CREATE TABLE IF NOT EXISTS pgmq.meta (
  queue_name text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pgmq.messages (
  msg_id bigserial PRIMARY KEY,
  queue_name text NOT NULL,
  message jsonb NOT NULL,
  read_ct integer NOT NULL DEFAULT 0,
  vt timestamptz NOT NULL DEFAULT now(),
  enqueued_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION pgmq.create(queue_name text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO pgmq.meta(queue_name) VALUES (queue_name) ON CONFLICT DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION pgmq.send(queue_name text, msg jsonb, delay integer DEFAULT 0)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE new_id bigint;
BEGIN
  INSERT INTO pgmq.meta(queue_name) VALUES (queue_name) ON CONFLICT DO NOTHING;
  INSERT INTO pgmq.messages(queue_name, message, vt)
  VALUES (queue_name, msg, now() + make_interval(secs => delay))
  RETURNING msg_id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq.read(queue_name text, vt integer, qty integer)
RETURNS TABLE (msg_id bigint, read_ct integer, enqueued_at timestamptz, vt_out timestamptz, message jsonb)
LANGUAGE sql AS $$
  SELECT m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
  FROM pgmq.messages m
  WHERE m.queue_name = read.queue_name AND m.vt <= now()
  ORDER BY m.msg_id
  LIMIT qty;
$$;

CREATE OR REPLACE FUNCTION pgmq.delete(queue_name text, msg_id bigint)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pgmq.messages m WHERE m.queue_name = delete.queue_name AND m.msg_id = delete.msg_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq.archive(queue_name text, msg_id bigint)
RETURNS boolean LANGUAGE sql AS $$
  SELECT pgmq.delete(queue_name, msg_id);
$$;

GRANT USAGE ON SCHEMA pgmq, cron, net TO service_role;

-- ---------------------------------------------------------------------------
-- Hosted-only email dispatch functions.
--
-- On the hosted runtime these are created by the WAN email pipeline (pg_net +
-- pg_cron) outside the migration history, but later migrations REVOKE on them.
-- Locally they exist as inert stubs so the authoritative migrations apply
-- unchanged; outbound email is a WAN-only capability and stays disabled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.email_queue_wake()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_queue_dispatch()
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE NOTICE '[nova-local] email dispatch is a WAN capability and is disabled on the local runtime';
END;
$$;

-- ---------------------------------------------------------------------------
-- Realtime publication.
--
-- Migrations add tables to the `supabase_realtime` publication. Postgres
-- logical replication publications are native, so this is created for real —
-- it is simply unused until a local change-feed consumer subscribes.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$$;