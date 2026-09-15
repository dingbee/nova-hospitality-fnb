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
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS file_size_limit bigint;
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS allowed_mime_types text[];

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

-- ---------------------------------------------------------------------------
-- migration_transfer_audit.
--
-- Per migration 0048's own comment, this is a one-time internal migration
-- bookkeeping table created directly on the hosted project during a prior
-- platform transfer (5 historical rows, zero application-code references) —
-- it was never created by a versioned migration, so it does not exist on a
-- fresh local install. Migration 0048 (correctly) tightens RLS/grants on it.
-- Stubbed here, inert and empty, purely so that migration applies cleanly;
-- no application code reads or writes this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.migration_transfer_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Cash payout / daily close / tender declaration / giveaway workflow
-- functions.
--
-- ME-03 discovery: migration 0048_p11_security_hardening.sql revokes/grants
-- EXECUTE on 18 functions (restaurant_apply_giveaway, restaurant_cash_payout_*,
-- restaurant_daily_close_*, restaurant_day_is_locked, restaurant_decide_giveaway,
-- restaurant_declaration_revisions_immutable, restaurant_giveaway_*,
-- restaurant_request_giveaway, restaurant_reverse_giveaway,
-- restaurant_tender_declaration_*) that are DEFINED BY NO MIGRATION anywhere
-- in this repository (confirmed by grep across standalone/db/migrations/ —
-- zero CREATE FUNCTION for any of them outside 0048's own REVOKE/GRANT
-- lines). These clearly implement a real subsystem (cash payout control,
-- daily close, tender declarations, giveaway approval) that exists in
-- production but was never captured by a versioned migration — the same
-- class of drift ME-00-D(ii) found and reconciled for 10 other objects, not
-- yet reconciled for this set. This is recorded as an ME-03 finding (see the
-- ME-03 evidence document); it is NOT reconstructed here, because this
-- session has no access to production's migration ledger to recover the
-- real implementation, and fabricating financial-control logic (payout
-- approval, giveaway authorization) from guesswork is exactly what CLAUDE.md
-- prohibits ("NO GUESSING").
--
-- These are inert local-only stubs whose only purpose is to let migration
-- 0048's REVOKE/GRANT statements resolve against a real function signature
-- so the rest of the migration sequence can be applied and tested locally.
-- They are deliberately NOT behaviorally equivalent to whatever production
-- runs, must never be treated as evidence of correct cash-payout/giveaway
-- behaviour, and are out of ME-03's certified scope for that reason.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_cash_payout_control' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_cash_payout_control() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_cash_payout_events_immutable' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_cash_payout_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_cash_payout_no_delete' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_cash_payout_no_delete() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN OLD; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_cash_payout_trail' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_cash_payout_trail() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_daily_close_control' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_daily_close_control() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_daily_close_payout_sync' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_daily_close_payout_sync() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_declaration_revisions_immutable' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_declaration_revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_giveaway_guard' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_giveaway_guard() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_giveaway_no_delete' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_giveaway_no_delete() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN OLD; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_giveaway_period_lock' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_giveaway_period_lock() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_tender_declaration_archive' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_tender_declaration_archive() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_tender_declaration_control' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_tender_declaration_control() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_cash_payout_total' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_cash_payout_total(uuid, uuid, date) RETURNS numeric LANGUAGE sql AS $f$ SELECT 0::numeric; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_day_is_locked' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_day_is_locked(uuid, uuid, date) RETURNS boolean LANGUAGE sql AS $f$ SELECT false; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_apply_giveaway' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_apply_giveaway(uuid) RETURNS void LANGUAGE sql AS $f$ SELECT NULL::void; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_decide_giveaway' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_decide_giveaway(uuid, uuid, boolean, text) RETURNS void LANGUAGE sql AS $f$ SELECT NULL::void; $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_request_giveaway' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_request_giveaway(uuid, uuid, uuid, text, uuid, text, numeric, text, text) RETURNS uuid LANGUAGE sql AS $f$ SELECT gen_random_uuid(); $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restaurant_reverse_giveaway' AND pronamespace = 'public'::regnamespace) THEN
    CREATE FUNCTION public.restaurant_reverse_giveaway(uuid, uuid, text, text) RETURNS void LANGUAGE sql AS $f$ SELECT NULL::void; $f$;
  END IF;
END
$$;