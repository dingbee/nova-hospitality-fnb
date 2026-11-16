-- Recovered hosted-runtime prerequisite for the LB-02 outbox dispatcher.
-- Applied: 2026-11-12 (version 20261112064645).
-- Local installer neutralises pg_cron/pg_net CREATE EXTENSION statements;
-- the extensions are platform-managed in Supabase hosted environments.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
