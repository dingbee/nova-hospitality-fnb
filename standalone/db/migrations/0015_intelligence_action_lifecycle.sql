-- Intelligence Core — Act/Verify lifecycle (P10).
--
-- decisions/actions.server.ts (I4) only ever wrote 'executing' -> 'completed'
-- | 'failed'. P10 makes execution genuinely stateful (approved -> queued ->
-- executing -> executed -> verified, with queued/executing -> failed and
-- executed -> verification_failed) and adds a real verifier. The status
-- values that lifecycle needs ('queued', 'executed', 'verified',
-- 'verification_failed') are not in the CHECK constraint 0011 defined, so
-- this widens it. 'completed' and 'cancelled' are kept for backward
-- compatibility with rows already written under the old vocabulary (e.g.
-- O9's UAT action, which is 'completed') — executeRestaurantAction/
-- verifyRestaurantAction treat 'completed' as a synonym for 'executed'.
alter table public.intelligence_actions drop constraint intelligence_actions_status_check;
alter table public.intelligence_actions add constraint intelligence_actions_status_check
  check (status in (
    'proposed', 'approved', 'queued', 'executing', 'executed', 'verified',
    'failed', 'verification_failed', 'completed', 'cancelled'
  ));
