-- =====================================================================
-- MRKLL Studios — Scheduled jobs
-- Requires the pg_cron extension (Dashboard → Integrations → Cron, or
-- Database → Extensions → pg_cron). Run AFTER the migrations, seed and
-- holidays. Safe to re-run: jobs are replaced by name, never duplicated.
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not enabled: Dashboard -> Integrations -> Cron (or Database -> Extensions -> pg_cron), then run this file again.';
  end if;
  if to_regprocedure('public.expire_stale_holds()') is null then
    raise exception 'Run the migrations before cron.sql.';
  end if;
end $$;

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
