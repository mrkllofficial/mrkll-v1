-- =====================================================================
-- MRKLL Studios — Setup status (READ-ONLY: changes nothing)
-- Shows which setup steps are applied and whether security is intact.
-- Run it any time AFTER migration 1 (it reads the booking tables).
-- =====================================================================

with
m1_tables(t) as (
  values ('studio_settings'), ('opening_hours'), ('packages'), ('package_start_times'),
         ('blackout_periods'), ('bookings'), ('stripe_events')
),
m1_functions(f) as (
  values ('public.touch_updated_at()'), ('public.new_booking_reference()'), ('public.bookings_fill_defaults()'),
         ('public.slot_is_free(timestamptz, timestamptz, timestamptz)'), ('public.package_slots(text, date, date)'),
         ('public.get_availability(text, date, date)'), ('public.create_booking_hold(text, date, time, text, text)'),
         ('public.attach_checkout_session(uuid, text)'), ('public.confirm_booking(uuid, text, text, int, text, text, text, text)'),
         ('public.release_hold(uuid, text, text, text)'), ('public.mark_booking_refunded(text)'),
         ('public.mark_booking_email_sent(uuid, text)'), ('public.expire_stale_holds()'), ('public.purge_stale_hold_data(interval)')
),
rows(n, step, status, detail) as (
  select 1, 'migration 1: tables (7)',
         case (select count(*) from m1_tables where to_regclass('public.' || t) is not null)
              when 7 then 'APPLIED' when 0 then 'NOT APPLIED' else 'INCOMPLETE' end,
         (select count(*)::text || '/7' from m1_tables where to_regclass('public.' || t) is not null)
  union all
  select 2, 'migration 1: functions (14)',
         case (select count(*) from m1_functions where to_regprocedure(f) is not null)
              when 14 then 'APPLIED' when 0 then 'NOT APPLIED' else 'INCOMPLETE' end,
         (select count(*)::text || '/14' from m1_functions where to_regprocedure(f) is not null)
  union all
  select 3, 'migration 1: overlap rule (bookings_no_overlap)',
         case when exists (select 1 from pg_constraint where conname = 'bookings_no_overlap' and contype = 'x')
              then 'APPLIED' else 'MISSING' end, null
  union all
  select 4, 'security: RLS on migration-1 tables',
         case when (select count(*) from m1_tables e join pg_class c on c.oid = to_regclass('public.' || e.t) where c.relrowsecurity) = 7
              then 'OK' else 'CHECK' end,
         (select count(*)::text || '/7 with RLS' from m1_tables e join pg_class c on c.oid = to_regclass('public.' || e.t) where c.relrowsecurity)
  union all
  select 5, 'security: anon/authenticated have no table access',
         case when exists (
           select 1 from m1_tables cross join (values ('anon'), ('authenticated')) r(role)
           cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
           where to_regclass('public.' || t) is not null and has_table_privilege(r.role, 'public.' || t, p.priv))
         then 'EXPOSED' else 'OK' end, null
  union all
  select 6, 'security: anon/authenticated cannot run functions',
         case when exists (
           select 1 from m1_functions cross join (values ('anon'), ('authenticated')) r(role)
           where to_regprocedure(f) is not null and has_function_privilege(r.role, f, 'EXECUTE'))
         then 'EXPOSED' else 'OK' end, null
  union all
  select 7, 'security: service_role can use tables and functions',
         case when exists (
                select 1 from m1_tables where to_regclass('public.' || t) is not null
                and not has_table_privilege('service_role', 'public.' || t, 'SELECT'))
              or exists (
                select 1 from m1_functions where to_regprocedure(f) is not null
                and f not in ('public.touch_updated_at()', 'public.bookings_fill_defaults()', 'public.new_booking_reference()')
                and not has_function_privilege('service_role', f, 'EXECUTE'))
         then 'MISSING' else 'OK' end, null
  union all
  select 8, 'migration 2: closed days in availability',
         case when to_regprocedure('public.get_availability(text, date, date)') is null then 'NOT APPLIED'
              when position('in_closure' in pg_get_functiondef(to_regprocedure('public.get_availability(text, date, date)'))) > 0
              then 'APPLIED' else 'NOT APPLIED' end, null
  union all
  select 9, 'migration 3: webhook tables',
         case when to_regclass('public.payment_refunds') is not null and to_regclass('public.email_notifications') is not null
              then 'APPLIED' else 'NOT APPLIED' end, null
  union all
  select 10, 'seed: settings / packages / start times',
         case when (select count(*) from public.studio_settings) = 1 and (select count(*) from public.packages) = 3
               and (select count(*) from public.package_start_times) = 12 then 'APPLIED' else 'NOT APPLIED' end,
         null
  union all
  select 11, 'holidays (17)',
         case when (select count(*) from public.blackout_periods where reason like 'Festiu %') = 17 then 'APPLIED'
              else 'NOT APPLIED' end,
         null
  union all
  select 12, 'pg_cron extension',
         case when exists (select 1 from pg_extension where extname = 'pg_cron') then 'ENABLED' else 'NOT ENABLED' end, null
  union all
  select 13, 'bookings stored',
         (select count(*) from public.bookings)::text,
         null
)
select n as "#", step, status, detail from rows order by n;
