-- =====================================================================
-- MRKLL Studios — Staging verification (READ-ONLY: changes nothing)
-- Run in the SQL Editor after the whole setup (cron.sql included: the
-- query reads cron.job). One row per check; every row must say OK.
-- Single statement, so the SQL Editor shows all results.
-- =====================================================================

with
expected_tables(t) as (
  values ('studio_settings'), ('opening_hours'), ('packages'), ('package_start_times'), ('blackout_periods'),
         ('bookings'), ('stripe_events'), ('payment_refunds'), ('email_notifications')
),
expected_functions(f) as (
  values ('public.slot_is_free(timestamptz, timestamptz, timestamptz)'),
         ('public.package_slots(text, date, date)'),
         ('public.get_availability(text, date, date)'),
         ('public.create_booking_hold(text, date, time, text, text)'),
         ('public.attach_checkout_session(uuid, text)'),
         ('public.confirm_booking(uuid, text, text, int, text, text, text, text)'),
         ('public.release_hold(uuid, text, text, text)'),
         ('public.mark_booking_refunded(text)'),
         ('public.mark_booking_email_sent(uuid, text)'),
         ('public.expire_stale_holds()'),
         ('public.purge_stale_hold_data(interval)'),
         ('public.begin_stripe_event(text, text, uuid)'),
         ('public.finish_stripe_event(text)'),
         ('public.record_refund(text, text, int, int)'),
         ('public.get_booking_details(uuid)'),
         ('public.claim_notification(text, uuid, text, int)'),
         ('public.complete_notification(text, text, text, text)')
),
checks(n, check_name, ok, detail) as (
  -- 1. schema
  select 1, 'tables: all 9 exist',
         (select count(*) from expected_tables where to_regclass('public.' || t) is not null) = 9,
         (select string_agg(t, ', ') from expected_tables where to_regclass('public.' || t) is null)
  union all
  select 2, 'functions: all 17 exist',
         (select count(*) from expected_functions where to_regprocedure(f) is not null) = 17,
         (select string_agg(f, ', ') from expected_functions where to_regprocedure(f) is null)
  union all
  select 3, 'overlap rule: bookings_no_overlap constraint',
         exists (select 1 from pg_constraint where conname = 'bookings_no_overlap' and contype = 'x'), null
  union all
  select 4, 'migration 3 applied (bookings.conflict_at)',
         exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name = 'conflict_at'), null
  -- 2. security
  union all
  select 5, 'RLS enabled on every table',
         (select bool_and(c.relrowsecurity) from expected_tables e join pg_class c on c.oid = to_regclass('public.' || e.t)),
         (select string_agg(e.t, ', ') from expected_tables e join pg_class c on c.oid = to_regclass('public.' || e.t) where not c.relrowsecurity)
  union all
  select 6, 'no RLS policy (nothing readable with a public key)',
         not exists (select 1 from pg_policies p join expected_tables e on p.schemaname = 'public' and p.tablename = e.t), null
  union all
  select 7, 'anon / authenticated: no access to tables or view',
         not exists (
           select 1 from (select 'public.' || t as obj from expected_tables union all select 'public.bookings_calendar') o
           cross join (values ('anon'), ('authenticated')) r(role)
           cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
           where has_table_privilege(r.role, o.obj, p.priv)),
         null
  union all
  select 8, 'anon / authenticated: cannot execute booking functions',
         not exists (
           select 1 from expected_functions cross join (values ('anon'), ('authenticated')) r(role)
           where to_regprocedure(f) is not null and has_function_privilege(r.role, f, 'EXECUTE')),
         (select string_agg(f, ', ') from expected_functions
          where to_regprocedure(f) is not null and (has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE')))
  union all
  select 9, 'service_role: full access to tables',
         not exists (
           select 1 from expected_tables cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
           where to_regclass('public.' || t) is not null and not has_table_privilege('service_role', 'public.' || t, p.priv)),
         null
  union all
  select 10, 'service_role: can execute booking functions',
         not exists (select 1 from expected_functions where to_regprocedure(f) is not null and not has_function_privilege('service_role', f, 'EXECUTE')),
         null
  union all
  select 11, 'view bookings_calendar runs with caller rights',
         coalesce((select 'security_invoker=true' = any(reloptions) from pg_class where oid = to_regclass('public.bookings_calendar')), false), null
  -- 3. data
  union all
  select 12, 'settings: Europe/Madrid, buffer 30, notice 24h, 90 days, hold 35, checkout 30',
         exists (select 1 from public.studio_settings where timezone = 'Europe/Madrid' and buffer_minutes = 30 and min_notice_hours = 24
                 and max_advance_days = 90 and hold_minutes = 35 and checkout_expiry_minutes = 30),
         null
  union all
  select 13, 'opening hours: Mon-Sat 10:00-22:00, Sunday closed',
         (select count(*) from public.opening_hours where weekday between 1 and 6 and opens_at = '10:00' and closes_at = '22:00') = 6
         and not exists (select 1 from public.opening_hours where weekday = 7), null
  union all
  select 14, 'packages: Starter 2h/120, Pro 4h/200, Legend 6h/280 (EUR)',
         (select string_agg(id || ':' || duration_minutes || ':' || price_cents || ':' || currency, ',' order by sort_order) from public.packages where active)
           = 'starter:120:12000:eur,pro:240:20000:eur,legend:360:28000:eur',
         (select string_agg(id || ':' || duration_minutes || ':' || price_cents, ',' order by sort_order) from public.packages)
  union all
  select 15, 'start times: 5 / 4 / 3 on the 2h30 grid',
         (select string_agg(package_id || '=' || n, ',' order by package_id) from
            (select package_id, count(*) n from public.package_start_times group by package_id) x) = 'legend=3,pro=4,starter=5',
         null
  union all
  select 16, 'public holidays loaded (17)',
         (select count(*) from public.blackout_periods where reason like 'Festiu %') = 17,
         (select count(*)::text || ' found' from public.blackout_periods where reason like 'Festiu %')
  union all
  select 17, 'availability works (14 days for Pro)',
         (select count(*) from public.get_availability('pro', current_date, current_date + 13)) = 14, null
  union all
  select 18, 'no bookings yet (clean staging)',
         not exists (select 1 from public.bookings), (select count(*)::text || ' bookings' from public.bookings)
  -- 4. scheduled jobs
  union all
  select 19, 'pg_cron enabled',
         exists (select 1 from pg_extension where extname = 'pg_cron'), null
  union all
  select 20, 'cron jobs scheduled (2)',
         (select count(*) from cron.job
          where jobname in ('mrkll-expire-stale-holds', 'mrkll-purge-stale-hold-data') and active) = 2,
         null
)
select n as "#", check_name as "check", case when ok then 'OK' else 'FAIL' end as result, detail
from checks
union all
select 99, '=== SUMMARY ===',
       case when (select bool_and(coalesce(ok, false)) from checks) then 'ALL OK' else 'SOME CHECKS FAILED' end, null
order by 1;
