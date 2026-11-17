-- Correction: 0067 part1 (hand-transcription) erroneously dropped the sole
-- policy on commercial_payment_webhook_events, a table that was NOT part of
-- the 104-table read+write(ALL) consolidation set (it has only one SELECT
-- policy, no counterpart to merge). Restoring it verbatim, immediately.
CREATE POLICY "webhook events readable by commercial admins" ON public.commercial_payment_webhook_events FOR SELECT TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())));
