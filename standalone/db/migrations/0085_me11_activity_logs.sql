-- ME-11 enterprise governance certification — activity_logs table.
--
-- src/lib/activity-log.server.ts's logActivity() has written to a table
-- named "activity_logs" since it was introduced (called from
-- inviteStaffUser/assignRole/revokeRole in staff.functions.ts) — but no
-- migration, on any branch, has ever created that table. Every one of those
-- calls has always failed at the database ("relation activity_logs does not
-- exist") and been silently swallowed by logActivity's own try/catch
-- ("Don't fail the primary action if logging fails"), so every "audit
-- record" this codebase believed it was writing for staff invites and
-- platform-tier role grants/revocations was never persisted. Confirmed live
-- against a from-scratch replay of this migration chain during ME-11
-- certification (docs/me-11/ME-11-enterprise-governance-certification.md).
--
-- The live P09 delegated-administration surface — upsertMember/removeMember
-- in restaurant/core/members.server.ts, the actual mechanism by which an
-- owner/general_manager grants or revokes a role at a tenant or property —
-- had no audit call at all, broken or otherwise. This migration creates the
-- table logActivity already assumes exists, and a companion code change
-- wires members.server.ts's grant/revoke into it, closing Phase 8
-- (Auditability) for enterprise/property governance's actual privileged
-- action: changing who holds what role, where.
--
-- Design mirrors this codebase's existing "documents.audit.read" capability
-- (restaurant/core/permissions.ts) — a tenant-wide-only audit-trail
-- visibility, not property-scoped — rather than inventing a new
-- authorization concept: a governance-action log entry names a tenant, and
-- reading it back requires the same tenant-senior roles that capability
-- already reserves for "who took a sensitive action, when."
--
-- tenant_id is nullable because a platform-tier action (a staff invite,
-- a platform-wide role grant with no tenant) has no tenant to attribute the
-- row to; such rows are visible only to platform admins, never broadened to
-- "any tenant member" by omission.

CREATE TABLE IF NOT EXISTS public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  actor_email text NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NULL,
  entity_label text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_value jsonb NULL,
  new_value jsonb NULL,
  ip_address text NULL,
  user_agent text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_created ON public.activity_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_actor ON public.activity_logs (actor_id, created_at DESC);

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.activity_logs TO authenticated;
GRANT ALL ON public.activity_logs TO service_role;

-- INSERT: any authenticated caller may append a row, but only ever
-- attributed to themselves — nobody can forge another user's actor_id.
-- Application code decides what "action"/tenant_id mean; RLS's only job
-- here is that boundary (same "server correctness is not enough, RLS is
-- the backstop" discipline as every other write path in this schema).
DROP POLICY IF EXISTS "activity logs insert own" ON public.activity_logs;
CREATE POLICY "activity logs insert own" ON public.activity_logs FOR INSERT TO authenticated
  WITH CHECK (actor_id = auth.uid());

-- SELECT: platform admins see every row (including platform-tier,
-- tenant_id IS NULL rows). A tenant-scoped row is visible to the same
-- tenant-senior roles documents.audit.read already reserves for this class
-- of trail — never merely "any tenant member" (this is a governance/
-- privilege-change history, not the shared staff roster members read
-- already exposes to everyone).
DROP POLICY IF EXISTS "activity logs read scoped" ON public.activity_logs;
CREATE POLICY "activity logs read scoped" ON public.activity_logs FOR SELECT TO authenticated
  USING (
    public.restaurant_is_platform_admin(auth.uid())
    OR (
      tenant_id IS NOT NULL
      AND public.restaurant_can_write_scoped(
        tenant_id,
        ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],
        NULL
      )
    )
  );
