-- =====================================================================
-- MRKLL Studios — Booking system, migration 2 (Phase 2.2)
-- Days fully covered by a closure (public holiday, blackout) are
-- reported as 'closed' instead of 'unavailable', so the calendar can tell
-- "studio closed" apart from "fully booked".
-- Run after 20261110000000_booking_system.sql. Safe to re-run.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.package_slots(text, date, date)') is null then
    raise exception 'Run migration 20261110000000_booking_system.sql first.';
  end if;
end $$;

create or replace function public.get_availability(p_package_id text, p_from date, p_to date)
returns table (day date, status text, slots jsonb)
language plpgsql stable set search_path = public as $$
declare
  v_s public.studio_settings;
  v_today date;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'INVALID_RANGE' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.packages where id = p_package_id and active) then
    raise exception 'PACKAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  select * into v_s from public.studio_settings;
  v_today := (now() at time zone v_s.timezone)::date;

  return query
  with days as (select p_from + i as d from generate_series(0, p_to - p_from) i),
  sl as (
    select ps.*,
           exists (select 1 from public.blackout_periods bp
                   where bp.period && tstzrange(ps.starts_at, ps.ends_at, '[)')) as in_closure
    from public.package_slots(p_package_id, p_from, p_to) ps
  ),
  per_day as (
    select d.d,
           case
             when d.d < v_today then 'past'
             when d.d > v_today + v_s.max_advance_days then 'out_of_range'
             when not exists (select 1 from sl where sl.slot_date = d.d)
               or not exists (select 1 from sl where sl.slot_date = d.d and not sl.in_closure) then 'closed'
             when exists (select 1 from sl where sl.slot_date = d.d and sl.available) then 'available'
             else 'unavailable'
           end as st
    from days d
  )
  select pd.d,
         pd.st,
         case
           when pd.st in ('past', 'out_of_range', 'closed') then '[]'::jsonb
           else coalesce((
             select jsonb_agg(jsonb_build_object(
                      'start', to_char(sl.start_time, 'HH24:MI'),
                      'end',   to_char(sl.end_time,   'HH24:MI'),
                      'available', sl.available)
                    order by sl.start_time)
             from sl where sl.slot_date = pd.d), '[]'::jsonb)
         end
  from per_day pd
  order by pd.d;
end $$;

-- CREATE OR REPLACE keeps existing privileges; re-assert them anyway.
revoke all on function public.get_availability(text, date, date) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_availability(text, date, date) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_availability(text, date, date) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_availability(text, date, date) to service_role;
  end if;
end $$;

commit;
