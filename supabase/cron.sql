-- =====================================================================
-- MRKLL Studios — Scheduled jobs (Phase 2.1)
-- Requires the pg_cron extension: Dashboard → Database → Extensions → pg_cron.
-- Run AFTER the migration. Safe to re-run (jobs are replaced by name).
-- =====================================================================

-- Safety net: release holds whose time is up, even if a Stripe
-- "checkout.session.expired" webhook never arrives.
select cron.schedule(
  'mrkll-expire-stale-holds',
  '*/5 * * * *',
  $$select public.expire_stale_holds()$$
);

-- GDPR: remove technical identifiers from abandoned holds after 30 days.
select cron.schedule(
  'mrkll-purge-stale-hold-data',
  '17 3 * * *',
  $$select public.purge_stale_hold_data(interval '30 days')$$
);
